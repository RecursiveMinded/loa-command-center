'use strict';
// Certification database notices: emails that list LOAs for the products you subscribe
// to ("Your subscribed Product(s) is updated / will be expired soon / is expired"), one
// table row per LOA: family, contact/contactless configuration (CL3), product reference,
// approval category, a link to the LOA, and its expiry date (day-month-year).
// Each row becomes a letter to review, carrying the link so the LOA can be opened.

const { normalizeScheme, normalizeCategory } = require('./taxonomy');

const isNotice = (t) => /subscribed\s+product\s*\(s\)/i.test(t) && /https?:\/\//i.test(t);

function noticeKind(t) {
  if (/will\s+be\s+expired\s+soon|expir\w+\s+soon/i.test(t)) return 'expiring';
  if (/\bis\s+expired\b|\bare\s+expired\b|has\s+expired/i.test(t)) return 'expired';
  return 'updated';
}
const KIND_TEXT = { updated: 'LOA updated', expiring: 'LOA will expire soon', expired: 'LOA expired' };

const pad = (n) => String(n).padStart(2, '0');
// Day-month-year, as these notices print it (16-07-2026); year-first is read as well.
function dmy(s) {
  let m = String(s).match(/\b(\d{4})[-./](\d{1,2})[-./](\d{1,2})\b/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = String(s).match(/\b(\d{1,2})[-./](\d{1,2})[-./](\d{4})\b/);
  if (!m || +m[2] > 12 || +m[1] > 31) return '';
  return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
}

const field = (value, evidence, confidence = 0.9) => (value ? { value, evidence: String(evidence).replace(/\s+/g, ' ').slice(0, 220), confidence, source: 'notice' } : null);

/** The LOA file name inside a link, decoded ("... T3.EMVC4-070100 Desk3500-CL3 402.FIME....pdf"). */
function linkName(url) {
  let path = String(url).split(/[?#]/)[0];
  try { path = decodeURIComponent(path); } catch (_) { /* keep as is */ }
  return { path, file: path.split('/').pop().replace(/\.pdf$/i, '') };
}

/** Read one row's text and link into a letter. */
function rowLetter(before, url, after, kind, index) {
  const { path, file } = linkName(url);
  const cells = before.split(/\t|\n|\s{2,}|\|/).map((c) => c.trim()).filter(Boolean);
  // Approval category: "L2 Contactless American Express", "L1 Contact", "PCI", "TQM".
  const catCell = cells.slice().reverse().find((c) => /\b(?:L[12]\s*(?:Contactless|Contact|CTLS|CL)|PCI|PTS|TQM)\b/i.test(c)) || '';
  const catText = (before.match(/(L[12]\s*(?:Contactless|Contact)[^\n\t|]*?|PCI[^\n\t|]*|TQM[^\n\t|]*)(?=\s*$|\t|\n|\|)/i) || [])[1] || catCell;
  const category = normalizeCategory(catText) || normalizeCategory(path);
  const brandText = catText.replace(/^.*?(?:Contactless|Contact)\s*/i, '').trim()
    || ((path.match(/\/(American Express|Mastercard|Visa|Discover|UnionPay|JCB|Interac|Union Pay)\//i) || [])[1] || '');
  const scheme = /^EMV L2 Contactless/.test(category) ? normalizeScheme(brandText) : /PCI/.test(category) ? 'PCI SSC' : /TQM/.test(category) ? 'Mastercard TQM' : 'EMVCo';
  // Device: the family ("Desk/3500", "DX8000") plus the configuration (CL3) when there is one.
  const fam = (before.match(/\b([A-Za-z]{2,10}\/\d{3,5}[A-Za-z]?|[A-Z]{1,3}\d{3,5})\b(?![^\n\t|]*x{3})/) || [])[1] || '';
  const conf = (before.match(/\b(CL\d|CT\d)\b/i) || [])[1] || '';
  const device = fam ? `${fam}${conf && /^CL/i.test(conf) && /Contactless|TQM/.test(category) ? `-${conf.toUpperCase()}` : ''}` : '';
  const expiry = dmy(after.slice(0, 80)) || dmy(before.slice(-40));
  const issue = (file.match(/\b(20\d{2})[.\-_](\d{2})[.\-_](\d{2})\b/) || []).slice(1).join('-');
  const kernel = /^EMV L2/.test(category) ? ((file.match(/\bT\d\.[A-Z0-9]+-[0-9A-Z.]+/i) || [])[0] || '') : '';
  const last = file.split(/\s+/).pop();
  const approval = /\d/.test(last) && /[.\-]/.test(last) && last.length >= 8 ? last : '';
  const ev = `Certification database notice, row ${index + 1}: ${cells.slice(-5).join(' · ')}`;
  return {
    issuer: brandText || 'Certification database', scheme, category, informational: false,
    approvalNumber: field(approval, `LOA file name: ${file}`, 0.85),
    products: device ? [{ value: device, evidence: ev, confidence: 0.9, source: 'notice' }] : [],
    kernelVersion: field(kernel, `LOA file name: ${file}`, 0.8),
    specVersion: null, l1Reference: null,
    issueDate: field(issue, `LOA file name: ${file}`, 0.7),
    expiryDate: field(expiry, `${ev} · expires ${after.slice(0, 20).trim()}`, 0.95),
    expiryBasis: 'Expired date in the certification database notice',
    restricted: false, renewalType: 'Initial', type: 'notice',
    link: url, notice: kind, noticeText: KIND_TEXT[kind],
    warnings: [`From a certification database notice (${KIND_TEXT[kind]}). Open the LOA from its link to file the letter itself.`],
    confidence: device && expiry ? 92 : 60,
    pageStart: 1, pageEnd: 1, segment: index,
  };
}

/** Letters listed in a notice, or [] when the text is not one. */
function parseNotice(text) {
  const t = String(text || '');
  if (!isNotice(t)) return [];
  const kind = noticeKind(t);
  const found = [];
  const re = /https?:\/\/[^\s<>"')]+/g;
  let m;
  while ((m = re.exec(t))) {
    const url = m[0].replace(/[.,;]+$/, '');
    if (!/loa|\.pdf/i.test(url)) continue;
    if (found.some((f) => f.url === url)) continue; // a link shown and also given as its address
    found.push({ url, start: m.index, end: m.index + m[0].length });
  }
  const head = t.search(/expir\w*\s+date/i);
  return found.map((f, i) => {
    const from = i ? found[i - 1].end : Math.max(0, head >= 0 && head < f.start ? head + 12 : 0);
    const before = t.slice(from, f.start).replace(/^[\s\S]*?\b\d{1,2}[-./]\d{1,2}[-./]\d{4}\b/, (x) => (i ? '' : x));
    const after = t.slice(f.end, i + 1 < found.length ? found[i + 1].start : t.length);
    return { index: i, ...rowLetter(before, f.url, after, kind, i) };
  });
}

module.exports = { isNotice, parseNotice, noticeKind, dmy };
