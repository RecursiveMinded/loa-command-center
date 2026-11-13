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

// PCI PTS is tracked by its single-digit version (v5, v6, v7).
const pciVersion = (v) => require('./taxonomy').ptsVersion(v);
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
  const struck = new Map(); // cells the page strikes through or shows as XX
  for (const p of pageRows) {
    const c = cellOf(p, norm);
    if (!c) continue;
    if (p.restriction === 'waiver') struck.set(c.key, p);
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
  const out = { pageDates: page.size, pageBlanks: blanks.length, same: [], pageNewer: [], recordNewer: [], missing: [], extra: [], undated: [], duplicates: [], waiver: [] };
  // Struck / XX on the page: expired with a restricted renewal (customer waiver). Flag the record.
  for (const [key, p] of struck) {
    const list = byKey.get(key) || [];
    if (!list.length) continue;
    const best = list.reduce(better);
    if (best.restriction !== 'waiver') out.waiver.push({ record: best, page: p });
  }
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
    if (page.has(key) || struck.has(key)) continue;
    const dated = list.filter((r) => r.expiry_date);
    out.undated.push(...list.filter((r) => !r.expiry_date));
    if (!dated.length) continue;
    const best = dated.reduce(better);
    out.extra.push(best);
    if (dated.length > 1) out.duplicates.push({ key, keep: best, others: dated.filter((x) => x !== best) });
  }
  out.recordDates = live.filter((r) => r.expiry_date && cellOf(r, norm)).length;
  out.ok = !out.missing.length && !out.pageNewer.length && !out.recordNewer.length && !out.extra.length && !out.duplicates.length && !out.undated.length && !out.waiver.length;
  return out;
}

// Kernel numbers are written many ways: 2.03, 0203, 02.03, v04.04, T3.EMV.C4-08.00.00. Each dotted
// number becomes its digits without leading zeros; any number on one side matching any on the other is a match.
const kernelIds = (v) => (String(v || '').match(/\d+(?:\.\d+)*/g) || []).map((t) => t.replace(/\./g, '').replace(/^0+/, '')).filter((t) => t.length >= 2);
function kernelMatches(a, b) {
  const x = kernelIds(a), y = kernelIds(b);
  if (!x.length || !y.length) return true; // cannot tell: not a mismatch
  const short = (t) => t.replace(/0+$/, '');
  return x.some((t) => y.includes(t) || (short(t) && y.some((u) => short(u) === short(t))));
}

/**
 * The kernel a bundle runs for a record's approval, from the bundle's published page:
 * the EMV contact kernel for L2 Contact, the card brand's contactless kernel for L2 Contactless.
 * Returns { kernel, ids, page } or null when the page does not say.
 */
function bundleKernel(pages, r) {
  if (!/^EMV L2/.test(r.category || '')) return null;
  const page = (pages || {})[bundleKey(r.platform, r.bundle)];
  const ctx = page && page.ctx;
  if (!ctx) return null;
  if (r.category === 'EMV L2 Contact') return ctx.l2Contact && ctx.l2Contact.version ? { kernel: ctx.l2Contact.version, ids: ctx.l2Contact.version, page } : null;
  const brand = Object.keys(ctx.kernels || {}).find((b) => b.toLowerCase() === String(r.scheme || '').toLowerCase());
  if (!brand) return null;
  return { kernel: ctx.kernels[brand], ids: ((ctx.kernelIds || {})[brand] || [ctx.kernels[brand]]).join(' '), page };
}

/** A letter or record whose kernel is not the one the bundle runs: its date does not apply to the bundle. */
function kernelMismatch(pages, r, kernel = r.kernel_version) {
  if (!kernel) return null;
  const k = bundleKernel(pages, r);
  if (!k || kernelMatches(kernel, k.ids)) return null;
  // Older bundles of a platform run older kernels: name the one this LOA's kernel fits, if its page was read.
  const plat = bundleKey(r.platform, '').split('|')[0];
  const fits = Object.entries(pages || {}).filter(([key, p]) => key.split('|')[0] === plat && p !== k.page
    && (() => { const o = bundleKernel({ [key]: p }, { ...r, platform: p.platform, bundle: p.bundle }); return o && kernelMatches(kernel, o.ids); })())
    .map(([, p]) => p.bundle).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { kernel, expected: k.kernel, platform: k.page.platform, bundle: k.page.bundle, fits: fits.join(', ') };
}

/**
 * Every bundle's brand kernels, as one set of pages for the kernel checks: the website
 * pages you read, overlaid with the kernel catalog you keep (Bundles > Kernel catalog).
 * A bundle is a snapshot of the brand kernels current when it was cut, so the same
 * kernel version often sits in several bundles of a platform.
 * Each value: { platform, bundle, rows, ctx: { l2Contact, kernels: { Brand: version }, kernelIds }, source: { Brand: 'page'|'catalog' } }.
 */
function kernelPages(settings = {}) {
  const out = {};
  for (const [key, p] of Object.entries(settings.bundlePages || {})) {
    if (!p) continue;
    const ctx = p.ctx || {};
    const kernels = { ...(ctx.kernels || {}) };
    out[key] = { platform: p.platform, bundle: p.bundle, rows: p.rows || [], filename: p.filename, at: p.at,
      ctx: { l2Contact: ctx.l2Contact || null, kernels, kernelIds: { ...(ctx.kernelIds || {}) }, appVersions: { ...(ctx.appVersions || {}) } },
      source: Object.fromEntries([...Object.keys(kernels).map((b) => [b, 'page']), ...(ctx.l2Contact && ctx.l2Contact.version ? [['EMV Contact', 'page']] : [])]) };
  }
  for (const [key, c] of Object.entries(settings.kernelCatalog || {})) {
    if (!c) continue;
    const o = out[key] || (out[key] = { platform: c.platform, bundle: c.bundle, rows: [], ctx: { l2Contact: null, kernels: {}, kernelIds: {}, appVersions: {} }, source: {} });
    if (c.l2Contact) { o.ctx.l2Contact = { ...(o.ctx.l2Contact || {}), version: c.l2Contact }; o.source['EMV Contact'] = 'catalog'; }
    for (const [b, v] of Object.entries(c.kernels || {})) {
      if (!String(v || '').trim()) continue;
      const had = Object.keys(o.ctx.kernels).find((x) => x.toLowerCase() === b.toLowerCase());
      if (had) { delete o.ctx.kernels[had]; delete o.ctx.kernelIds[had]; delete o.source[had]; }
      o.ctx.kernels[b] = String(v).trim();
      o.source[b] = 'catalog';
    }
  }
  return out;
}

const bundleNo = (b) => parseFloat((String(b || '').match(/\d+(?:\.\d+)?/) || ['0'])[0]);
const positive = (a, b) => kernelIds(a).length > 0 && kernelIds(b).length > 0 && kernelMatches(a, b);

/**
 * Every bundle that runs this kernel for the record's approval (its brand's contactless
 * kernel, or the EMV contact kernel for L2 Contact), oldest bundle first. Only bundles of
 * the record's platform count when it has one. Returns [{ key, platform, bundle, kernel }].
 */
function kernelBundles(pages, r, kernel = r.kernel_version) {
  if (!kernel || !/^EMV L2/.test(r.category || '')) return [];
  const plat = r.platform ? bundleKey(r.platform, '').split('|')[0] : '';
  const out = [];
  for (const [key, p] of Object.entries(pages || {})) {
    if (plat && key.split('|')[0] !== plat) continue;
    const k = bundleKernel({ [key]: p }, { ...r, platform: p.platform, bundle: p.bundle });
    if (k && positive(kernel, k.ids)) out.push({ key, platform: p.platform, bundle: p.bundle, kernel: k.kernel });
  }
  return out.sort((a, b) => a.platform.localeCompare(b.platform) || bundleNo(a.bundle) - bundleNo(b.bundle));
}

/**
 * The kernel the platform's newest bundle runs for this approval, when it is not this
 * kernel: the LOA is for an older kernel. Certification teams often renew an older kernel
 * for the longest term (to 2029, say) because a newer kernel is coming, so customers can
 * stay on it without paying to upgrade and recertify. That is normal, not a misread date.
 * Returns { kernel, platform, bundle } of the newest bundle, or null.
 */
function newerKernel(pages, r, kernel = r.kernel_version) {
  const fits = kernelBundles(pages, r, kernel);
  if (!fits.length) return null;
  const plat = bundleKey(fits[0].platform, '').split('|')[0];
  const all = Object.entries(pages || {}).filter(([key]) => key.split('|')[0] === plat)
    .map(([key, p]) => ({ key, p, k: bundleKernel({ [key]: p }, { ...r, platform: p.platform, bundle: p.bundle }) }))
    .filter((x) => x.k).sort((a, b) => bundleNo(a.p.bundle) - bundleNo(b.p.bundle));
  const last = all[all.length - 1];
  if (!last || fits.some((f) => f.key === last.key)) return null;
  return { kernel: last.k.kernel, platform: last.p.platform, bundle: last.p.bundle };
}

/**
 * Where an L2 LOA belongs, by its kernel: for every platform with known bundles, the bundles
 * that run this kernel for the brand (fits), those that run another one (others, with their
 * kernel) and those whose kernel is not known yet (unknown). A renewal of an older kernel
 * often lands in an older bundle, one to three bundles back from the newest.
 * Returns { kernel, platforms: [{ platform, fits, others, unknown, newest, behind }] } or null.
 */
function kernelFit(pages, { category, scheme, kernel }, allBundles = []) {
  if (!/^EMV L2/.test(category || '')) return null;
  const byPlat = new Map();
  // Bundles tracked but not in the catalog yet count as unknown.
  for (const b of allBundles) {
    if ((pages || {})[b.key]) continue;
    if (!byPlat.has(b.platform)) byPlat.set(b.platform, []);
    byPlat.get(b.platform).push({ bundle: b.bundle, kernel: '', ids: '' });
  }
  for (const [key, p] of Object.entries(pages || {})) {
    const plat = p.platform || key.split('|')[0];
    if (!byPlat.has(plat)) byPlat.set(plat, []);
    const k = bundleKernel({ [key]: p }, { category, scheme, platform: p.platform, bundle: p.bundle });
    byPlat.get(plat).push({ bundle: p.bundle || key.split('|')[1], kernel: k ? k.kernel : '', ids: k ? k.ids : '' });
  }
  const platforms = [];
  for (const [platform, list] of byPlat) {
    list.sort((a, b) => bundleNo(a.bundle) - bundleNo(b.bundle));
    const fits = kernel ? list.filter((b) => b.kernel && positive(kernel, b.ids)) : [];
    const others = list.filter((b) => b.kernel && !fits.includes(b));
    const unknown = list.filter((b) => !b.kernel).map((b) => b.bundle);
    if (!fits.length && !others.length) continue;
    const newest = [...list].reverse().find((b) => b.kernel) || null;
    // How many bundles behind the newest the LOA's newest fitting bundle is.
    const known = list.filter((b) => b.kernel);
    const behind = fits.length && newest ? known.indexOf(newest) - known.indexOf(fits[fits.length - 1]) : null;
    platforms.push({ platform, fits: fits.map((b) => b.bundle), others: others.map((b) => ({ bundle: b.bundle, kernel: b.kernel })), unknown, newest: newest ? { bundle: newest.bundle, kernel: newest.kernel } : null, behind });
  }
  platforms.sort((a, b) => b.fits.length - a.fits.length || a.platform.localeCompare(b.platform));
  return { kernel: kernel || '', platforms };
}

/** "Bundle 3, Bundle 4" from kernelBundles. */
const bundleNames = (list) => list.map((b) => b.bundle).join(', ');

/** "It fits Kernel Bundle 3", for messages about a wrong-kernel LOA. */
const fitsNote = (km) => (km && km.fits ? ` Its kernel matches ${km.platform} ${km.fits}: the date belongs on ${km.fits.includes(',') ? 'those bundles\' pages' : 'that bundle\'s page'}.` : '');

module.exports = { bundleKey, cellOf, layout, bundleCheck, pciVersion, kernelMatches, bundleKernel, kernelMismatch, fitsNote, kernelPages, kernelBundles, newerKernel, bundleNames, bundleNo, kernelFit, kernelIds };
