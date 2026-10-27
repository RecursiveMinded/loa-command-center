'use strict';
// Published-matrix reader. Certification portals usually show approvals as
// tables: a device column and one date column per brand, or "Version / Exp
// Date" tables for PCI and "Bulletin / L1 / TQM" tables for Level 1. This
// reads such pages (saved HTML/MHTML, or PDF via positioned text lines) into
// record candidates so a whole portal page can be imported or compared.

const { parseDate, findDates } = require('./dates');
const { normalizeScheme } = require('./taxonomy');

const BRAND_WORDS = /^(visa|master\s*card|amex|american express|discover|upi|union\s*pay|jcb|interac|eftpos|cpace|diners)$/i;

function cleanCell(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** Decide what kind of table a header row describes. */
function classifyHeader(cells) {
  const h = cells.map((c) => cleanCell(c).toLowerCase());
  if (!/terminal|device|model/.test(h[0] || '')) return null;
  const brands = h.map((c, i) => (BRAND_WORDS.test(c) ? i : -1)).filter((i) => i > 0);
  if (brands.length >= 2) return { kind: 'brands', brandCols: brands };
  if (h.some((c) => /l1\s*contactless/.test(c))) return { kind: 'l1', iface: 'Contactless', l1: h.findIndex((c) => /l1\s*contactless/.test(c)), tqm: h.findIndex((c) => c === 'tqm'), bulletin: h.findIndex((c) => /bulletin/.test(c)) };
  if (h.some((c) => /l1\s*contact/.test(c))) return { kind: 'l1', iface: 'Contact', l1: h.findIndex((c) => /l1\s*contact/.test(c)), tqm: h.findIndex((c) => c === 'tqm'), bulletin: h.findIndex((c) => /bulletin/.test(c)) };
  if (h.some((c) => /exp/.test(c)) && h.some((c) => /version/.test(c))) return { kind: 'versioned', version: h.findIndex((c) => /version/.test(c)), exp: h.findIndex((c) => /exp/.test(c)) };
  return null;
}

function contextFromText(text) {
  const t = String(text || '');
  const bundle = (t.match(/Kernel\s+Bundle\s+(\d+[A-Za-z]?)/i) || [])[1];
  const plat = (t.match(/kernel\s+bundle\s+(?:for|of)\s+([A-Z][A-Za-z0-9-]{1,12})/i) || [])[1];
  const l2c = t.match(/EMV\s+Contact\s+kernel\s+v?([\d.]+),?\s+which\s+expires\s+on\s+([\d/.-]+)/i);
  return {
    bundle: bundle ? `Kernel Bundle ${bundle}` : '',
    platform: plat || '',
    l2Contact: l2c ? { version: l2c[1], expiry: parseDate(l2c[2]) } : null,
  };
}

/** Convert a set of tables (arrays of rows of cells) into record candidates. */
function tablesToRecords(tables, ctx = {}) {
  const out = [];
  const base = { platform: ctx.platform || '', bundle: ctx.bundle || '' };
  for (const table of tables) {
    let spec = null;
    let pciMode = false;
    for (const row of table) {
      const cells = row.map(cleanCell);
      const hdr = classifyHeader(cells);
      if (hdr) { spec = hdr; pciMode = hdr.kind === 'versioned'; continue; }
      if (!spec || !cells[0] || /^terminal$/i.test(cells[0])) continue;
      const device = cells[0];
      if (/n\/?a/i.test(cells.slice(1).join(' ')) && !findDates(cells.slice(1).join(' ')).length) continue;
      if (spec.kind === 'brands') {
        const headerCells = table.find((r) => classifyHeader(r.map(cleanCell)))?.map(cleanCell) || [];
        for (const ci of spec.brandCols) {
          const d = parseDate(cells[ci]);
          if (!d) continue;
          out.push({ ...base, device, category: 'EMV L2 Contactless', scheme: normalizeScheme(headerCells[ci] || ''), portal_date: d, expiry_date: d });
        }
      } else if (spec.kind === 'l1') {
        const l1 = parseDate(cells[spec.l1]);
        if (l1) out.push({ ...base, device, category: `EMV L1 ${spec.iface}`, scheme: 'EMVCo', portal_date: l1, expiry_date: l1 });
        const tqm = spec.tqm >= 0 ? parseDate(cells[spec.tqm]) : null;
        if (tqm) out.push({ ...base, device, category: 'TQM', scheme: 'Mastercard TQM', kernel_version: spec.iface === 'Contactless' ? 'Contactless (PCD)' : 'Contact (IFM)', portal_date: tqm, expiry_date: tqm });
      } else if (pciMode) {
        const d = parseDate(cells[spec.exp]);
        const v = cells[spec.version] || '';
        if (!d && !v) continue;
        out.push({ ...base, device, category: 'PCI PTS', scheme: 'PCI SSC', kernel_version: v, portal_date: d, expiry_date: d });
      }
    }
  }
  if (ctx.l2Contact && ctx.l2Contact.expiry) {
    out.push({ ...base, device: 'Kernel family', category: 'Other', scheme: 'EMVCo', tags: 'Contact kernel', kernel_version: ctx.l2Contact.version, portal_date: ctx.l2Contact.expiry, expiry_date: ctx.l2Contact.expiry });
  }
  return out;
}

// --------------------------------------------------------------- HTML input
function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

/** MHTML is MIME; pull out the HTML part and undo quoted-printable encoding. */
function mhtmlToHtml(raw) {
  const s = String(raw);
  if (!/^MIME-Version|Content-Type:\s*multipart\/related/im.test(s.slice(0, 2000))) return s;
  const parts = s.split(/\r?\n--[^\r\n]+\r?\n/);
  const htmlPart = parts.find((p) => /Content-Type:\s*text\/html/i.test(p)) || s;
  const bodyStart = htmlPart.search(/\r?\n\r?\n/);
  let body = bodyStart >= 0 ? htmlPart.slice(bodyStart) : htmlPart;
  if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(htmlPart)) {
    body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    try { body = Buffer.from(body, 'latin1').toString('utf8'); } catch (_) { /* keep as is */ }
  }
  return body;
}

function htmlTables(html) {
  const tables = [];
  const tre = /<table[\s\S]*?<\/table>/gi;
  let m;
  while ((m = tre.exec(html))) {
    const rows = [];
    const rre = /<tr[\s\S]*?<\/tr>/gi;
    let r;
    while ((r = rre.exec(m[0]))) {
      const cells = [];
      const cre = /<t[hd]([^>]*)>([\s\S]*?)<\/t[hd]>/gi;
      let c;
      while ((c = cre.exec(r[0]))) {
        const span = Number((c[1].match(/colspan\s*=\s*"?(\d+)/i) || [])[1] || 1);
        const txt = decodeEntities(c[2].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''));
        cells.push(txt);
        for (let k = 1; k < span; k++) cells.push('');
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function htmlText(html) {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
}

function parseHtml(raw) {
  const html = mhtmlToHtml(raw);
  const ctx = contextFromText(htmlText(html));
  return { ctx, records: tablesToRecords(htmlTables(html), ctx) };
}

// ---------------------------------------------------------------- PDF input
/**
 * Rebuild table rows from positioned text lines (pdf.js). `lines` is
 * [{ y, items: [{ x, str }] }] per page. Column positions come from each
 * header row, so a blank cell stays blank instead of shifting dates left.
 */
function linesToTables(pages) {
  const tables = [];
  let current = null, cols = null;
  for (const lines of pages) {
    for (const line of lines) {
      const items = line.items.filter((i) => cleanCell(i.str)).sort((a, b) => a.x - b.x);
      if (!items.length) continue;
      const texts = items.map((i) => cleanCell(i.str));
      if (classifyHeader(texts)) {
        cols = items.map((i) => i.x);
        current = [texts];
        tables.push(current);
        continue;
      }
      if (!current || !cols) continue;
      const first = texts[0];
      if (!/\d/.test(first) || findDates(first).length) {
        // A row starts with a device name; anything else ends the table.
        if (!/^[A-Za-z]/.test(first)) { current = null; continue; }
      }
      const row = new Array(cols.length).fill('');
      for (const it of items) {
        let best = 0, dist = Infinity;
        cols.forEach((cx, ci) => { const d = Math.abs(cx - it.x); if (d < dist) { dist = d; best = ci; } });
        row[best] = row[best] ? `${row[best]} ${cleanCell(it.str)}` : cleanCell(it.str);
      }
      current.push(row);
    }
  }
  return tables;
}

function parsePdfLines(pages, fullText) {
  const ctx = contextFromText(fullText || pages.map((ls) => ls.map((l) => l.items.map((i) => i.str).join(' ')).join('\n')).join('\n'));
  return { ctx, records: tablesToRecords(linesToTables(pages), ctx) };
}

/**
 * Plain text fallback: only rows whose date count equals the column count are
 * trusted, because blank cells cannot be located without positions.
 */
function parsePlainText(text) {
  const ctx = contextFromText(text);
  const tables = [];
  let cur = null, width = 0;
  for (const raw of String(text).split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const words = line.split(/\s+/);
    let header = null;
    if (/^terminal\b/i.test(line)) {
      const brandsRow = ['Terminal', ...words.slice(1)];
      header = classifyHeader(brandsRow) ? brandsRow
        : /bulletin/i.test(line) ? ['Terminal', 'Bulletin', /contactless/i.test(line) ? 'L1 Contactless' : 'L1 Contact', 'TQM']
          : /exp/i.test(line) ? ['Terminal', 'Version', 'Exp Date'] : null;
    }
    if (header) { cur = [header]; width = header.length; tables.push(cur); continue; }
    if (!cur) continue;
    if (!/^[A-Za-z][\w/]*\d/.test(words[0])) { cur = null; continue; }
    const dev = words[0];
    const rest = words.slice(1);
    if (cur[0][1] === 'Bulletin') {
      // "Lane/3000 - 07/12/28 02/01/27": bulletin dash, L1 date, TQM date
      const dates = rest.filter((w) => parseDate(w));
      if (dates.length >= 1) cur.push([dev, '-', dates[0], dates[1] || '']);
    } else if (cur[0][1] === 'Version') {
      cur.push([dev, rest[0] && /^v\d/i.test(rest[0]) ? rest[0] : '', rest.find((w) => parseDate(w)) || '']);
    } else {
      const dates = rest.filter((w) => parseDate(w));
      if (dates.length === width - 1) cur.push([dev, ...dates]);
    }
  }
  return { ctx, records: tablesToRecords(tables, ctx) };
}

module.exports = { parseHtml, parsePdfLines, parsePlainText, tablesToRecords, htmlTables, mhtmlToHtml, linesToTables, classifyHeader, contextFromText };
