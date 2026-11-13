'use strict';
// Validity letters: a manufacturer's own signed statement that an L2
// approval won on one model of a platform family is valid on every model of
// that family. They are not EMVCo or card-brand approvals and never expire:
// coverage lasts as long as the real LOA it points at.
//
// Contact letters certify the coverage (EMVCo's type approval bulletin
// classes the model differences as "minor changes"), so one L2 Contact LOA
// on a family model covers every model the letter lists. Contactless letters
// only say the kernels run identically; approvals stay per product and the
// contactless reader (PCD) version matters, so they are evidence and a
// kernel reference, never coverage.
//
// Fine print the app enforces:
//   - "Only the kernel X Version 09.06 and future versions can be used on
//     configurations with A and B": a minimum kernel for named devices.
//   - A compatibility column ("AXIUM" vs "AXIUM / AXIUM Next-Gen"): older
//     kernels may not be certified on the newer product generation.

const { findDates } = require('./dates');

const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const digits = (v) => String(v || '').replace(/\D/g, '');

// The subject line names the kind of letter and the family.
const SUBJECT = /(?:LoA\s+validity|validity\s+of\s+EMV[^\n]{0,40}?LoA|kernels?\s+compatibility)\s+on\s+the\s+([^\n]{2,60}?)\s+family/i;
const SAME_KERNELS = /uses\s+the\s+same\s+EMV\s+(Contact(?:less)?)\s+Kernel\s+versions?/i;
const SIGNATURE = new RegExp(`${SUBJECT.source}|${SAME_KERNELS.source}`, 'i');

function isValidityLetter(text) {
  return SIGNATURE.test(String(text || ''));
}

const BRANDS = [
  ['Mastercard', /\bmaster\s*card|\bMCL\b|paypass/i],
  ['Visa', /\bvisa\b|paywave|qvsdc/i],
  ['Amex', /\bamex\b|american\s+express|expresspay/i],
  ['Discover', /\bdiscover\b|d-?pas\b|\bzip\b/i],
  ['UnionPay', /\bunionpay\b|\bUPI\b|\bCUP\b|quickpass|quics/i],
  ['JCB', /\bjcb\b|j\/speedy/i],
  ['Interac', /\binterac\b/i],
];
const brandOf = (s) => (BRANDS.find(([, re]) => re.test(s)) || [null])[0];

/** Title-case a family name the way people write it ("Telium Tetra", "AXIUM", "Moby"). */
function familyName(raw) {
  let s = clean(raw).replace(/^the\s+/i, '');
  if (/^tetra$/i.test(s)) s = 'Telium Tetra';
  return s;
}

// Words that head a list or column but are not products.
const NOT_PRODUCT = /^(?:product_?list|kernel_?list|specification|kernel|compatibility|products?|and|or|among\s+others)$/i;

/** One cell of a product list: "Move/2500, Move/2600" or "iPP31x with Tetra terminal". */
function productsIn(cell) {
  return clean(cell).replace(/^[-•·*–]\s*/, '').split(/\s*,\s*/)
    .map((p) => clean(p.replace(/^[-•·*–]\s*/, '').replace(/\s+with\s+Tetra(?:\s+terminal)?\b/i, '').replace(/[.;:]$/, '')))
    .filter((p) => p && p.length <= 30 && !NOT_PRODUCT.test(p) && /^[A-Za-z]/.test(p) && (/\d/.test(p) || /^i[A-Z]/.test(p) || /^[A-Z]{3,}[a-z]*(?:-[A-Z])?$/.test(p)));
}

/**
 * The product list. Lists come as bullets ("- Desk/1700, Desk/2600"), as two
 * columns with a heading each ("AXIUM   AXIUM Next-Gen"), or inside a sentence
 * ("in the products listed here; MOBY EM3, MOBY EM5, fully supporting").
 * Returns [{ value, group }] where group is the column heading, if any.
 */
function productList(t) {
  const out = [];
  const seen = new Set();
  const push = (value, group = '') => {
    const k = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ value, group });
  };
  const sentence = t.match(/products\s+listed\s+here\s*[;:,]?\s*([\s\S]{3,300}?),?\s+fully\b/i);
  if (sentence) for (const p of productsIn(sentence[1])) push(p);

  const startRe = /^[ \t\f]*Product_?list[ \t]*:|products\s+listed\s+below\s*:?|covered\s+by\s+this\s+letter\s*:?|(?:the\s+)?below\s+list\s+of\s+products\.?/gim;
  const stopRe = /^\s*(?:However|If\s+you\s+have|Yours|Sincerely|Note\s+also|Laurent|Philippe|www\.|\d\s+(?:Only|The\s+compat))/i;
  let m;
  while ((m = startRe.exec(t))) {
    const lines = t.slice(m.index + m[0].length).split('\n');
    let groups = []; // [{ name, at }]: column headings and where they start
    let blank = 0;
    for (const line of lines) {
      if (stopRe.test(line)) break;
      if (!line.trim()) { if (++blank > 3 && out.length) break; continue; }
      blank = 0;
      // Cells are separated by wide gaps; a bullet on its own is not a cell.
      const cells = [];
      const cellRe = /\S(?:.*?\S)?(?=\s{3,}|\s*$)/g;
      let c;
      while ((c = cellRe.exec(line))) {
        const b = c[0].match(/^[-•·*–]\s*/);
        const text = c[0].slice(b ? b[0].length : 0);
        if (text) cells.push({ text, at: c.index + (b ? b[0].length : 0), bullet: !!b });
      }
      // A row of headings: no model numbers ("AXIUM   AXIUM Next-Gen").
      if (cells.length > 1 && cells.every((x) => !/\d/.test(x.text) && !x.bullet && x.text.length <= 20 && !/,/.test(x.text))) {
        groups = cells.map((x) => ({ name: x.text, at: x.at }));
        continue;
      }
      for (const cell of cells) {
        const g = groups.filter((h) => h.at <= cell.at + 12).pop();
        for (const p of productsIn(cell.text)) push(p, groups.length > 1 && g ? g.name : '');
      }
    }
  }
  return out;
}

/** "Only the kernel T3.EMV.Contact Version 09.06 and future versions can be used on configurations with Desk/1600 and Self/8000". */
function restrictions(flat) {
  const out = [];
  const re = /Only\s+the\s+kernel\s+(.{0,60}?)\s*Version\s*([\d.]+)\s+and\s+(?:future|later|newer)\s+versions\s+(?:can|may)\s+be\s+used\s+on\s+(?:configurations\s+with\s+)?(.+?)(?:\.|$|\s{2}|\s(?=www\.))/gi;
  let m;
  while ((m = re.exec(flat))) {
    const devices = m[3].split(/\s*(?:,|\band\b|&)\s*/i).map(clean).filter((d) => /\d/.test(d) && d.length <= 30);
    if (devices.length) out.push({ kernel: clean(m[1]), minVersion: m[2].replace(/\.$/, ''), devices, evidence: clean(m[0]).slice(0, 220) });
  }
  return out;
}

const VERSION = /\b(\d{2}\.\d{2}(?:\.\d{2})?|\d{4,6})\b/g;

/**
 * One line of a kernel list:
 *   "Mastercard MCL4.0   kernel T3.EMV.C2 version 100100"
 *   "Visa payWave 2.2:   kernel 9992044550 versions 070000 and 070803"
 *   "UPI QuickPass:      kernel EMV_C7 040600, 040700 and 050700"
 *   "Discover D-PAS 1.0: kernels 844557-0311 (and kernel ZIP 846004-0200)"
 *   "Mastercard MCL4.0 / 4.1   kernel PAYPASS_L2 04.04   AXIUM / AXIUM Next-Gen"
 *   "Visa Paywave V2.2" (a specification with no kernel number)
 * Returns [{ brand, spec, name, versions, zip, nextGen }].
 */
function kernelLine(line) {
  // A compatibility column is the last wide-spaced cell, with no digits ("AXIUM / AXIUM Next-Gen").
  const cells = String(line || '').trim().split(/\s{3,}/);
  let compat = '';
  if (cells.length >= 3 && !/\d/.test(cells[cells.length - 1]) && cells.slice(0, -1).some((c) => /\bkernels?\b/i.test(c))) compat = cells.pop();
  const s = clean(cells.join(' ')).replace(/^[-•·*–]\s*/, '');
  const brand = brandOf(s);
  if (!brand) return [];
  const nextGen = compat ? /Next-Gen|new(?:er)?\s+gen/i.test(compat) : null;
  const at = s.search(/\bkernels?\b/i);
  const spec = clean((at >= 0 ? s.slice(0, at) : s).replace(/[:]\s*$/, ''));
  if (at < 0) return [{ brand, spec, name: '', versions: [], zip: false, nextGen }];
  let rest = s.slice(at).replace(/^kernels?\s*/i, '');
  const out = [];
  // A legacy magstripe kernel can share the line: "(and kernel ZIP 846004-0200)".
  const zip = rest.match(/\(?\s*and\s+kernel\s+ZIP\s+([\w.-]+)\s*\)?/i);
  if (zip) {
    rest = rest.replace(zip[0], ' ');
    const v = zip[1].split('-').pop();
    out.push({ brand, spec: `${spec} (ZIP)`, name: 'ZIP', versions: [v], zip: true, nextGen });
  }
  let name = '';
  let versionsText = rest;
  const vw = rest.match(/\bversions?\s+(.*)$/i);
  if (vw) {
    name = clean(rest.slice(0, vw.index));
    versionsText = vw[1];
  } else {
    const first = rest.split(/\s+/)[0] || '';
    // "844557-0311": kernel id then version.
    const idv = first.match(/^(\d{6,})-(\d{4,6})$/);
    if (idv) { name = idv[1]; versionsText = `${idv[2]} ${rest.slice(first.length)}`; }
    else {
      // "Quickpass_L2_03.03": the version is glued to the name.
      const glued = first.match(/^(.*?[A-Za-z][\w.]*?)_(\d{2}\.\d{2}(?:\.\d{2})?)$/);
      if (glued) { name = glued[1]; versionsText = `${glued[2]} ${rest.slice(first.length)}`; }
      else if (/[A-Za-z]/.test(first) || /^\d{7,}$/.test(first)) { name = first; versionsText = rest.slice(first.length); }
    }
  }
  versionsText = versionsText.replace(/(\d{6,})-(\d{4,6})/g, '$2');
  const versions = (versionsText.match(VERSION) || []).filter((v) => !/^\d{7,}$/.test(v));
  out.unshift({ brand, spec, name, versions: [...new Set(versions)], zip: false, nextGen });
  return out;
}

function kernelList(t) {
  const m = t.match(/^[ \t]*Kernel_?list[ \t]*:|kernel\s+versions\s+are\s*:?/im);
  if (!m) return [];
  const out = [];
  for (const line of t.slice(m.index + m[0].length).split('\n')) {
    if (/Product_?list|^\s*(?:However|If\s+you\s+have|Sincerely|\d\s+The\s+compat|www\.)/i.test(line)) break;
    if (!line.trim() || /^\s*Specification\s+kernel/i.test(line)) continue;
    out.push(...kernelLine(line));
  }
  return out;
}

/** The EMV contact kernel a contact letter names: "(RD-L2-Kern Version 01-01-23 )". */
function contactKernel(flat) {
  const m = flat.match(/\(\s*([A-Z][\w.-]*Kern[\w.-]*)\s+Version\s+([\d.-]+)\s*\)/i);
  return m ? { name: m[1], version: m[2].replace(/[.-]$/, '') } : null;
}

/**
 * Read a validity letter. Returns null when the text is not one.
 * { family, interface: 'contact'|'contactless', reference, issued,
 *   products: [{ value, group }], kernels: [...], contactKernel,
 *   restrictions: [...], basis, openList, perProduct, pcdCaveat, nextGenNote }
 */
function parseValidity(text) {
  const t = String(text || '');
  const flat = t.replace(/[ \t]*\n[ \t]*/g, ' ');
  const subj = flat.match(SUBJECT);
  const same = flat.match(SAME_KERNELS);
  if (!subj && !same) return null;
  const head = subj ? flat.slice(Math.max(0, subj.index - 80), subj.index + subj[0].length) : same[0];
  const iface = /contactless/i.test(head) ? 'contactless' : 'contact';
  const products = productList(t);
  let family = subj ? familyName(subj[1]) : '';
  if (!family && products.length) family = familyName(products[0].value.split(/[\s/]/)[0]);
  if (/^MOBY$/i.test(family)) family = 'Moby';
  const ref = flat.match(/Ref\.?\s*\/?\s*([A-Z]{2,6}-[A-Z0-9][A-Z0-9-]{4,})/i);
  // The letter date sits on the reference line ("Valence, 15 May 2025"); signature stamps carry a time.
  const ds = findDates(flat.slice(0, 900)).filter((d) => !/\d{1,2}:\d{2}/.test(flat.slice(d.index + d.raw.length, d.index + d.raw.length + 12)));
  // Devices a footnote allows only on a newer kernel are covered too, on that condition.
  const rules = restrictions(flat);
  if (iface === 'contact') {
    const have = new Set(products.map((p) => p.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
    for (const r of rules) for (const d of r.devices) if (!have.has(d.toUpperCase().replace(/[^A-Z0-9]/g, ''))) { have.add(d.toUpperCase().replace(/[^A-Z0-9]/g, '')); products.push({ value: d, group: '', condition: `kernel ${r.minVersion} or newer` }); }
  }
  const basis = flat.match(/(?:EMVCo\s+)?Type\s+Approval\s+Bulletin\s+N\D{0,4}\s*(\d+)(?:\s+of\s+([A-Za-z]+\s+\d{4}))?/i);
  return {
    family,
    nextGen: /Next-Gen/i.test(flat),
    interface: iface,
    reference: ref ? ref[1] : '',
    issued: ds.length ? ds[0].iso : '',
    products,
    kernels: iface === 'contactless' ? kernelList(t) : [],
    contactKernel: iface === 'contact' ? contactKernel(flat) : null,
    restrictions: rules,
    basis: basis ? clean(`EMVCo Type Approval Bulletin ${basis[1]}${basis[2] ? ` (${basis[2]})` : ''}`) : '',
    openList: /among\s+others|new\s+products\s+that\s+will\s+be\s+launched/i.test(flat),
    perProduct: /approvals\s+are\s+provided\s+by\s+product|couple\s*\{?\s*terminal/i.test(flat),
    pcdCaveat: /version\s+of\s+(?:the\s+)?PCD/i.test(flat),
    nextGenNote: /cannot\s+be\s+certified\s+on\s+[^.]*Next-Gen/i.test(flat),
    subject: subj ? clean(subj[0]) : clean(same[0]),
  };
}

// ---------------------------------------------------------------------------
// Using the letters
// ---------------------------------------------------------------------------

/** Compare kernel versions by their digits ("09.06" < "09.10"); null when either is missing. */
function versionParts(v) {
  const s = String(v || '').trim();
  // "0906" is written without dots: two digits per part.
  if (/^\d+$/.test(s) && s.length >= 4 && s.length % 2 === 0) return s.match(/\d{2}/g).map(Number);
  return s.split(/[^\d]+/).filter(Boolean).map(Number);
}
function cmpVersion(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  if (!pa.length || !pb.length) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Newest letter per family + interface wins; older ones are kept as history. */
function currentLetters(letters) {
  const best = new Map();
  for (const L of letters) {
    const k = `${String(L.family).toUpperCase()}|${L.interface}`;
    const cur = best.get(k);
    if (!cur || String(L.issued || '') > String(cur.issued || '')) best.set(k, L);
  }
  return [...best.values()];
}

/** The letters (current only) that list a device. `norm` is the store's name normaliser. */
function lettersFor(device, letters, norm, { iface } = {}) {
  const key = norm(device);
  if (!key) return [];
  return currentLetters(letters).filter((L) => (!iface || L.interface === iface) && L.products.some((p) => norm(p.value) === key));
}

/** Product group of a device on a letter ("AXIUM Next-Gen"), or ''. */
function groupOf(L, device, norm) {
  const p = L.products.find((x) => norm(x.value) === norm(device));
  return p ? p.group || '' : '';
}

/** Is this L2 Contact kernel allowed on this device by the letter's fine print? Returns the broken rule or null. */
function contactRuleBroken(L, device, kernel, norm) {
  for (const r of L.restrictions || []) {
    if (!r.devices.some((d) => norm(d) === norm(device))) continue;
    const c = cmpVersion(kernel, r.minVersion);
    if (c != null && c < 0) return r;
  }
  return null;
}

/** A contactless kernel on a newer-generation device that the letter marks as older generation only. */
function nextGenBroken(L, device, brand, kernel, norm) {
  if (!/Next-Gen/i.test(groupOf(L, device, norm))) return null;
  const k = digits(kernel);
  if (!k) return null;
  const hit = (L.kernels || []).find((x) => x.brand === brand && x.versions.some((v) => digits(v) === k));
  return hit && hit.nextGen === false ? hit : null;
}

/** "Telium Tetra contact validity letter EDOC-1 (11 Apr 2024)". */
function letterLabel(L) {
  return clean(`${L.family} ${L.interface} validity letter ${L.reference || ''}${L.issued ? ` (${L.issued})` : ''}`);
}

/** The spec name a contactless letter gives a brand kernel ("Mastercard MCL4.0"), or ''. */
function specFor(letters, brand, kernel) {
  const k = digits(kernel);
  if (!k) return '';
  for (const L of letters) {
    const hit = (L.kernels || []).find((x) => x.brand === brand && !x.zip && x.versions.some((v) => digits(v) === k));
    if (hit) return hit.spec;
  }
  return '';
}

module.exports = { isValidityLetter, parseValidity, kernelLine, productList, restrictions, cmpVersion, currentLetters, lettersFor, groupOf, contactRuleBroken, nextGenBroken, letterLabel, specFor, SIGNATURE };
