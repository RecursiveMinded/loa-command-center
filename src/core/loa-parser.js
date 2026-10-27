'use strict';
// LOA reader: splits a document's text into individual letters and extracts
// the certification facts from each one. Issuer-specific rules handle the
// wording each approval body uses; a generic fallback covers everything else.
//
// Output never invents values: every field carries the text snippet it came
// from so the reviewer can see why the app believes it.

const { parseDate, findDates, addYears, addMonths, wordToNumber, MONTH_RE } = require('./dates');
const { splitProducts } = require('./devices');

// ---------------------------------------------------------------------------
// Letter boundaries
// ---------------------------------------------------------------------------

// Each signature marks where a new letter begins. `type` groups repeated
// headers of the same letter (e.g. a PCI header printed on every page).
const STARTS = [
  { type: 'amex', re: /RE:\s*Expresspay[\s\S]{0,40}?Certification/i },
  { type: 'discover', re: /Re:\s*Discover\s+D-?PAS/i },
  { type: 'emvco', re: /Re:\s*EMVCo\s+Letter\s+of\s+Approval/i },
  { type: 'interac', re: /RE:\s*LEVEL\s*2\s*LETTER\s+OF\s+APPROVAL/i },
  { type: 'jcb', re: /Letter\s+of\s+Approval\s*[-–]\s*JCB/i },
  { type: 'mastercard', re: /Mastercard\s+Contactless\s+Reader\s+Vendor\s+Product\s*[–-]\s*Letter\s+of\s+Approval/i },
  { type: 'mastercard', re: /Mastercard\s+(?:Contact\s+)?(?:Terminal|M\/Chip)[\s\S]{0,40}?Letter\s+of\s+Approval/i },
  { type: 'tqm', re: /Terminal\s+Quality\s+Management\s+Statement\s+of\s+Compliance/i },
  { type: 'pci', re: /Security\s+Standards\s+Council\s+Letter\s+of\s+Approval/i },
  { type: 'unionpay', re: /CERTIFICATE\s+FOR\s+UNIONPAY/i },
  { type: 'visa', re: /Visa\b[\s\S]{0,60}?(?:Letter\s+of\s+Approval|Approval\s+Letter|Approval\s+Notification)/i },
  { type: 'eftpos', re: /eftpos[\s\S]{0,60}?(?:Letter\s+of\s+Approval|Certificate)/i },
  { type: 'loe', re: /Letter\s+of\s+Equivalen(?:cy|ce)/i },
  { type: 'bulletin', re: /Product\s+Configuration\s+Bulletin/i },
];

/**
 * Split text into letters. `pages` is an array of page strings (from pdf.js
 * or OCR). Returns [{ text, pageStart, pageEnd, type }].
 */
function segmentLetters(pages) {
  if (typeof pages === 'string') pages = [pages];
  const offsets = [];
  let full = '';
  pages.forEach((p, i) => {
    offsets.push(full.length);
    full += (p || '') + '\n\f\n';
  });
  const pageAt = (idx) => {
    let lo = 0;
    for (let i = 0; i < offsets.length; i++) if (offsets[i] <= idx) lo = i;
    return lo + 1;
  };

  const hits = [];
  for (const s of STARTS) {
    const g = new RegExp(s.re.source, 'gi');
    let m;
    while ((m = g.exec(full))) hits.push({ index: m.index, type: s.type });
  }
  hits.sort((a, b) => a.index - b.index);

  // A letterhead and date usually sit just above the "Re:" line. Pull each
  // boundary back to the page break, or to the closest date in the 300
  // characters before it, so the letter date stays with its letter. Dates that
  // follow an expiry/renewal label belong to the previous letter and are skipped.
  const bounds = [];
  for (const h of hits) {
    const prev = bounds.length ? bounds[bounds.length - 1].index : 0;
    let start = h.index;
    const windowStart = Math.max(prev, h.index - 300);
    const before = full.slice(windowStart, h.index);
    const ff = before.lastIndexOf('\f');
    if (ff >= 0) {
      start = windowStart + ff + 1;
      while (full[start] === '\n') start++; // the new page starts after the separator
    } else {
      const ds = findDates(before).filter((d) => {
        const lead = before.slice(Math.max(0, d.index - 45), d.index);
        return !/(expir|renewal|valid|until|issue\s*date|effective)/i.test(lead);
      });
      if (ds.length) start = windowStart + ds[ds.length - 1].index;
    }
    if (bounds.length && start <= bounds[bounds.length - 1].index) start = h.index;
    bounds.push({ index: start, type: h.type, anchor: h.index });
  }

  if (!bounds.length) {
    return [{ text: full.replace(/\f/g, ''), pageStart: 1, pageEnd: pages.length, type: 'unknown' }];
  }
  // Text above the first letter on its own page(s) is a separate document; a
  // letterhead on the same page belongs to the letter.
  if (bounds[0].index > 0 && pageAt(bounds[0].index) > 1 && full.slice(0, bounds[0].index).trim().length > 200) {
    bounds.unshift({ index: 0, type: 'unknown' });
  } else {
    bounds[0].index = 0;
  }

  let segs = bounds.map((b, i) => {
    const end = i + 1 < bounds.length ? bounds[i + 1].index : full.length;
    const raw = full.slice(b.index, end);
    const anchorRaw = b.anchor != null ? b.anchor - b.index : 0;
    return {
      text: raw.replace(/\f/g, ''),
      anchor: anchorRaw - (raw.slice(0, Math.max(0, anchorRaw)).match(/\f/g) || []).length,
      pageStart: pageAt(b.index),
      pageEnd: pageAt(Math.max(b.index, end - 1)),
      type: b.type,
    };
  });

  // Merge repeated headers of one letter (same type, no new approval number).
  const merged = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === s.type) {
      // A TQM statement prints its header on every page and lists several labels.
      if (s.type === 'tqm') {
        prev.text += '\n' + s.text;
        prev.pageEnd = s.pageEnd;
        continue;
      }
      const a = quickApprovalNumber(prev.text, prev.type);
      const b = quickApprovalNumber(s.text, s.type);
      if (!b || a === b) {
        prev.text += '\n' + s.text;
        prev.pageEnd = s.pageEnd;
        continue;
      }
    }
    merged.push({ ...s });
  }
  segs = merged.filter((s) => s.text.trim().length > 40);
  return segs;
}

function quickApprovalNumber(text, type) {
  const f = ISSUERS[type];
  if (f && f.approval) {
    const r = f.approval(text);
    if (r) return r.value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

function clean(v) {
  return String(v || '').replace(/\\_/g, '_').replace(/\\&/g, '&').replace(/\s+/g, ' ').trim();
}

function field(value, evidence, confidence = 0.9) {
  if (value == null || value === '') return null;
  return { value, evidence: clean(evidence).slice(0, 220), confidence };
}

/** First regex capture as a field. */
function grab(text, re, conf = 0.9, map = (x) => clean(x)) {
  const m = text.match(re);
  if (!m) return null;
  const v = map(m[1], m);
  return v ? field(v, m[0], conf) : null;
}

/** Date that follows a label within `span` characters. */
function dateAfter(text, labelRe, span = 90, conf = 0.95) {
  const g = new RegExp(labelRe.source, labelRe.flags.includes('g') ? labelRe.flags : labelRe.flags + 'g');
  let m;
  while ((m = g.exec(text))) {
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + span);
    const ds = findDates(tail);
    if (ds.length) {
      return field(ds[0].iso, text.slice(m.index, m.index + m[0].length + ds[0].index + ds[0].raw.length), conf);
    }
  }
  return null;
}

/**
 * The letter's own date: the date closest above the subject line, or failing
 * that the first date after it. Times-of-day (signature stamps) are ignored.
 */
function letterDate(text, anchor = 0) {
  const notStamp = (src, d) => !/\d{1,2}:\d{2}(:\d{2})?\s*$/.test(src.slice(Math.max(0, d.index - 12), d.index));
  const notLabelled = (src, d) => !/(expir|renewal|valid|until)\w*\s*(date)?\s*:?\s*$/i.test(src.slice(Math.max(0, d.index - 30), d.index));
  if (anchor > 0) {
    const pre = text.slice(Math.max(0, anchor - 400), anchor);
    const ds = findDates(pre).filter((d) => notStamp(pre, d) && notLabelled(pre, d));
    if (ds.length) return field(ds[ds.length - 1].iso, ds[ds.length - 1].raw, 0.8);
  }
  const head = text.slice(anchor, anchor + 1500);
  const ds = findDates(head).filter((d) => notStamp(head, d) && notLabelled(head, d));
  return ds.length ? field(ds[0].iso, ds[0].raw, 0.75) : null;
}

/** "valid for three years from the date of issuance" -> years number. */
function validityPeriod(text) {
  const m = text.match(/(?:valid|granted)\s+for\s+(?:a\s+period\s+of\s+)?(\w+)\s*(?:\((\d+)\))?\s*(year|month)s?/i);
  if (!m) return null;
  const n = wordToNumber(m[2] || m[1]);
  if (!n) return null;
  return { n, unit: m[3].toLowerCase(), evidence: m[0] };
}

function restrictedFlag(text) {
  return /restricted\s+renewal|restricted\s+extension|one[-\s]time\s+extension|final\s+extension/i.test(text);
}

// ---------------------------------------------------------------------------
// Issuer rules
// ---------------------------------------------------------------------------

const ISSUERS = {
  amex: {
    issuer: 'Amex', scheme: 'Amex', category: () => 'EMV L2 Contactless',
    approval: (t) => grab(t, /Approval\s+Number:\s*([0-9A-Z][0-9A-Z.\-_]+)/i),
    products: (t) => {
      const out = [];
      const p = grab(t, /Product\s+Name:\s*(.+?)\s+(?:Firmware|Version|As\s+Tested|I&P|I\\&P)/i);
      if (p) out.push(...splitProducts(p.value).map((v) => field(v, p.evidence, 0.9)));
      const a = t.match(/Approval\s+Number:\s*\d+\.[A-Z]+\.[A-Z]+\.([A-Z0-9]+)\.\d{8}/i);
      if (a) out.push(field(a[1], a[0], 0.8));
      const tested = grab(t, /As\s+Tested\s+in:\s*(.+?)(?:\s{2,}|\n|Dear|$)/i, 0.7);
      if (tested) out.push(...splitProducts(tested.value).map((v) => field(v, tested.evidence, 0.7)));
      return out;
    },
    kernel: (t) => grab(t, /Firmware\s+Version:\s*(\S+)/i, 0.85),
    spec: (t) => grab(t, /Expresspay\s+(\d+(?:\.\d+)?)/i, 0.85),
    dates: (t, base) => {
      const issue = base.letterDate;
      let expiry = dateAfter(t, /Renewal\s+Date\s*:?/i) || dateAfter(t, /will\s+expire\s+on/i, 40);
      let basis = expiry ? 'Expiry/renewal date stated in letter' : '';
      if (!expiry && issue) {
        const vp = validityPeriod(t);
        if (vp) {
          const iso = vp.unit === 'year' ? addYears(issue.value, vp.n) : addMonths(issue.value, vp.n);
          expiry = field(iso, `${vp.evidence} (issued ${issue.value})`, 0.85);
          basis = `Calculated: ${vp.n} ${vp.unit}s from issue date`;
        }
      }
      return { issue, expiry, basis };
    },
  },

  discover: {
    issuer: 'Discover', scheme: 'Discover',
    category: (t) => (/contactless/i.test(t) ? 'EMV L2 Contactless' : 'EMV L2 Contact'),
    approval: (t) => grab(t, /Product\s+Reference\s+Number:\s*(\S+)/i, 0.85),
    products: (t) => {
      const p = grab(t, /Product:\s*(.+?)\s+Product\s+Reference/i);
      return p ? splitProducts(p.value).map((v) => field(v, p.evidence)) : [];
    },
    kernel: (t) => grab(t, /Kernel\s+Version:\s*(.+?)\s+(?:Approval|Dear|$)/i, 0.85),
    spec: (t) => grab(t, /D-?PAS\s+Specification\s+Version:\s*(.+?)\s+Product:/i, 0.7),
    dates: (t, base) => {
      let expiry = dateAfter(t, /Approval\s+Expiration\s+Date\s*:?/i)
        || dateAfter(t, /will\s+expire\s+on/i);
      return { issue: base.letterDate, expiry, basis: expiry ? 'Expiration date stated in letter' : '' };
    },
  },

  emvco: {
    issuer: 'EMVCo', scheme: 'EMVCo',
    category: (t) => {
      const m = t.match(/Letter\s+of\s+Approval\s*[-–]\s*(Contactless|Contact)\s+Terminal\s+Level\s*(1|2)/i);
      if (!m) return /contactless|proximity/i.test(t) ? 'EMV L1 Contactless' : 'EMV L1 Contact';
      return `EMV L${m[2]} ${/less/i.test(m[1]) ? 'Contactless' : 'Contact'}`;
    },
    approval: (t) => grab(t, /Approval\s+Number(?:\(s\))?:\s*([0-9][0-9A-Za-z.\-]*(?:\s+[0-9]{3,4}\s+[0-9]{3}\s+[0-9a-z]{2,4}\s+[0-9a-z]{2,4}\s+[A-Z]{3,6})?)/i),
    products: (t) => {
      const out = [];
      const tested = grab(t, /As\s+tested\s+in:\s*(.+?)\s+(?:Version|PCD|IFM|Analogue|Samples|$)/i);
      if (tested) out.push(...splitProducts(tested.value).map((v) => field(v, tested.evidence)));
      const term = grab(t, /Terminal:\s*(.+?)\s+(?:PinPad|PIN\s*pad|Operating|Expiry|$)/i, 0.8);
      if (term) out.push(...splitProducts(term.value).map((v) => field(v, term.evidence, 0.8)));
      return out;
    },
    kernel: (t) => grab(t, /(?:EMV\s+Application\s+Kernel|Kernel):\s*(.+?)\s+(?:Approval|The\s+EMV|$)/i, 0.8),
    spec: (t) => grab(t, /(?:Analogue|Digital)\s+Test\s+Cases:\s*(\S+)/i, 0.6),
    dates: (t, base) => {
      const issue = dateAfter(t, /(?<!(?:Expiry|Renewal|Expiration|Effective|Issue|Approval)\s)\bDate:/i, 40, 0.9) || base.letterDate;
      let expiry = dateAfter(t, /Renewal\s+Date\s*:?/i) || dateAfter(t, /Expiry\s+Date\s*:?/i);
      let basis = expiry ? 'Renewal/expiry date stated in letter' : '';
      if (!expiry && /valid\s+while\s+the\s+approval\s+number\s+is\s+posted/i.test(t)) {
        basis = 'Valid while listed on EMVCo website (no date in letter)';
      }
      return { issue, expiry, basis };
    },
  },

  interac: {
    issuer: 'Interac', scheme: 'Interac', category: () => 'EMV L2 Contactless',
    approval: (t) => grab(t, /Interac\s+approval\s+number:\s*(\S+)/i),
    products: (t) => {
      const p = grab(t, /Commercial\s+Product\s+Name:\s*(.+?)\s+Technical/i);
      return p ? splitProducts(p.value).map((v) => field(v, p.evidence)) : [];
    },
    kernel: (t) => grab(t, /Application\s+Version:\s*(\S+(?:\s+\d[\d.]*)?)/i, 0.85),
    spec: (t) => grab(t, /Technical\s+Specification\s+Version:\s*(.+?)\s+(?:EMVco|EMVCo|$)/i, 0.6),
    dates: (t) => ({
      issue: dateAfter(t, /Approval\s+date\s*:?/i),
      expiry: dateAfter(t, /Renewal\s+date\s*:?/i),
      basis: 'Renewal date stated in letter',
    }),
    l1: (t) => grab(t, /EMVco\s+Contactless\s+L1\s+(\d{4,6}\s+\d{4}\s+\d{3}\s+\S+\s+\S+\s+[A-Z]+)/i, 0.8),
  },

  jcb: {
    issuer: 'JCB', scheme: 'JCB',
    category: (t) => (/Contactless\s+IC\s+Terminal/i.test(t) ? 'EMV L2 Contactless' : 'EMV L2 Contact'),
    approval: (t) => grab(t, /JCB\s+Reference\s+Number\s*:?\s*(\S+)/i),
    products: (t) => {
      const p = grab(t, /Product\s+Marketing\s+Name\s*:?\s*(.+?)\s*(?:◆|JCB\s+Contactless|JCB\s+Contact|$)/i);
      return p ? splitProducts(p.value).map((v) => field(v, p.evidence)) : [];
    },
    kernel: (t) => grab(t, /Application\s+\(kernel\)\s+Version\s*:?\s*([\d.]+)/i, 0.7),
    dates: (t, base) => {
      // JCB prints labels and values in separate columns; the renewal date is
      // the only date in dd-Mon-yyyy form.
      let expiry = null;
      const m = t.match(new RegExp(`\\b(\\d{1,2}-${MONTH_RE}-\\d{4})\\b`, 'i'));
      if (m) expiry = field(parseDate(m[1]), `Renewal Date … ${m[1]}`, 0.85);
      else expiry = dateAfter(t, /Renewal\s+Date\s*:?/i, 60, 0.8);
      return { issue: base.letterDate, expiry, basis: expiry ? 'Renewal date stated in letter' : '' };
    },
  },

  mastercard: {
    issuer: 'Mastercard', scheme: 'Mastercard',
    category: (t) => (/Contactless/i.test(t.slice(0, 2000)) ? 'EMV L2 Contactless' : 'EMV L2 Contact'),
    approval: (t) => grab(t, /LoA\s+Identifier:\s*(\S+)/i),
    products: (t) => {
      const p = grab(t, /Product\s+Commercial\s+Name\s*:?\s*(.+?)\s+Product\s+Technical/i);
      return p ? splitProducts(p.value).map((v) => field(v, p.evidence)) : [];
    },
    kernel: (t) => grab(t, /PAYPASS_L2\s+version\s+([\d.]+)|Kernel\s+\S+\s+version\s+([\d.]+)/i, 0.85, (a, m) => clean(m[1] || m[2])),
    dates: (t, base) => {
      const expiry = dateAfter(t, /LoA\s+Expiration\s+Date\s*:?/i);
      return { issue: base.letterDate, expiry, basis: expiry ? 'LoA expiration date stated in letter' : '' };
    },
    l1: (t) => grab(t, /EMVCo\s+Contactless\s+LoA\s+Level\s+1:\s*(\d{4,6}\s+\d{4}\s+\d{3}\s+\S+\s+\S+\s+[A-Z]+)/i, 0.8),
  },

  tqm: {
    issuer: 'Mastercard', scheme: 'Mastercard TQM', category: () => 'TQM',
    approval: (t) => grab(t, /(TQM\d{3,6}\/\d{2})/i, 0.85),
    // Each component row reads "... AXIUM RX7000 1st February 2027"; every
    // product gets its own label, interface (IFM = contact, PCD = contactless)
    // and expiry.
    products: (t) => {
      const out = [];
      const seen = new Set();
      const rowRe = new RegExp(`(?:AXIUM\\s+)?([A-Z][A-Za-z]*\\/?\\d{3,5}[A-Za-z]{0,3}(?:[-\\s]CL\\d)?)\\s+(\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?\\s+\\d{4})`, 'gi');
      let m;
      while ((m = rowRe.exec(t))) {
        const before = t.slice(Math.max(0, m.index - 260), m.index);
        const labels = [...before.matchAll(/(TQM\d{3,6}\/\d{2})(?:\/\w+)?\s+\S*?(IFM|PCD)?/gi)];
        const last = labels[labels.length - 1];
        const iface = (before.match(/\b(IFM|PCD)\b(?![\s\S]*\b(?:IFM|PCD)\b)/i) || [])[1];
        const key = `${m[1].toUpperCase()}|${iface || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const f = field(m[1], m[0], 0.8);
        f.expiry = parseDate(m[2]);
        if (last) f.label = last[1];
        if (iface) f.interface = iface.toUpperCase() === 'PCD' ? 'Contactless (PCD)' : 'Contact (IFM)';
        out.push(f);
      }
      return out;
    },
    kernel: (t) => grab(t, /AC\d-(IFM|PCD)/i, 0.6, (v) => (v.toUpperCase() === 'PCD' ? 'Contactless (PCD)' : 'Contact (IFM)')),
    dates: (t) => {
      const sig = t.match(/Date:\s*\d{1,2}:\d{2}:\d{2}\s+(\d{4}\.\d{2}\.\d{2})/);
      const issue = sig ? field(parseDate(sig[1]), sig[0], 0.85) : null;
      const rows = ISSUERS.tqm.products(t).map((p) => p.expiry).filter(Boolean);
      const counts = {};
      for (const d of rows) counts[d] = (counts[d] || 0) + 1;
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      const expiry = best ? field(best[0], `TQM label expiry ${best[0]}`, 0.85) : null;
      return { issue, expiry, basis: expiry ? 'TQM label expiry from the component table' : '' };
    },
  },

  pci: {
    issuer: 'PCI SSC', scheme: 'PCI SSC', category: () => 'PCI PTS',
    approval: (t) => grab(t, /Approval\s*(?:Number)?:?\s*Number:\s*([\d-]{5,})|PTS\s+Approval\s+Number:\s*([\d-]{5,})|Number:\s*(\d-\d{4,6})/i, 0.9, (a, m) => clean(m[1] || m[2] || m[3])),
    products: (t) => {
      const p = grab(t, /Name\s*(?:&|\\&|and)\s*Model\s+Number:\s*(.+?)\s+Hardware/i);
      return p ? splitProducts(p.value).map((v) => field(v, p.evidence)) : [];
    },
    kernel: (t) => grab(t, /PTS\s+(?:POI\s+)?(?:Modular\s+Security\s+Requirements\s+)?v(?:ersion)?\s*(\d(?:\.\d)?)/i, 0.7, (v) => `v${v}`),
    dates: (t) => ({
      issue: dateAfter(t, /Effective\s+Date\s*:?/i),
      expiry: dateAfter(t, /Expiry\s+Date\s*:?/i),
      basis: 'Expiry date stated in letter',
    }),
  },

  unionpay: {
    issuer: 'UnionPay', scheme: 'UnionPay',
    category: (t) => (/contactless|quickpass/i.test(t) ? 'EMV L2 Contactless' : 'EMV L2 Contact'),
    approval: (t) => grab(t, /\b(QP-\d{2,6})\b/, 0.85) || grab(t, /\b(CUP\d{5,10})\b/, 0.75),
    products: (t) => {
      // The certificate prints its table as values then labels; the model
      // follows the certificate number.
      const m = t.match(/\bQP-\d{2,6}\s+(\S.{1,30}?)\s+(?:Certificate|Operation|Product|Kernel)/i);
      if (m && /\d{3}/.test(m[1])) return splitProducts(m[1]).map((v) => field(v, m[0], 0.8));
      // OCR noise can push labels between the number and the model; take the
      // first device-like name after the certificate number.
      const qp = t.search(/\bQP-\d{2,6}\b/);
      if (qp >= 0) {
        const d = t.slice(qp + 4, qp + 400).match(/\b(?:AXIUM\s+)?([A-Z][A-Za-z]*\/?\s?\d{3,5}[A-Za-z]{0,3}(?:[-\s]CL\d)?)\b/);
        if (d) return [field(d[0].trim(), d[0], 0.65)];
      }
      return [];
    },
    kernel: (t) => grab(t, /((?:T3\.)?EMV\.?\s*C\d+\s+version\s+[\d.]+)/i, 0.7),
    dates: (t) => {
      let issue = dateAfter(t, /Issue\s+Date\s*:?/i, 25);
      const m = t.match(/(\d{4}-\d{1,2}-\d{1,2})\s+(?:On\s+behalf[^\n]*\s+)?Issue\s+Date/i);
      if (m) issue = field(parseDate(m[1]), m[0], 0.8);
      // Scanned certificates often garble the label ("Expiry 5 = / Hate - June 18, 2029").
      const expiry = dateAfter(t, /Expiry\s+Date\s*:?/i, 60) || dateAfter(t, /Expiry\b/i, 120, 0.7);
      return { issue, expiry, basis: expiry ? 'Expiry date stated in certificate' : '' };
    },
  },

  visa: {
    issuer: 'Visa', scheme: 'Visa',
    category: (t) => (/contactless|paywave|vcps/i.test(t) ? 'EMV L2 Contactless' : 'EMV L2 Contact'),
    approval: (t) => grab(t, /(?:Approval|Reference|Letter)\s+(?:Number|No\.?|ID)\s*:?\s*([A-Z0-9][A-Z0-9.\-_/]{3,})/i, 0.8),
    products: (t) => {
      const p = grab(t, /(?:Product|Device|Terminal)\s+(?:Name|Model)\s*:?\s*(.+?)\s{2,}|\n/i, 0.7);
      return p ? splitProducts(p.value).map((v) => field(v, p.evidence, 0.7)) : [];
    },
    dates: (t, base) => {
      const expiry = dateAfter(t, /(?:Expir\w*|Valid\s+(?:until|through)|Renewal)\s*(?:Date)?\s*:?/i, 60, 0.85);
      return { issue: base.letterDate, expiry, basis: expiry ? 'Expiry date stated in letter' : '' };
    },
  },

  eftpos: {
    issuer: 'eftpos', scheme: 'eftpos', category: () => 'EMV L2 Contactless',
    dates: (t, base) => ({ issue: base.letterDate, expiry: dateAfter(t, /(?:Expir\w*|Valid\s+until|Renewal)\s*(?:Date)?\s*:?/i), basis: 'Expiry date stated in letter' }),
  },

  loe: {
    issuer: 'Manufacturer', scheme: 'Other', category: () => 'Letter of Equivalency', informational: true,
    products: (t) => {
      const out = [];
      const re = /\b([A-Z][A-Za-z]{1,10}\/\d{3,5}[A-Za-z]{0,2})\b/g;
      let m;
      const seen = new Set();
      while ((m = re.exec(t))) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        out.push(field(m[1], m[0], 0.6));
      }
      return out;
    },
    dates: (t, base) => ({ issue: base.letterDate, expiry: null, basis: 'No expiration (equivalency statement)' }),
  },

  bulletin: {
    issuer: 'Manufacturer', scheme: 'Other', category: () => 'Other', informational: true,
    products: (t) => {
      const m = t.match(/Product\s+Configuration\s+Bulletin\s*[–-]?\s*(?:IFM|PCD)?\s*([A-Z][A-Za-z]*\/?\d{3,5}\S*)/i);
      return m ? [field(m[1], m[0], 0.6)] : [];
    },
    dates: (t, base) => ({ issue: dateAfter(t, /Date:/i, 30) || base.letterDate, expiry: null, basis: 'Supporting bulletin (no expiry)' }),
  },
};

// Generic fallback for letters from bodies we have no specific rule for.
function genericParse(t) {
  const SCHEME_HINTS = [
    ['Amex', /american\s+express|expresspay/i], ['Discover', /discover|d-pas/i],
    ['Mastercard', /mastercard|paypass/i], ['Visa', /\bvisa\b|paywave/i],
    ['UnionPay', /unionpay|quickpass/i], ['JCB', /\bjcb\b/i], ['Interac', /interac/i],
    ['EMVCo', /emvco/i], ['PCI SSC', /\bpci\b/i], ['eftpos', /eftpos/i],
  ];
  let scheme = 'Other', best = 0;
  for (const [name, re] of SCHEME_HINTS) {
    const n = (t.match(new RegExp(re.source, 'gi')) || []).length;
    if (n > best) { best = n; scheme = name; }
  }
  const approval = grab(t, /(?:Approval|Certificate|Reference|LoA)\s+(?:Number|No\.?|Identifier|ID)\s*:?\s*([A-Z0-9][A-Z0-9.\-_/ ]{3,40}?)(?=\s{2}|\n|$)/i, 0.6);
  const expiry = dateAfter(t, /(?:Expir\w*|Valid\s+(?:until|through)|Renewal)\s*(?:Date)?\s*:?/i, 60, 0.7);
  const products = [];
  const p = grab(t, /(?:Product(?:\s+Name)?|Model|Device|Terminal)\s*:?\s*(.+?)(?:\s{2,}|\n|Firmware|Hardware|Version)/i, 0.5);
  if (p) products.push(...splitProducts(p.value).map((v) => field(v, p.evidence, 0.5)));
  let category = 'Other';
  if (/level\s*1|\bL1\b/i.test(t)) category = /contactless|proximity/i.test(t) ? 'EMV L1 Contactless' : 'EMV L1 Contact';
  else if (/level\s*2|\bL2\b|kernel/i.test(t)) category = /contactless/i.test(t) ? 'EMV L2 Contactless' : 'EMV L2 Contact';
  else if (/pin\s+transaction\s+security|\bPTS\b/i.test(t)) category = 'PCI PTS';
  return { scheme, issuer: scheme, approval, expiry, products, category };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function dedupeProducts(list) {
  const seen = new Set();
  const out = [];
  for (const f of list.filter(Boolean)) {
    const k = String(f.value).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/** Parse one letter's text into a structured result. */
function parseLetter(seg) {
  const t = seg.text;
  const rule = ISSUERS[seg.type];
  const base = { letterDate: letterDate(t, seg.anchor || 0) };
  let r;
  if (rule) {
    // PDF text keeps the printed line breaks, so a label and its value can
    // land on different lines. Each field is read from the text as printed
    // first, then from a copy with line breaks joined.
    const flat = t.replace(/[ \t]*\n[ \t]*/g, ' ');
    const both = (fn) => (fn ? fn(t) || (flat !== t ? fn(flat) : null) : null);
    let d = rule.dates ? rule.dates(t, base) : { issue: base.letterDate, expiry: null, basis: '' };
    if (rule.dates && !d.expiry && flat !== t) {
      const d2 = rule.dates(flat, base);
      if (d2.expiry) d = { ...d2, issue: d.issue || d2.issue };
    }
    let products = rule.products ? rule.products(t) : [];
    if (!products.length && rule.products && flat !== t) products = rule.products(flat).filter((p) => p.value.length <= 60);
    r = {
      issuer: rule.issuer,
      scheme: rule.scheme,
      category: rule.category(t),
      informational: !!rule.informational,
      approvalNumber: both(rule.approval),
      products: dedupeProducts(products),
      kernelVersion: both(rule.kernel),
      specVersion: both(rule.spec),
      issueDate: d.issue || null,
      expiryDate: d.expiry || null,
      expiryBasis: d.basis || '',
      l1Reference: both(rule.l1),
    };
  } else {
    const g = genericParse(t);
    r = {
      issuer: g.issuer, scheme: g.scheme, category: g.category, informational: false,
      approvalNumber: g.approval, products: dedupeProducts(g.products),
      kernelVersion: null, specVersion: null, issueDate: base.letterDate,
      expiryDate: g.expiry, expiryBasis: g.expiry ? 'Date found near an expiry label' : '', l1Reference: null,
    };
  }
  r.restricted = restrictedFlag(t);
  r.renewalType = /restricted\s+renewal/i.test(t) ? 'Restricted Renewal' : /[-–]\s*Renewal\b/i.test(t) ? 'Renewal' : 'Initial';
  r.type = seg.type;
  r.pageStart = seg.pageStart;
  r.pageEnd = seg.pageEnd;
  r.excerpt = clean(t).slice(0, 600);

  // Warnings the reviewer should see.
  const warnings = [];
  if (!r.informational) {
    if (!r.expiryDate) warnings.push(r.expiryBasis || 'No expiration date found');
    if (!r.products.length) warnings.push('No device/product name found');
    if (!r.approvalNumber) warnings.push('No approval number found');
    if (r.expiryDate && r.issueDate && r.expiryDate.value <= r.issueDate.value) warnings.push('Expiry is not after issue date');
    if (r.expiryBasis.startsWith('Calculated')) warnings.push('Expiry was calculated from the validity period, please confirm');
  }
  if (r.restricted) warnings.push('Restricted renewal / one-time extension wording found');
  r.warnings = warnings;

  // Extraction confidence: weighted presence of the five primary facts.
  const parts = [
    [r.scheme && r.scheme !== 'Other', 15],
    [r.category && r.category !== 'Other', 15],
    [!!r.approvalNumber, 20],
    [r.products.length > 0, 25],
    [!!r.expiryDate, 25],
  ];
  let score = parts.reduce((s, [ok, w]) => s + (ok ? w : 0), 0);
  if (r.expiryDate) score -= Math.round((1 - r.expiryDate.confidence) * 25);
  if (!rule) score = Math.min(score, 60);
  r.confidence = Math.max(0, Math.min(100, score));
  return r;
}

/** Parse a whole document (array of page texts) into letters. */
function parseDocument(pages) {
  return segmentLetters(pages).map((seg, i) => ({ index: i, ...parseLetter(seg) }));
}

module.exports = { segmentLetters, parseLetter, parseDocument, ISSUERS, STARTS };
