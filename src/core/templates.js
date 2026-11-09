'use strict';
// Letter templates: where each value sits on a given kind of LOA. A person marks
// regions on a sample letter (Settings > Letter templates); every later letter of
// that kind is read from the same regions, on top of the text reader, so OCR and
// layout quirks stop hiding the device, approval number, dates or kernel.
//
// Positions are fractions of the page (0..1, top-left origin), relative to the
// letter's first page, so a template works on letters scanned at any size.

const { parseDate, findDates } = require('./dates');

/** The letter types tracked, in the order the person works through them. */
const L2_BRANDS = ['Visa', 'Mastercard', 'Amex', 'Discover', 'UnionPay', 'JCB', 'Interac'];
const LETTER_TYPES = [
  { key: 'pci', label: 'PCI PTS letter', category: 'PCI PTS' },
  { key: 'l1c', label: 'L1 Contact', category: 'EMV L1 Contact' },
  { key: 'l1c-tqm', label: 'L1 Contact TQM', category: 'TQM', iface: 'contact' },
  { key: 'l1cl', label: 'L1 Contactless', category: 'EMV L1 Contactless' },
  { key: 'l1cl-tqm', label: 'L1 Contactless TQM', category: 'TQM', iface: 'contactless' },
  ...L2_BRANDS.map((b) => ({ key: `l2cl-${b.toLowerCase()}`, label: `L2 Contactless ${b === 'UnionPay' ? 'UnionPay (UPI)' : b}`, category: 'EMV L2 Contactless', scheme: b })),
];

/** The values a region can hold. */
const FIELDS = [
  { key: 'device', label: 'Device / product list' },
  { key: 'approval', label: 'Approval / reference number' },
  { key: 'issued', label: 'Issue date' },
  { key: 'expires', label: 'Expiry date' },
  { key: 'kernel', label: 'Kernel version' },
];

/** The template key for a parsed letter, or '' when it is not one of the tracked types. */
function letterTypeOf(L) {
  if (!L || L.informational) return '';
  const c = L.category;
  if (c === 'PCI PTS') return 'pci';
  if (c === 'EMV L1 Contact') return 'l1c';
  if (c === 'EMV L1 Contactless') return 'l1cl';
  if (c === 'TQM') {
    const iface = [(L.products || [])[0] && L.products[0].interface, L.kernelVersion && L.kernelVersion.value].filter(Boolean).join(' ');
    return /pcd|contactless/i.test(iface) ? 'l1cl-tqm' : 'l1c-tqm';
  }
  if (c === 'EMV L2 Contactless') {
    const b = L2_BRANDS.find((x) => x.toLowerCase() === String(L.scheme || '').toLowerCase());
    return b ? `l2cl-${b.toLowerCase()}` : '';
  }
  return '';
}

/**
 * The text inside one region: words whose centre falls in it, read line by line.
 * words: [{ p: page index (0-based), x, y, w, h (fractions), t }]
 */
function regionText(words, region, pageOffset = 0) {
  const page = (region.page || 0) + pageOffset;
  const inside = (words || []).filter((w) => w.p === page
    && w.x + w.w / 2 >= region.x && w.x + w.w / 2 <= region.x + region.w
    && w.y + w.h / 2 >= region.y && w.y + w.h / 2 <= region.y + region.h);
  inside.sort((a, b) => a.y - b.y);
  const lines = [];
  for (const w of inside) {
    const line = lines.find((l) => Math.abs(l.y - w.y) <= Math.max(l.h, w.h) * 0.5);
    if (line) line.words.push(w); else lines.push({ y: w.y, h: w.h, words: [w] });
  }
  return lines.map((l) => l.words.sort((a, b) => a.x - b.x).map((w) => w.t).join(' ')).join('\n').replace(/[ \t]+/g, ' ').trim();
}

// Labels printed next to a value ("Expiration Date:", "Kernel Version") are not part of it.
const LABEL = /^(?:approval\s+)?(?:expiration|expiry|expires?|valid\s+(?:until|to)|issued?|issue\s+date|date\s+of\s+issue|kernel(?:\s+version)?|version|loa|approval|reference|ref\.?|number|no\.?|#|product(?:s)?|device(?:s)?|model(?:s)?|date)\b[\s:.#-]*/i;
const stripLabels = (s) => { let t = String(s || '').trim(); for (let i = 0; i < 4 && LABEL.test(t); i++) t = t.replace(LABEL, '').trim(); return t; };

/** Turn the text of a region into a value for its field, or null when nothing usable is there. */
function valueFor(field, text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (field === 'issued' || field === 'expires') {
    const d = findDates(t).sort((a, b) => a.index - b.index);
    return d.length ? (field === 'expires' ? d[d.length - 1] : d[0]).iso : parseDate(stripLabels(t));
  }
  if (field === 'device') {
    const list = stripLabels(t).split(/\s*(?:[,;\n]|\band\b)\s*/i).map((x) => x.trim()).filter((x) => x && /\d/.test(x) && x.length <= 40);
    return list.length ? list : null;
  }
  const v = stripLabels(t.replace(/\n/g, ' '));
  return v || null;
}

/**
 * Read a letter with its type's template, filling or correcting what the text reader found.
 * Returns the fields it set, or [] when no template applies.
 */
function applyTemplate(L, template, words) {
  if (!template || !(template.regions || []).length || !(words || []).length) return [];
  const offset = Math.max(0, (L.pageStart || 1) - 1);
  const set = [];
  for (const region of template.regions) {
    const text = regionText(words, region, offset);
    const v = valueFor(region.field, text);
    if (v == null) continue;
    const label = (FIELDS.find((f) => f.key === region.field) || {}).label || region.field;
    const ev = `From your ${template.label || 'letter'} template (${label}): "${text.replace(/\s+/g, ' ').slice(0, 80)}"`;
    const field = { value: v, evidence: ev, confidence: 0.97, source: 'template' };
    if (region.field === 'expires') { L.expiryDate = field; L.expiryBasis = 'Expiration date in your mapped region'; }
    else if (region.field === 'issued') L.issueDate = field;
    else if (region.field === 'approval') L.approvalNumber = field;
    else if (region.field === 'kernel') L.kernelVersion = field;
    else if (region.field === 'device') {
      const old = L.products || [];
      L.products = v.map((d) => ({ ...(old.find((p) => String(p.value).toUpperCase() === d.toUpperCase()) || {}), value: d, evidence: ev, confidence: 0.97, source: 'template' }));
    } else continue;
    set.push(region.field);
  }
  if (set.length) {
    const fixed = { device: /device|product/i, approval: /approval number/i, expires: /expir/i, issued: /issue/i, kernel: /kernel/i };
    L.warnings = (L.warnings || []).filter((w) => !/^No /.test(w) || !set.some((f) => fixed[f] && fixed[f].test(w)));
    L.template = { key: template.key, label: template.label, fields: set };
    L.confidence = Math.max(L.confidence || 0, Math.min(99, 80 + set.length * 4));
  }
  return set;
}

/** Apply every matching template to the letters of one document. */
function applyTemplates(letters, templates = {}, words = []) {
  if (!words || !words.length) return letters;
  for (const L of letters) {
    const key = letterTypeOf(L);
    const t = key && templates[key];
    if (t) applyTemplate(L, { ...t, key, label: t.label || (LETTER_TYPES.find((x) => x.key === key) || {}).label }, words);
  }
  return letters;
}

module.exports = { LETTER_TYPES, FIELDS, letterTypeOf, regionText, valueFor, applyTemplate, applyTemplates };
