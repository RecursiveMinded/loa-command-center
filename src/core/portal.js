'use strict';
// Published-matrix reader. Certification portals usually show approvals as
// tables: a device column and one date column per brand, or "Version / Exp
// Date" tables for PCI and "Bulletin / L1 / TQM" tables for Level 1. This
// reads such pages (saved HTML/MHTML, or PDF via positioned text lines) into
// record candidates so a whole portal page can be imported or compared.

const { parseDate, findDates } = require('./dates');
const { normalizeScheme } = require('./taxonomy');

const BRAND_WORDS = /^(visa|master\s*card|amex|american express|discover|upi|union\s*pay|jcb|interac|eftpos|cpace|diners)$/i;

// A date the website strikes through, or masks as "XX", is expired with a restricted
// renewal: customers must request their own extension waiver. Struck HTML cells carry this mark.
const STRUCK = '[struck]';
const isWaiverCell = (s) => String(s || '').includes(STRUCK) || /(^|[^A-Za-z])XX([^A-Za-z]|$)/.test(String(s || ''));
const cellDate = (s) => parseDate(String(s || '').replace(STRUCK, ''));

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

// The page's specification table names each brand's L2 kernel version. Its columns vary by page:
//   "Mastercard Paypass   087300 0306"       (Kernel only: every number is the kernel build)
//   "Visa Paywave   2.2   070803"            (Card Version, Kernel Version)
//   "Visa Paywave   0302  002.00.012"        (Kernel Version, App Version)
// The table can continue on the next printed page under a repeated header.
// "Discover ZIP" is Discover's legacy magstripe kernel, not D-PAS: it is kept apart so it
// never takes the place of the Discover (D-PAS) kernel.
const ID = Symbol('kernel ids');
const APP = Symbol('app versions');
function kernelTable(t) {
  const out = {};
  const head = t.match(/Specification\s+(Card\s+Version\s+Kernel\s+Version|Kernel\s+Version\s+App\s+Version|Kernel(?:\s+Version)?\b)/i);
  if (!head) return out;
  const kernelLast = /^Card/i.test(head[1]);
  const appLast = /App/i.test(head[1]);
  const lines = t.slice(head.index + head[0].length).split(/\n/).slice(0, 160);
  for (const line of lines) {
    const m = line.trim().match(/^([A-Za-z][A-Za-z ]+?)\s+(\d[\d./ ]*)$/);
    if (!m) { if (/Terminal\s*&|Level\s*1\s+Certifications|^\s*Terminal\s+(Version|Visa|Bulletin)/i.test(line)) break; continue; }
    const name = m[1].trim();
    const brand = /\bzip\b/i.test(name) ? 'Discover ZIP'
      : normalizeScheme(name.replace(/\s+(paywave|paypass|expresspay|dpas|d-pas|quickpay|quickpass|speedy|flash)$/i, '').trim());
    if (Object.prototype.hasOwnProperty.call(out, brand)) continue; // a brand's first row wins
    const nums = m[2].trim().split(/\s+/);
    const kernel = kernelLast ? nums[nums.length - 1] : appLast && nums.length > 1 ? nums.slice(0, -1).join(' ') : nums.join(' ');
    if (!kernel) continue;
    out[brand] = kernel;
    (out[ID] = out[ID] || {})[brand] = kernelLast ? nums : kernel.split(' ');
    if (appLast && nums.length > 1) (out[APP] = out[APP] || {})[brand] = nums[nums.length - 1];
  }
  return out;
}

function contextFromText(text) {
  const t = String(text || '');
  const bundle = (t.match(/Kernel\s+Bundle\s+(\d+[A-Za-z]?)/i) || [])[1];
  const plat = (t.match(/kernel\s+bundle\s+(?:for|of)\s+([A-Z][A-Za-z0-9-]{1,12})/i) || [])[1];
  const kernels = kernelTable(t);
  const l2c = t.match(/EMV\s+Contact\s+kernel\s+v?([\d.]+),?\s+which\s+expires\s+on\s+([\d/.-]+)/i);
  return {
    bundle: bundle ? `Kernel Bundle ${bundle}` : '',
    platform: plat || '',
    l2Contact: l2c ? { version: l2c[1], expiry: parseDate(l2c[2]) } : null,
    kernels: kernels,
    // Every number the kernel table gives a brand (card version and kernel build), for matching letters.
    kernelIds: kernels[ID] || {},
    // The application version printed next to each kernel (pages with an App Version column).
    appVersions: kernels[APP] || {},
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
      // A device name is short and has a model number; a sentence that lands in the first column is not a row.
      if (device.length > 32 || device.split(/\s+/).length > 4 || !/\d/.test(device)) continue;
      if (/n\/?a/i.test(cells.slice(1).join(' ')) && !findDates(cells.slice(1).join(' ')).length && !cells.slice(1).some(isWaiverCell)) continue;
      if (spec.kind === 'brands') {
        const headerCells = table.find((r) => classifyHeader(r.map(cleanCell)))?.map(cleanCell) || [];
        for (const ci of spec.brandCols) {
          const d = cellDate(cells[ci]);
          const w = isWaiverCell(cells[ci]);
          if (!d && !w) continue;
          const scheme = normalizeScheme(headerCells[ci] || '');
          out.push({ ...base, device, category: 'EMV L2 Contactless', scheme, kernel_version: (ctx.kernels || {})[scheme] || '', portal_date: d, expiry_date: d, ...(w ? { restriction: 'waiver' } : {}) });
        }
      } else if (spec.kind === 'l1') {
        const l1 = cellDate(cells[spec.l1]);
        const l1w = isWaiverCell(cells[spec.l1]);
        if (l1 || l1w) out.push({ ...base, device, category: `EMV L1 ${spec.iface}`, scheme: 'EMVCo', portal_date: l1, expiry_date: l1, ...(l1w ? { restriction: 'waiver' } : {}) });
        const tqm = spec.tqm >= 0 ? cellDate(cells[spec.tqm]) : null;
        const tqmw = spec.tqm >= 0 && isWaiverCell(cells[spec.tqm]);
        if (tqm || tqmw) out.push({ ...base, device, category: 'TQM', scheme: 'Mastercard TQM', kernel_version: spec.iface === 'Contactless' ? 'Contactless (PCD)' : 'Contact (IFM)', portal_date: tqm, expiry_date: tqm, ...(tqmw ? { restriction: 'waiver' } : {}) });
      } else if (pciMode) {
        const d = cellDate(cells[spec.exp]);
        const w = isWaiverCell(cells[spec.exp]);
        const v = (cells[spec.version] || '').replace(STRUCK, '').trim();
        if (!d && !v) continue;
        out.push({ ...base, device, category: 'PCI PTS', scheme: 'PCI SSC', kernel_version: require('./taxonomy').ptsVersion(v) || v, portal_date: d, expiry_date: d, ...(w ? { restriction: 'waiver' } : {}) });
      }
    }
  }
  if (ctx.l2Contact && ctx.l2Contact.expiry) {
    out.push({ ...base, device: 'All devices', category: 'EMV L2 Contact', scheme: 'EMVCo', kernel_version: ctx.l2Contact.version, portal_date: ctx.l2Contact.expiry, expiry_date: ctx.l2Contact.expiry });
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
        const struck = /<(s|del|strike)\b|line-through/i.test(c[1] + c[2]);
        const txt = decodeEntities(c[2].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''));
        cells.push(struck && cleanCell(txt) ? `${txt} ${STRUCK}` : txt);
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

/**
 * The bundle's specification table as an HTML table:
 *   Specification | Card Version | Kernel Version      (newer pages)
 *   Specification | Kernel                              (older pages: "087300 0306")
 *   Specification | Kernel Version | App Version        (ARC pages)
 * Returns { kernels: { Brand: version }, kernelIds: { Brand: [numbers] }, l2Contact } or null.
 */
function htmlKernelTable(tables) {
  for (const t of tables) {
    const hi = t.findIndex((r) => /specification/i.test(cleanCell(r[0])));
    if (hi < 0) continue;
    const head = t[hi].map((c) => cleanCell(c).toLowerCase());
    let kc = head.findIndex((c) => /kernel\s*version/.test(c));
    if (kc < 0) kc = head.findIndex((c) => /kernel/.test(c));
    if (kc < 0) continue;
    const skip = new Set(head.map((c, i) => (/card\s*version/.test(c) ? i : -1)).filter((i) => i >= 0));
    const out = { kernels: {}, kernelIds: {}, l2Contact: null };
    for (const row of t.slice(hi + 1)) {
      const name = cleanCell(row[0]);
      const kernel = cleanCell(row[kc]);
      if (!name || !kernel || !/\d/.test(kernel)) continue;
      if (/emv\s*contact\b/i.test(name) && !/contactless/i.test(name)) { out.l2Contact = { version: kernel.split(/\s+/)[0] }; continue; }
      if (/entry\s*point/i.test(name)) continue;
      const brand = normalizeScheme(name.replace(/\s+(paywave|paypass|expresspay|dpas|d-pas|zip|quickpay|quickpass|speedy|flash|contactless)$/i, '').trim());
      if (!brand || out.kernels[brand]) continue; // Discover DPAS comes before Discover ZIP
      out.kernels[brand] = kernel;
      out.kernelIds[brand] = row.map((c, i) => (i && !skip.has(i) ? cleanCell(c) : '')).join(' ').split(/\s+/).filter((x) => /\d/.test(x));
    }
    if (Object.keys(out.kernels).length) return out;
  }
  return null;
}

function parseHtml(raw) {
  const html = mhtmlToHtml(raw);
  const ctx = contextFromText(htmlText(html));
  // The page's own title says which bundle it is ("Kernel Bundle 1 Rev 02"). Overview pages and
  // release pages ("5.xx.xx") mention bundles in passing but are not bundle pages.
  const title = ((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (title) {
    const n = (title.match(/Kernel\s+Bundle\s+(\d+[A-Za-z]?)/i) || [])[1];
    if (n) ctx.bundle = `Kernel Bundle ${n}`;
    else ctx.notBundle = title.replace(/\s*-\s*EMV LoA.*$/i, '');
  }
  const tables = htmlTables(html);
  const kt = htmlKernelTable(tables);
  if (kt) {
    ctx.kernels = { ...kt.kernels, ...ctx.kernels };
    ctx.kernelIds = { ...kt.kernelIds, ...ctx.kernelIds };
    if (!ctx.l2Contact && kt.l2Contact) ctx.l2Contact = kt.l2Contact;
  }
  return { ctx, records: tablesToRecords(tables, ctx) };
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
      const dates = rest.filter((w) => parseDate(w) || isWaiverCell(w));
      if (dates.length === width - 1) cur.push([dev, ...dates]);
    }
  }
  return { ctx, records: tablesToRecords(tables, ctx) };
}

module.exports = { isWaiverCell, parseHtml, parsePdfLines, parsePlainText, tablesToRecords, htmlTables, mhtmlToHtml, linesToTables, classifyHeader, contextFromText };
