'use strict';
// A kernel bundle is the published certification matrix of one platform at
// one moment in time: every device of the platform with its PCI, EMV contact
// (L1 + TQM) and contactless (L1 + TQM) approvals, one EMV L2 contact kernel
// shared by the whole bundle, and an L2 contactless approval per card brand.
// Each date on the published page is one cell, and each cell should be
// exactly one record: these helpers name the cells, lay records out the way
// the page does, and compare the register against a published page.

const { certHome, splitVariant } = require('./devices');

const defaultNorm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "UPP" + "Kernel Bundle 6" and "UPP" + "UPP Bundle 6" are the same bundle. */
function bundleKey(platform, bundle) {
  const p = defaultNorm(platform);
  const b = String(bundle || '');
  const n = (b.match(/\d+(?:\.\d+)?/) || [''])[0];
  const name = n || defaultNorm(b.replace(new RegExp(String(platform || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').replace(/kernel|bundle/gi, ''));
  return `${p}|${name}`;
}

const pciVersion = (v) => { const m = String(v || '').match(/\d+(?:\.\d+)?/); return m ? `v${m[0]}` : ''; };
const isContactlessTqm = (r, key) => /pcd|contactless/i.test(r.kernel_version || '') || (!/ifm|contact/i.test(r.kernel_version || '') && !!splitVariant(key).variant);

/**
 * The page cell a record fills: { section, key, row, col }.
 * Sections follow the published page: pci, contact, contactless, l2contact, l2contactless.
 * Returns null for records that are not part of the matrix (equivalency letters, other).
 */
function cellOf(r, norm = defaultNorm) {
  const k = norm(r.device);
  const cat = r.category;
  if (cat === 'PCI PTS') { const v = pciVersion(r.kernel_version); return { section: 'pci', key: `pci|${k}|${v}`, row: `${k}|${v}`, col: 'date', version: v }; }
  if (cat === 'EMV L1 Contact') { const h = certHome(k, cat); return { section: 'contact', key: `l1c|${h.key}`, row: h.key, col: 'l1' }; }
  if (cat === 'TQM') {
    if (isContactlessTqm(r, k)) { const h = certHome(k, cat); return { section: 'contactless', key: `tqmcl|${h.key}`, row: h.key, col: 'tqm' }; }
    const base = splitVariant(k).base;
    return { section: 'contact', key: `tqmc|${base}`, row: base, col: 'tqm' };
  }
  if (cat === 'EMV L1 Contactless') { const h = certHome(k, cat); return { section: 'contactless', key: `l1cl|${h.key}`, row: h.key, col: 'l1' }; }
  if (cat === 'EMV L2 Contact') return { section: 'l2contact', key: 'l2c', row: 'kernel', col: 'date' };
  if (cat === 'EMV L2 Contactless') {
    const h = certHome(k, cat);
    const brand = String(r.scheme || '').toLowerCase();
    return { section: 'l2contactless', key: `l2cl|${h.key}|${brand}`, row: h.key, col: brand };
  }
  return null;
}

// Which of several records for one cell stands for it: the one with LOAs on
// file, then the latest expiry, then the one verified most recently.
function rank(r) {
  return [r.doc_count > 0 ? 1 : 0, r.expiry_date || '', r.verified_at || '', -(r.id || 0)];
}
function better(a, b) {
  const x = rank(a), y = rank(b);
  for (let i = 0; i < x.length; i++) { if (x[i] > y[i]) return a; if (x[i] < y[i]) return b; }
  return a;
}

/**
 * Lay records out like the published page.
 * Returns { sections: { pci: rows, contact: rows, contactless: rows, l2contactless: rows }, l2contact, brands, dates, duplicates }.
 * Each row is { row, device, cells: { col: record } }.
 */
function layout(records, { norm = defaultNorm, brands: brandOrder = [] } = {}) {
  const sections = { pci: new Map(), contact: new Map(), contactless: new Map(), l2contactless: new Map() };
  let l2contact = null;
  const byKey = new Map();
  for (const r of records) {
    if (r.archived) continue;
    const c = cellOf(r, norm);
    if (!c) continue;
    if (!byKey.has(c.key)) byKey.set(c.key, []);
    byKey.get(c.key).push(r);
  }
  const duplicates = [];
  const brandSet = new Map();
  let dates = 0;
  for (const [key, list] of byKey) {
    const best = list.reduce(better);
    if (list.length > 1) duplicates.push({ key, keep: best, others: list.filter((x) => x !== best) });
    if (best.expiry_date) dates++;
    const c = cellOf(best, norm);
    if (c.section === 'l2contact') { l2contact = best; continue; }
    const m = sections[c.section];
    if (!m.has(c.row)) m.set(c.row, { row: c.row, device: c.section === 'contact' ? best.device.replace(/[\s\-_/]*CL\d+\s*$/i, '') : best.device, version: c.version || '', cells: {} });
    m.get(c.row).cells[c.col] = best;
    if (c.section === 'l2contactless' && !brandSet.has(c.col)) brandSet.set(c.col, best.scheme);
  }
  const order = (a, b) => a.device.localeCompare(b.device, undefined, { numeric: true }) || String(a.version).localeCompare(String(b.version), undefined, { numeric: true });
  const known = brandOrder.map((b) => b.toLowerCase());
  const brands = [...brandSet.entries()].sort((a, b) => {
    const ia = known.indexOf(a[0]), ib = known.indexOf(b[0]);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a[1].localeCompare(b[1]);
  }).map(([key, label]) => ({ key, label }));
  return {
    sections: Object.fromEntries(Object.entries(sections).map(([k, m]) => [k, [...m.values()].sort(order)])),
    l2contact, brands, dates, duplicates,
  };
}

/**
 * Compare the register's records for one bundle against the rows read from
 * its published page.
 *   same        the record has the page's date
 *   pageNewer   the page shows a later date than the record (renewed, record out of date)
 *   recordNewer the record has a later date than the page (website needs updating)
 *   missing     a date on the page with no record
 *   extra       a dated record whose cell is not on the page
 *   undated     a record with no expiry date (placeholder, e.g. "waiver required")
 *   duplicates  more than one record for one cell
 */
function bundleCheck(pageRows, records, { norm = defaultNorm } = {}) {
  const page = new Map();
  const blanks = [];
  for (const p of pageRows) {
    const c = cellOf(p, norm);
    if (!c) continue;
    if (!p.expiry_date) { blanks.push(p); continue; }
    page.set(c.key, { ...p, cell: c.key });
  }
  const live = records.filter((r) => !r.archived);
  const byKey = new Map();
  for (const r of live) {
    const c = cellOf(r, norm);
    if (!c) continue;
    if (!byKey.has(c.key)) byKey.set(c.key, []);
    byKey.get(c.key).push(r);
  }
  const out = { pageDates: page.size, pageBlanks: blanks.length, same: [], pageNewer: [], recordNewer: [], missing: [], extra: [], undated: [], duplicates: [] };
  for (const [key, p] of page) {
    const list = byKey.get(key) || [];
    if (!list.length) { out.missing.push(p); continue; }
    // An undated placeholder for a cell the page has a date for is filled, not added twice.
    const best = list.reduce(better);
    if (list.length > 1) out.duplicates.push({ key, keep: best, others: list.filter((x) => x !== best) });
    const cur = best.expiry_date || '';
    if (cur === p.expiry_date) out.same.push({ record: best, page: p });
    else if (!cur || p.expiry_date > cur) out.pageNewer.push({ record: best, page: p });
    else out.recordNewer.push({ record: best, page: p });
  }
  for (const [key, list] of byKey) {
    if (page.has(key)) continue;
    const dated = list.filter((r) => r.expiry_date);
    out.undated.push(...list.filter((r) => !r.expiry_date));
    if (!dated.length) continue;
    const best = dated.reduce(better);
    out.extra.push(best);
    if (dated.length > 1) out.duplicates.push({ key, keep: best, others: dated.filter((x) => x !== best) });
  }
  out.recordDates = live.filter((r) => r.expiry_date && cellOf(r, norm)).length;
  out.ok = !out.missing.length && !out.pageNewer.length && !out.recordNewer.length && !out.extra.length && !out.duplicates.length && !out.undated.length;
  return out;
}

module.exports = { bundleKey, cellOf, layout, bundleCheck, pciVersion };
