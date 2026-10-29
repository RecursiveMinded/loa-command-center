'use strict';
// Device-name normalization and matching. LOAs write the same terminal many
// ways ("AXIUM SX7000", "SX7000", "Lane/5000", "LANE5000CL3", "Self/5XXX CL1"),
// so everything is reduced to a compact uppercase key before comparing.

// Marketing/family words that are dropped before comparing. Users can extend
// this list in Settings ("ignored device words").
const DEFAULT_NOISE_WORDS = [
  'AXIUM', 'INGENICO', 'TELIUM', 'TETRA', 'TERMINAL', 'TERMINALS', 'PINPAD', 'PIN PAD',
  'POS', 'THE', 'VERIFONE', 'PAX', 'CASTLES', 'CASTLE', 'NEWLAND', 'SUNMI', 'FEITIAN',
];

function compact(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function makeNormalizer(noiseWords = DEFAULT_NOISE_WORDS) {
  const words = [...new Set(noiseWords.map((w) => compact(w)).filter(Boolean))].sort((a, b) => b.length - a.length);
  return function norm(name) {
    let s = String(name || '').toUpperCase();
    // Strip noise words only when they stand alone, so "PAXA920" stays intact.
    for (const w of words) s = s.replace(new RegExp(`(^|[^A-Z0-9])${w}(?=$|[^A-Z0-9])`, 'g'), '$1');
    return compact(s);
  };
}

const defaultNorm = makeNormalizer();

/** Split a normalized key into base model and contactless reader variant (CL1, CL2...). */
function splitVariant(key) {
  const m = key.match(/^(.*?)(CL\d+)$/);
  if (m && m[1]) return { base: m[1], variant: m[2] };
  return { base: key, variant: '' };
}

// Where a certification lives. A CL suffix names a hardware version of the
// device: chip components changed (often required by PCI or a new standard),
// and a name without a suffix is the first version, CL1. PCI and the contact
// approvals are held once per device and shared by all its versions; the
// contactless approvals and TQM are held per version.
const SHARED_CATEGORIES = new Set(['PCI PTS', 'EMV L1 Contact', 'EMV L2 Contact']);
const VERSION_CATEGORIES = new Set(['EMV L1 Contactless', 'EMV L2 Contactless', 'TQM']);

/** { base, version, key } for a normalized device key and approval category. */
function certHome(key, category) {
  const { base, variant } = splitVariant(key);
  if (SHARED_CATEGORIES.has(category)) return { base, version: '', key: base };
  if (VERSION_CATEGORIES.has(category)) { const v = variant || 'CL1'; return { base, version: v, key: base + v }; }
  return { base, version: variant, key };
}

/** "Lane/5000-CL3" -> "Lane/5000"; keeps the user's spelling. */
function baseDisplayName(name) {
  return String(name || '').replace(/[\s\-_/]*CL\d+\s*$/i, '').trim();
}

function variantOf(name) {
  const m = String(name || '').match(/CL\s*(\d+)\s*$/i);
  return m ? `CL${m[1]}` : '';
}

function wildcardRegex(key) {
  // "SELF5XXXCL1" -> /^SELF5\d{3}CL1$/ ; an X directly after a digit is a wildcard.
  if (!/\dX/.test(key)) return null;
  let src = '';
  let numeric = false; // previous char was a digit or a substituted wildcard
  for (const c of key) {
    if (c === 'X' && numeric) { src += '\\d'; continue; }
    src += c;
    numeric = /\d/.test(c);
  }
  return new RegExp(`^${src}$`);
}

/**
 * Score how well a device name from a document matches a record's device.
 * 100 exact, 80 same base when one side has no reader variant, 60 wildcard family,
 * 0 different (including different reader variants of the same base).
 */
function deviceScore(docName, recordDevice, norm = defaultNorm, aliases = {}) {
  let a = norm(docName);
  let b = norm(recordDevice);
  if (!a || !b) return 0;
  if (aliases[a]) a = norm(aliases[a]);
  if (aliases[b]) b = norm(aliases[b]);
  if (a === b) return 100;
  const A = splitVariant(a), B = splitVariant(b);
  const variantsCompatible = !A.variant || !B.variant || A.variant === B.variant;
  if (A.base === B.base) {
    if (A.variant === B.variant) return 100;
    return variantsCompatible ? 80 : 0;
  }
  const wa = wildcardRegex(A.base);
  if (wa && wa.test(B.base) && variantsCompatible) return 60;
  return 0;
}

/**
 * OCR often reads digits in a model code as look-alike letters
 * ("Self/SXXX" for "Self/5XXX"). Only the code after a slash is corrected,
 * and only when it already looks like a model number.
 */
function ocrDigits(p) {
  return p.replace(/\/([0-9OSIlB][0-9OSIlBX]{2,4})\b/g, (m, code) => (/\d|XX/.test(code)
    ? `/${code.replace(/O/g, '0').replace(/S/g, '5').replace(/[Il]/g, '1').replace(/B/g, '8')}` : m));
}

/**
 * Pull device names out of a free-text product line such as
 * "AXIUM SX5000 and AXIUM SX7000" or "AXIUM SX5000 & SX7000".
 */
function splitProducts(line) {
  if (!line) return [];
  const cleaned = String(line).replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(/\s*(?:,|;|&|\band\b|\+)\s*/i).map((p) => p.replace(/\s+version\b.*$/i, '').trim()).filter(Boolean);
  // "AXIUM SX5000 & SX7000": carry the leading family word to the bare model.
  const out = [];
  let prefix = '';
  for (const p of parts) {
    const words = p.split(' ');
    if (words.length > 1 && /^[A-Za-z]+$/.test(words[0])) prefix = words[0];
    out.push(words.length === 1 && prefix ? `${prefix} ${p}` : p);
  }
  return out
    .map((p) => ocrDigits(p.replace(/\s+version\b.*$/i, '')
      .split(' ').filter((w) => !/^(MCL|V|VER|FW|HW|SW)[\d.]+$/i.test(w)).join(' ').trim())
      .replace(/\s+[^\d\s]$/, '')) // a stray bullet glyph read as a letter
    .filter((p) => /\d/.test(p));
}

/**
 * Find the device a file name refers to, e.g. "Self4000CL2_EmvL1Cless.pdf"
 * or "SELF-4000 CL2 Discover.pdf". A device already in the register wins
 * (longest match), otherwise the leading model code is turned into a name.
 * Returns { value, known } or null.
 */
function deviceFromFilename(filename, knownDevices = [], norm = defaultNorm) {
  const base = String(filename || '').replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{2,5}$/, '');
  const key = compact(base);
  if (!key) return null;
  let best = null;
  for (const d of knownDevices) {
    const k = norm(d);
    if (k.length < 4 || !/\d/.test(k) || !key.startsWith(k)) continue;
    // "SELF4000" must not claim "SELF4000CL2..." when the file names a reader version.
    const rest = key.slice(k.length);
    if (!splitVariant(k).variant && /^CL\d/.test(rest)) continue;
    if (!best || k.length > best.k.length) best = { k, value: d };
  }
  if (best) return { value: best.value, known: true };
  const bare = base.replace(new RegExp(`\\b(${DEFAULT_NOISE_WORDS.join('|')})\\b[\\s_\\-]*`, 'gi'), '');
  const m = bare.match(/^\s*([A-Za-z]{2,12})[\s_\-/]*(\d{3,5}[A-Za-z]?)(?:[\s_\-]*(CL\s*\d))?(?![A-Za-z0-9])|^\s*([A-Za-z]{2,12})[\s_\-/]*(\d{3,5})(CL\d)/i);
  if (!m) return null;
  const fam = m[1] || m[4], num = m[2] || m[5], cl = (m[3] || m[6] || '').replace(/\s+/g, '').toUpperCase();
  // Short codes are written joined ("DX8000"), family names with a slash ("Self/4000").
  const short = fam.length <= 3;
  const word = short ? fam.toUpperCase() : fam[0].toUpperCase() + fam.slice(1).toLowerCase();
  // Follow the register's own spelling for the reader version ("-CL2" or " CL2").
  const sep = (knownDevices.find((d) => /\dCL\d/i.test(compact(d)) && /\d[\s\-_]?CL\d/i.test(d)) || 'x0-CL1').match(/\d([\s\-_]?)CL\d/i)[1];
  return { value: `${word}${short ? '' : '/'}${num.toUpperCase()}${cl ? sep + cl : ''}`, known: false };
}

const FILE_SCHEMES = [
  [/^(MC|MASTERCARD)$/, 'Mastercard'], [/^(DISC|DISCOVER|DPAS)$/, 'Discover'], [/^(AMEX|AXP)$/, 'Amex'],
  [/^VISA$/, 'Visa'], [/^(UPI|CUP|UNIONPAY)$/, 'UnionPay'], [/^JCB$/, 'JCB'], [/^INTERAC$/, 'Interac'], [/^EMVCO$/, 'EMVCo'],
];
/** Card brand named by a part of a file name ("Self4000CL2_MC_100100.pdf"), or ''. */
function schemeFromFilename(filename) {
  for (const part of String(filename || '').replace(/\.[A-Za-z0-9]{2,5}$/, '').split(/[\s_\-.]+/)) {
    const k = compact(part);
    for (const [re, name] of FILE_SCHEMES) if (re.test(k)) return name;
  }
  return '';
}

/** Approval type hinted at in a file name ("EmvL1Cless", "L2_CTLS"), or ''. */
function categoryFromFilename(filename) {
  // Drop reader versions first: the "CL2" in "Self4000CL2" is not "L2".
  const k = compact(filename).replace(/CL\d/g, '');
  const l1 = /L1|LEVEL1/.test(k), l2 = /L2|LEVEL2/.test(k);
  const cless = /CLESS|CTLS|CONTACTLESS|CTL(?!S?CNT)/.test(k), contact = /CONTACT(?!LESS)|CNT/.test(k);
  if (!(l1 || l2) || !(cless || contact)) return '';
  return `EMV ${l2 ? 'L2' : 'L1'} ${cless ? 'Contactless' : 'Contact'}`;
}

module.exports = {
  deviceFromFilename, categoryFromFilename, schemeFromFilename,
  DEFAULT_NOISE_WORDS, compact, makeNormalizer, defaultNorm, splitVariant,
  baseDisplayName, variantOf, certHome, SHARED_CATEGORIES, VERSION_CATEGORIES, deviceScore, splitProducts, wildcardRegex,
};
