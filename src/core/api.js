'use strict';
// One API surface for the UI. Electron exposes it over IPC; the dev server
// exposes the same methods over HTTP for browser testing.

const fs = require('fs');
const path = require('path');
const { Database } = require('./db');
const { Store } = require('./store');
const { Intake } = require('./intake');
const engine = require('./engine');
const reports = require('./reports');
const { importTracker, mergeRecords } = require('./importer');
const portal = require('./portal');
const { LocalAI } = require('./ai');
const { todayIso, addDays } = require('./dates');
const { daysRemaining, effectiveStage, health, windowFor, coverage } = require('./lifecycle');
const taxonomy = require('./taxonomy');
const { sampleRecords } = require('./sample');
const schedule = require('./schedule');

const VERSION = require('../../package.json').version;
// Card brands whose L2 contactless approval a reader needs (US market by default; editable in Settings).
/** Other devices a record's LOA also certifies (its "Covers devices" list). */
function coveredDevices(r) { return String(r.covers || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean); }

const DEFAULT_BRANDS = ['Visa', 'Mastercard', 'Amex', 'Discover', 'UnionPay', 'JCB', 'Interac'];

/** Edit distance (one swap of neighbouring letters counts as one). */
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Counts of a bundle check, for lists and banners. */
function summarizeCheck(c) {
  return {
    pageDates: c.pageDates, recordDates: c.recordDates, ok: c.ok,
    same: c.same.length, pageNewer: c.pageNewer.length, recordNewer: c.recordNewer.length, missing: c.missing.length,
    extra: c.extra.length, undated: c.undated.length, duplicates: c.duplicates.reduce((n, d) => n + d.others.length, 0),
  };
}

/** The rows of a bundle check, small enough to send to the screen. */
function checkDetails(c) {
  const rec = (r) => ({ id: r.id, device: r.device, category: r.category, scheme: r.scheme, kernel_version: r.kernel_version || '', expiry_date: r.expiry_date || null, approval_number: r.approval_number || '', doc_count: r.doc_count || 0, notes: r.notes || '' });
  const pg = (p) => ({ device: p.device, category: p.category, scheme: p.scheme, kernel_version: p.kernel_version || '', expiry_date: p.expiry_date });
  return {
    missing: c.missing.map(pg),
    pageNewer: c.pageNewer.map((x) => ({ record: rec(x.record), page: x.page.expiry_date })),
    recordNewer: c.recordNewer.map((x) => ({ record: rec(x.record), page: x.page.expiry_date })),
    duplicates: c.duplicates.map((d) => ({ keep: rec(d.keep), others: d.others.map(rec) })),
    undated: c.undated.map(rec), extra: c.extra.map(rec),
  };
}

class AppApi {
  static async create({ dataDir, actor = '' }) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbFile = path.join(dataDir, 'loa.db');
    // Keep the file as it was before this version opens (and migrates) it.
    const before = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;
    const db = await Database.open(dbFile);
    const api = new AppApi(db, dataDir, actor);
    api.upgradeBackup(before);
    api.autoBackup();
    return api;
  }

  constructor(db, dataDir, actor) {
    this.db = db;
    this.dataDir = dataDir;
    this.store = new Store(db, { actor });
    this.archiveDir = dataDir ? path.join(dataDir, 'LOA Documents') : null;
    this.backupDir = dataDir ? path.join(dataDir, 'Backups') : null;
    this.intake = new Intake(this.store, { archiveDir: this.archiveDir });
    this.ai = new LocalAI(() => this.store.getSettings());
    const s = this.store.getSettings();
    if (!actor && s.userName) this.store.actor = s.userName;
  }

  // ------------------------------------------------------------------ meta
  info() {
    return { version: VERSION, dataDir: this.dataDir, archiveDir: this.archiveDir, backupDir: this.backupDir, taxonomy: {
      categories: taxonomy.CATEGORIES, schemes: taxonomy.SCHEMES, stages: taxonomy.STAGES,
      dispositions: taxonomy.DISPOSITIONS, portalStatuses: taxonomy.PORTAL_STATUSES, renewalPaths: taxonomy.RENEWAL_PATHS,
    } };
  }

  getSettings() { return this.store.getSettings(); }

  setSettings(patch) {
    const s = this.store.setSettings(patch);
    if (patch.userName) this.store.actor = patch.userName;
    if (patch.noiseWords) this.intake.rematch();
    return s;
  }

  // --------------------------------------------------------------- records
  decorate(r, asOf = todayIso()) {
    const days = daysRemaining(r, asOf);
    return { ...r, days, stageNow: effectiveStage(r, asOf), health: health(r, asOf), window: windowFor(days).key };
  }

  listRecords() {
    const asOf = todayIso();
    return this.store.listRecords().map((r) => this.decorate(r, asOf));
  }

  getRecord(id) {
    const r = this.store.getRecord(id);
    if (!r) return null;
    const approvals = this.store.approvals(id);
    const current = approvals.find((a) => a.role === 'current');
    const replacement = approvals.find((a) => a.role === 'replacement');
    return {
      record: this.decorate(r),
      approvals,
      documents: this.store.documentsFor(id).map(({ stored_path: p, ...d }) => ({ ...d, missing: !p || !fs.existsSync(p) })),
      audit: this.store.auditLog({ recordId: id, limit: 200 }),
      coverage: replacement ? coverage(r.expiry_date || (current && current.expiry_date), replacement.issue_date) : null,
    };
  }

  saveRecord(id, patch) {
    if (id) {
      this.store.updateRecord(id, patch, { source: 'manual' });
      return this.getRecord(id);
    }
    const r = this.store.createRecord(patch, { source: 'manual' });
    return this.getRecord(r.id);
  }

  /** Deleting moves records to the Archive. */
  deleteRecord(id) { return this.store.deleteRecord(id); }
  /** Move several records to the Archive. Returns how many moved. */
  deleteRecords(ids) { return this.store.archiveRecords(ids, { reason: 'Deleted' }); }

  bulkUpdate(ids, patch, tags = null) {
    const p = { ...(patch || {}) };
    if (p.archived) return { changed: this.store.archiveRecords(ids, { reason: 'Archived' }), skipped: [] };
    delete p.archived;
    return this.store.bulkUpdate(ids, p, { source: 'manual' }, tags);
  }

  /** Accept the expiration of certifications (end of life, not renewing), or track them again with an empty reason. */
  setEol(ids, reason = 'Not renewing') {
    return this.store.bulkUpdate(ids || [], { eol: String(reason || '').trim() }, { source: 'manual' }).changed;
  }

  // ----------------------------------------------------------------- archive
  listArchive(q = '') { return this.store.listArchive({ q }); }
  archiveCount() { return this.db.get('SELECT COUNT(*) n FROM archive').n; }
  /** Records past their expiry date, for the Archive page's "Move expired records here". */
  expiredRecords() { return this.store.expiredRecords(); }
  archiveExpired() { return this.store.archiveRecords(this.store.expiredRecords().map((r) => r.id), { reason: 'Expired' }); }
  restoreArchived(ids) { return this.store.restoreArchived(ids); }
  /** The only permanent delete in the app. */
  purgeArchived(ids) { return this.store.purgeArchived(ids); }

  listTags() { return this.store.allTags(); }

  /** Every device name in the register, archived ones included, with how many records use it. */
  knownDevices() {
    const by = new Map();
    for (const r of this.store.listRecords()) {
      const k = this.store.norm()(r.device);
      const e = by.get(k) || { device: r.device, records: 0, archived: 0, schemes: new Set() };
      e.records++; if (r.archived) e.archived++; e.schemes.add(r.scheme);
      by.set(k, e);
    }
    // Archived records still teach the app their device names.
    for (const r of this.db.all('SELECT device, scheme FROM archive')) {
      const k = this.store.norm()(r.device);
      const e = by.get(k) || { device: r.device, records: 0, archived: 0, schemes: new Set() };
      e.records++; e.archived++; e.schemes.add(r.scheme);
      by.set(k, e);
    }
    return [...by.values()].map((e) => ({ ...e, schemes: [...e.schemes].filter(Boolean).sort() }))
      .sort((a, b) => a.device.localeCompare(b.device, undefined, { numeric: true }));
  }

  // --------------------------------------------------------------- coverage
  /**
   * Group records into the parts of each device. A CL suffix names a hardware
   * version (a name without one is the first version, CL1). PCI and the
   * contact approvals are one shared part per device; each version is its
   * own part holding L1 Contactless, TQM and L2 per brand. A device with no
   * contactless side keeps TQM in its shared part. `homes(r, device)` lists
   * the platform/bundle groups a record counts in. Older versions are marked
   * as replaced by the next one.
   */
  deviceParts(recs, homes) {
    const { certHome, splitVariant, baseDisplayName } = require('./devices');
    const n = this.store.norm();
    const cless = new Set();
    for (const r of recs) {
      for (const d of [r.device, ...coveredDevices(r)]) {
        const sv = splitVariant(n(d));
        if (sv.base && (sv.variant || /Contactless/.test(r.category))) cless.add(sv.base);
      }
    }
    const parts = new Map();
    const part = (grp, h, home, fallback) => {
      const k = `${grp}||${home.key}`;
      if (!parts.has(k)) {
        parts.set(k, { grp, platform: h.platform || '', bundle: h.bundle || '', key: home.key, base: home.base, version: home.version,
          cless: cless.has(home.base), names: new Map(), fallback, records: [] });
      }
      return parts.get(k);
    };
    const add = (h, r, device, shared) => {
      const key = n(device);
      if (!key) return;
      let home = certHome(key, r.category);
      if (r.category === 'TQM' && !cless.has(home.base)) home = { base: home.base, version: '', key: home.base };
      const grp = [h.platform, h.bundle].filter(Boolean).join(' · ') || 'Unassigned';
      const p = part(grp, h, home, home.version ? device : baseDisplayName(device));
      if (!shared) p.names.set(device, (p.names.get(device) || 0) + 1);
      p.records.push(shared ? { ...r, sharedFrom: r.device } : r);
    };
    for (const r of recs) for (const h of homes(r, r.device)) add(h, r, r.device, false);
    // One LOA can certify a series of devices sharing a reader: it counts for each.
    for (const r of recs) for (const dev of coveredDevices(r)) if (n(dev) !== n(r.device)) for (const h of homes(r, dev)) add(h, r, dev, true);
    // Every version belongs to a device whose shared part (PCI, contact) is required too.
    for (const p of [...parts.values()]) if (p.version) part(p.grp, p, { base: p.base, version: '', key: p.base }, baseDisplayName(p.fallback));
    const pick = (p, ok) => [...p.names.entries()].filter(([d]) => ok(n(d))).sort((a, b) => b[1] - a[1])[0];
    for (const p of parts.values()) {
      if (!p.version) {
        const hit = pick(p, (k) => k === p.base);
        p.device = hit ? hit[0] : baseDisplayName((pick(p, () => true) || [p.fallback])[0]);
        p.label = p.device;
      } else {
        const exact = pick(p, (k) => k === p.key);
        const bare = pick(p, (k) => k === p.base);
        // CL1 named by the bare device name: records are created under that name.
        p.device = exact ? exact[0] : bare ? bare[0] : p.fallback;
        p.label = n(p.device) === p.key ? p.device : `${p.device} (${p.version})`;
      }
    }
    // Hardware versions in order: each older version is replaced by the next.
    const byBase = new Map();
    for (const p of parts.values()) if (p.version) { const k = `${p.grp}||${p.base}`; if (!byBase.has(k)) byBase.set(k, []); byBase.get(k).push(p); }
    for (const list of byBase.values()) {
      list.sort((a, b) => Number(a.version.slice(2)) - Number(b.version.slice(2)));
      list.forEach((p, i) => { p.replacedBy = list[i + 1] ? list[i + 1].label : ''; p.newest = list[list.length - 1].version; });
    }
    return [...parts.values()];
  }

  /** The certifications a part needs: shared PCI and contact (plus TQM without a contactless side), or a version's contactless set. */
  partSlots(p) {
    const { contact, reader } = this.coverageSlots();
    return p.version ? reader : p.cless ? contact.filter((c) => c.key !== 'tqm') : contact;
  }

  /**
   * What each device needs to be certified: the shared part (PCI, L1 and L2
   * Contact) and each hardware version (L1 Contactless, TQM, L2 Contactless
   * from every required brand). Each cell holds the record that covers it,
   * or is missing / not applicable / end of life.
   */
  deviceCoverage() {
    const { contact, reader, brands, na } = this.coverageSlots();
    const { splitVariant } = require('./devices');
    const n = this.store.norm();
    const recs = this.listRecords();
    // Records with no platform or bundle (often created from an LOA) join the
    // device's real bundle rather than repeating its gaps in "Unassigned".
    const placed = (r) => r.platform || r.bundle;
    const baseOf = (d) => splitVariant(n(d)).base;
    const groupsOf = new Map();
    for (const r of recs) {
      if (!placed(r)) continue;
      const k = baseOf(r.device);
      if (!groupsOf.has(k)) groupsOf.set(k, new Map());
      groupsOf.get(k).set(`${r.platform}|${r.bundle}`, { platform: r.platform || '', bundle: r.bundle || '' });
    }
    const homes = (r, device) => {
      if (placed(r)) return [r];
      const g = [...((groupsOf.get(baseOf(device)) || new Map()).values())];
      return g.length ? g : [r];
    };
    // A live approval beats one accepted as end of life, then the later expiry wins.
    const better = (a, b) => (!b || (!!b.eol > !!a.eol) || (!!a.eol === !!b.eol && (a.days ?? -1e9) > (b.days ?? -1e9)) ? a : b);
    const rows = [];
    let missing = 0;
    for (const d of this.deviceParts(recs, homes)) {
      const slots = new Set(this.partSlots(d).map((x) => x.key));
      // Every certification of this part is end of life: its gaps no longer matter.
      const retired = d.records.length > 0 && d.records.every((r) => r.eol);
      const cells = {};
      for (const slot of [...contact, ...reader]) {
        const needed = slots.has(slot.key);
        const hits = needed ? d.records.filter((r) => r.category === slot.category && (!slot.scheme || String(r.scheme).toLowerCase() === slot.scheme.toLowerCase())) : [];
        const rec = hits.reduce((b, r) => better(r, b), null);
        const isNa = retired || (na[d.key] || []).includes(slot.key);
        const status = rec ? (rec.eol ? 'eol' : rec.expiry_date ? 'ok' : 'nodate') : isNa && needed ? 'na' : needed ? 'missing' : 'none';
        if (status === 'missing') missing++;
        cells[slot.key] = { status, record: rec ? { id: rec.id, expiry_date: rec.expiry_date, days: rec.days, health: rec.health, approval_number: rec.approval_number, scheme: rec.scheme, eol: rec.eol || '', category: rec.category, sharedFrom: rec.sharedFrom || '' } : null };
      }
      rows.push({ grp: d.grp, platform: d.platform, bundle: d.bundle, device: d.device, label: d.label, key: d.key, base: d.base, version: d.version,
        reader: !!d.version, replacedBy: d.replacedBy || '', retired, missing: Object.values(cells).filter((c) => c.status === 'missing').length, cells });
    }
    const order = (r) => `${r.base}|${r.version ? Number(r.version.slice(2)) + 1 : 0}`;
    rows.sort((a, b) => a.grp.localeCompare(b.grp, undefined, { numeric: true }) || order(a).localeCompare(order(b), undefined, { numeric: true }));
    return { columns: [...contact, ...reader].map(({ key, label, group }) => ({ key, label, group })), rows, missing, brands };
  }

  /** Level 3 enablement sheet (Excel): every device's approval numbers, optionally for one platform and bundle. */
  exportL3Sheet({ platform = '', bundle = '' } = {}) {
    const cov = this.deviceCoverage();
    cov.rows = cov.rows.filter((r) => (!platform || r.platform === platform) && (!bundle || r.bundle === bundle));
    // The EMV L2 contact kernel is one approval for the whole bundle: every device of the bundle lists it.
    const { bundleKey } = require('./bundles');
    const kernel = new Map();
    for (const g of this.bundleGroups().values()) {
      const k = g.records.filter((r) => r.category === 'EMV L2 Contact').sort((a, b) => String(b.expiry_date || '').localeCompare(String(a.expiry_date || '')))[0];
      if (k) kernel.set(g.key, k);
    }
    const i = cov.columns.findIndex((c) => c.key === 'l1c');
    cov.columns.splice(i + 1, 0, { key: 'l2c', label: 'L2 Contact', group: 'Bundle' });
    for (const r of cov.rows) {
      const k = r.reader ? null : kernel.get(bundleKey(r.platform, r.bundle));
      r.cells.l2c = { status: k ? 'ok' : 'none', record: k ? { id: k.id, expiry_date: k.expiry_date, approval_number: k.approval_number || (k.kernel_version ? `Kernel ${k.kernel_version}` : ''), eol: k.eol || '' } : null };
    }
    return reports.exportL3Sheet(cov);
  }

  // ---------------------------------------------------------------- bundles
  /** Records grouped by bundle ("UPP" + "Kernel Bundle 6" = "UPP" + "UPP Bundle 6"). */
  bundleGroups() {
    const { bundleKey } = require('./bundles');
    const groups = new Map();
    for (const r of this.listRecords()) {
      if (!r.platform && !r.bundle) continue;
      const k = bundleKey(r.platform, r.bundle);
      if (!groups.has(k)) groups.set(k, { key: k, names: {}, platforms: {}, records: [] });
      const g = groups.get(k);
      g.records.push(r);
      g.names[r.bundle || ''] = (g.names[r.bundle || ''] || 0) + 1;
      g.platforms[r.platform || ''] = (g.platforms[r.platform || ''] || 0) + 1;
    }
    const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0][0];
    for (const g of groups.values()) { g.bundle = top(g.names); g.platform = top(g.platforms); }
    return groups;
  }

  /** Every bundle: how many dates it holds, and how it compares with its published page. */
  listBundles() {
    const { bundleCheck } = require('./bundles');
    const pages = this.store.getSettings().bundlePages || {};
    const norm = this.store.norm();
    const out = [];
    const groups = this.bundleGroups();
    for (const k of Object.keys(pages)) if (!groups.has(k)) groups.set(k, { key: k, bundle: pages[k].bundle, platform: pages[k].platform, records: [] });
    for (const g of groups.values()) {
      const page = pages[g.key];
      const check = page ? bundleCheck(page.rows, g.records, { norm }) : null;
      out.push({
        key: g.key, platform: g.platform, bundle: g.bundle, records: g.records.length,
        dates: g.records.filter((r) => r.expiry_date && require('./bundles').cellOf(r, norm)).length,
        page: page ? { filename: page.filename, at: page.at, dates: check.pageDates } : null,
        issues: check ? summarizeCheck(check) : null,
      });
    }
    return out.sort((a, b) => a.platform.localeCompare(b.platform) || a.bundle.localeCompare(b.bundle, undefined, { numeric: true }));
  }

  /** One bundle laid out like its published page, with each cell's difference from that page. */
  bundleView(key) {
    const { layout, bundleCheck, cellOf } = require('./bundles');
    const norm = this.store.norm();
    const g = this.bundleGroups().get(key);
    const page = (this.store.getSettings().bundlePages || {})[key];
    const records = g ? g.records : [];
    const brands = this.coverageSlots().brands;
    const view = layout(records, { norm, brands });
    const check = page ? bundleCheck(page.rows, records, { norm }) : null;
    const diff = {};
    if (check) {
      for (const x of check.pageNewer) diff[x.record.id] = { kind: 'pageNewer', page: x.page.expiry_date };
      for (const x of check.recordNewer) diff[x.record.id] = { kind: 'recordNewer', page: x.page.expiry_date };
      for (const r of check.extra) diff[r.id] = { kind: 'extra' };
    }
    const cell = (r) => (r ? { id: r.id, expiry_date: r.expiry_date, health: r.health, days: r.days, approval_number: r.approval_number, eol: r.eol || '', kernel_version: r.kernel_version || '', doc_count: r.doc_count, diff: diff[r.id] || null } : null);
    const rows = (list) => list.map((row) => ({ row: row.row, device: row.device, version: row.version, cells: Object.fromEntries(Object.entries(row.cells).map(([k, r]) => [k, cell(r)])) }));
    const sections = Object.fromEntries(Object.entries(view.sections).map(([k, v]) => [k, rows(v)]));
    // Dates on the page that the register does not have yet sit in their cells, marked missing.
    const missing = check ? check.missing.map((p) => ({ ...cellOf(p, norm), device: p.device, scheme: p.scheme, category: p.category, expiry_date: p.expiry_date, kernel_version: p.kernel_version || '' })) : [];
    let l2missing = null;
    for (const m of missing) {
      if (m.section === 'l2contact') { l2missing = m; continue; }
      const list = sections[m.section];
      let row = list.find((x) => x.row === m.row);
      if (!row) { row = { row: m.row, device: m.section === 'contact' ? m.device.replace(/[\s\-_/]*CL\d+\s*$/i, '') : m.device, version: m.version || '', cells: {} }; list.push(row); }
      row.cells[m.col] = { missing: true, page: m.expiry_date };
      if (m.section === 'l2contactless' && !view.brands.some((b) => b.key === m.col)) view.brands.push({ key: m.col, label: m.scheme });
    }
    for (const list of Object.values(sections)) list.sort((a, b) => a.device.localeCompare(b.device, undefined, { numeric: true }) || String(a.version).localeCompare(String(b.version), undefined, { numeric: true }));
    return {
      key, platform: g ? g.platform : page ? page.platform : '', bundle: g ? g.bundle : page ? page.bundle : '',
      sections, l2missing,
      l2contact: cell(view.l2contact), l2contactKernel: view.l2contact ? view.l2contact.kernel_version || '' : (page && page.ctx && page.ctx.l2Contact ? page.ctx.l2Contact.version : ''),
      brands: view.brands, dates: view.dates, duplicates: view.duplicates.length,
      page: page ? { filename: page.filename, at: page.at, dates: check.pageDates, blanks: check.pageBlanks } : null,
      issues: check ? summarizeCheck(check) : null, missing,
    };
  }

  /**
   * Read a bundle's published page (saved HTML, or a PDF's positioned lines)
   * and compare it with the register. The page is kept so the comparison
   * stays visible; nothing in the register changes until cleanBundle.
   */
  readBundlePage({ filename = 'page', text, bytes, lines }) {
    const { bundleKey, bundleCheck } = require('./bundles');
    const lower = filename.toLowerCase();
    let parsed;
    if (bytes && /\.(html?|mhtml?|mht)$/.test(lower)) parsed = portal.parseHtml(Buffer.from(bytes).toString('latin1'));
    else if (lines && lines.length) parsed = portal.parsePdfLines(lines, text);
    else parsed = portal.parsePlainText(text || '');
    const ctx = parsed.ctx || {};
    if (!ctx.platform && !ctx.bundle) throw new Error('The page does not say which platform and bundle it is for. Check that it is a kernel bundle page.');
    const key = bundleKey(ctx.platform, ctx.bundle);
    const g = this.bundleGroups().get(key);
    const rows = parsed.records.map((r) => ({ device: r.device, category: r.category, scheme: r.scheme, kernel_version: r.kernel_version || '', expiry_date: r.expiry_date || null }));
    const pages = { ...(this.store.getSettings().bundlePages || {}) };
    pages[key] = { filename, at: new Date().toISOString(), platform: g ? g.platform : ctx.platform, bundle: g ? g.bundle : ctx.bundle, ctx: { l2Contact: ctx.l2Contact || null }, rows };
    this.store.setSettings({ bundlePages: pages });
    const check = bundleCheck(rows, g ? g.records : [], { norm: this.store.norm() });
    return { key, filename: pages[key].filename, platform: pages[key].platform, bundle: pages[key].bundle, ...summarizeCheck(check), details: checkDetails(check) };
  }

  /** The differences between a bundle and its page, listed for review. */
  bundleDifferences(key) {
    const { bundleCheck } = require('./bundles');
    const page = (this.store.getSettings().bundlePages || {})[key];
    if (!page) return null;
    const g = this.bundleGroups().get(key);
    const check = bundleCheck(page.rows, g ? g.records : [], { norm: this.store.norm() });
    return { key, platform: page.platform, bundle: page.bundle, filename: page.filename, at: page.at, ...summarizeCheck(check), details: checkDetails(check) };
  }

  /**
   * Make a bundle match its published page. `fix` picks what to do:
   *   missing      add a record for each date on the page the register lacks
   *   pageNewer    take the page's later date (the record is out of date)
   *   recordNewer  keep the record's later date and mark the website as needing the change
   *   duplicates   keep the best record of each cell (LOAs move to it), archive the rest
   *   undated      archive records with no expiry date (placeholders such as "waiver required")
   *   extra        archive dated records whose cell is not on the page
   */
  cleanBundle(key, fix = {}) {
    const { bundleCheck } = require('./bundles');
    const page = (this.store.getSettings().bundlePages || {})[key];
    if (!page) throw new Error('Read the bundle page first');
    const g = this.bundleGroups().get(key);
    const check = bundleCheck(page.rows, g ? g.records : [], { norm: this.store.norm() });
    const src = `Website page: ${page.filename}`;
    const platform = g ? g.platform : page.platform, bundle = g ? g.bundle : page.bundle;
    const done = { added: 0, updated: 0, flagged: 0, merged: 0, archived: 0 };
    this.backup('before-bundle-cleanup');
    this.db.tx(() => {
      if (fix.duplicates) {
        for (const d of check.duplicates) {
          for (const o of d.others) {
            for (const doc of this.store.documentsFor(o.id)) this.store.linkDocument(doc.id, d.keep.id);
          }
          done.merged += this.store.archiveRecords(d.others.map((o) => o.id), { reason: `Duplicate of record ${d.keep.id} (bundle clean-up)` });
        }
      }
      if (fix.missing) {
        for (const p of check.missing) {
          this.store.createRecord({ ...p, platform, bundle, portal_date: p.expiry_date, portal_status: 'In Sync', expiry_basis: 'Published on the bundle page' }, { source: src, note: 'Added from the bundle page' });
          done.added++;
        }
      }
      if (fix.pageNewer) {
        for (const x of check.pageNewer) {
          this.store.updateRecord(x.record.id, { expiry_date: x.page.expiry_date, portal_date: x.page.expiry_date, portal_status: 'In Sync', expiry_basis: 'Published on the bundle page' }, { source: src });
          done.updated++;
        }
      }
      if (fix.recordNewer) {
        for (const x of check.recordNewer) {
          this.store.updateRecord(x.record.id, { portal_date: x.page.expiry_date, portal_status: 'Change Needed' }, { source: src });
          done.flagged++;
        }
      }
      if (fix.undated) done.archived += this.store.archiveRecords(check.undated.map((r) => r.id), { reason: 'No expiry date; not a date on the bundle page (bundle clean-up)' });
      if (fix.extra) done.archived += this.store.archiveRecords(check.extra.map((r) => r.id), { reason: 'Not on the bundle page (bundle clean-up)' });
      for (const x of check.same) if (x.record.portal_date !== x.page.expiry_date) this.store.updateRecord(x.record.id, { portal_date: x.page.expiry_date, portal_status: 'In Sync' }, { source: src });
      // The page names each brand's L2 kernel version: fill it where the record has none.
      for (const x of [...check.same, ...check.pageNewer, ...check.recordNewer]) {
        if (!x.record.kernel_version && x.page.kernel_version && /^EMV L2/.test(x.record.category)) this.store.updateRecord(x.record.id, { kernel_version: x.page.kernel_version }, { source: src });
      }
    });
    return { ...done, after: this.bundleDifferences(key) };
  }

  /** The bundle laid out like the website, as a printable page or an Excel file. */
  bundleReport(key, { format = 'html' } = {}) {
    const v = this.bundleView(key);
    if (format === 'xlsx') return reports.bundleWorkbook(v);
    return reports.bundleReport(v, { company: this.store.getSettings().companyName || '' });
  }

  /**
   * Checks run while a record is being added or edited, before it is saved.
   * Returns [{ level: 'stop'|'warn', title, detail, recordId? }]: 'stop' is a
   * mistake that should not be saved as is (a duplicate, impossible dates),
   * 'warn' asks for a second look.
   */
  checkRecord(id, patch = {}) {
    const { bundleKey, cellOf } = require('./bundles');
    const { formatDate, daysBetween } = require('./dates');
    const cur = id ? this.store.getRecord(id) : null;
    const r = { ...(cur || {}), ...patch, category: taxonomy.normalizeCategory(patch.category || (cur && cur.category) || ''), scheme: taxonomy.normalizeScheme(patch.scheme || (cur && cur.scheme) || '') };
    const out = [];
    const norm = this.store.norm();
    const live = this.listRecords().filter((x) => x.id !== id);
    const bk = bundleKey(r.platform, r.bundle);
    const where = [r.platform, r.bundle].filter(Boolean).join(' ') || 'the register';
    const label = (x) => `${x.device} · ${x.scheme} ${x.category}${x.category === 'PCI PTS' && x.kernel_version ? ` ${x.kernel_version}` : ''}`;
    const cell = cellOf(r, norm);
    // Only what this save changes is checked, so an old issue does not block an unrelated edit.
    const keyChanged = !cur || ['device', 'category', 'scheme', 'platform', 'bundle', 'kernel_version'].some((k) => k in patch);
    const dateChanged = !cur || 'expiry_date' in patch || 'issue_date' in patch;

    // One cell, one record.
    const twin = keyChanged && live.find((x) => {
      if (r.platform || r.bundle) { if (bundleKey(x.platform, x.bundle) !== bk) return false; }
      else if (x.platform || x.bundle) return false;
      const c = cellOf(x, norm);
      return cell && c ? c.key === cell.key : norm(x.device) === norm(r.device) && x.category === r.category && String(x.scheme).toLowerCase() === String(r.scheme).toLowerCase();
    });
    if (twin) {
      out.push({ level: 'stop', title: `Duplicate: ${where} already has ${label(twin)}`,
        detail: `${twin.expiry_date ? `It expires ${formatDate(twin.expiry_date)}` : 'It has no expiry date'}${twin.approval_number ? `, approval ${twin.approval_number}` : ''}. Update that record instead of adding a second one${r.category === 'EMV L2 Contact' ? ': the EMV L2 contact kernel is one approval for the whole bundle' : ''}.`, recordId: twin.id });
    }
    if (dateChanged && r.issue_date && r.expiry_date && r.expiry_date < r.issue_date) out.push({ level: 'stop', title: 'The expiry date is before the issue date', detail: 'One of the two dates is mistyped or swapped.' });
    if (r.expiry_date && cur && cur.expiry_date && r.expiry_date < cur.expiry_date && patch.expiry_date !== undefined) {
      out.push({ level: 'warn', title: `This moves the expiry earlier, from ${formatDate(cur.expiry_date)} to ${formatDate(r.expiry_date)}`, detail: 'A renewal normally extends the date. Check the LOA if this is not a correction.' });
    }
    if (dateChanged && r.issue_date && r.expiry_date && r.expiry_date >= r.issue_date && r.category !== 'Letter of Equivalency') {
      const span = daysBetween(r.issue_date, r.expiry_date);
      if (span < 180 || span > 7 * 366) out.push({ level: 'warn', title: `Unusual validity: ${Math.round(span / 36.5) / 10} years`, detail: 'EMV and PCI approvals normally run 2 to 6 years.' });
    }
    // What the published bundle page says for this cell.
    const page = (this.store.getSettings().bundlePages || {})[bk];
    if (page && cell && r.expiry_date && (keyChanged || dateChanged)) {
      const p = page.rows.find((x) => x.expiry_date && (cellOf(x, norm) || {}).key === cell.key);
      if (!p) out.push({ level: 'warn', title: `Not on the ${page.bundle} page`, detail: `The published page (${page.filename}) has no ${r.category} ${r.category === 'EMV L2 Contactless' ? `${r.scheme} ` : ''}date for ${r.device}. Check the device name, version and bundle.` });
      else if (p.expiry_date !== r.expiry_date) out.push({ level: 'warn', title: `The website shows ${formatDate(p.expiry_date)} for this approval`, detail: p.expiry_date > r.expiry_date ? 'The page has a later date: this record may be out of date.' : 'Your date is later: the website will need updating (it will appear in the Website change request).' });
    }
    // The same approval number with another date elsewhere.
    const num = String(r.approval_number || '').replace(/\s+/g, '').toUpperCase();
    if (num.length >= 4 && /\d/.test(num) && r.expiry_date && (dateChanged || 'approval_number' in patch)) {
      const other = live.find((x) => x.category === r.category && String(x.approval_number || '').replace(/\s+/g, '').toUpperCase() === num && x.expiry_date && x.expiry_date !== r.expiry_date);
      if (other) out.push({ level: 'warn', title: `Approval ${r.approval_number} has another expiry on ${other.device}`, detail: `There it expires ${formatDate(other.expiry_date)}. One approval number has one expiry date: one of the two is out of date.`, recordId: other.id });
    }
    // A device name spelled differently from the rest of the register.
    if (r.device && (!cur || 'device' in patch)) {
      const k = norm(r.device);
      const names = [...new Set(live.map((x) => x.device))];
      const same = names.find((d) => norm(d) === k && d !== r.device);
      if (same && !names.includes(r.device)) out.push({ level: 'warn', title: `Spelled "${same}" elsewhere`, detail: `Use the same spelling so this record joins the device's other certifications.` });
      else if (!names.some((d) => norm(d) === k)) {
        const near = names.find((d) => { const b = norm(d); return Math.abs(b.length - k.length) <= 1 && b.length >= 5 && editDistance(b, k) === 1 && (b.match(/^[A-Z]*/) || [''])[0].length >= 3; });
        out.push({ level: 'warn', title: near ? `New device name. Did you mean ${near}?` : `${r.device} is a new device name`, detail: near ? 'Names one letter apart are usually the same device.' : `No other record uses this name${r.platform ? ` in ${r.platform}` : ''}.` });
      }
    }
    if (keyChanged && r.kernel_version && /^EMV L1/.test(r.category)) out.push({ level: 'warn', title: 'Kernel versions belong to L2 approvals', detail: 'An L1 approval covers the hardware interface, not a kernel build. Leave the kernel empty on L1 records.' });
    return out;
  }

  /** The certifications a contact device and a contactless reader need. */
  coverageSlots() {
    const s = this.store.getSettings();
    const brands = s.requiredBrands && s.requiredBrands.length ? s.requiredBrands : DEFAULT_BRANDS;
    const contact = [
      { key: 'pci', label: 'PCI', group: 'Device (all versions)', category: 'PCI PTS' },
      { key: 'l1c', label: 'L1 Contact', group: 'Device (all versions)', category: 'EMV L1 Contact' },
      { key: 'tqm', label: 'TQM', group: 'Device (all versions)', category: 'TQM' },
    ];
    const reader = [
      { key: 'l1cl', label: 'L1 Contactless', group: 'Hardware version (CL)', category: 'EMV L1 Contactless' },
      { key: 'tqmcl', label: 'TQM', group: 'Hardware version (CL)', category: 'TQM' },
      ...brands.map((b) => ({ key: `l2:${b}`, label: b, group: 'L2 Contactless', category: 'EMV L2 Contactless', scheme: b })),
    ];
    return { contact, reader, brands, na: s.coverageNA || {} };
  }

  /**
   * Every certification of the device a record belongs to: the shared part
   * (PCI, L1 and L2 Contact) and each hardware version (L1 Contactless, TQM,
   * L2 per brand), on the record's platform and bundle.
   */
  deviceProfile(recordId) {
    const rec = this.store.getRecord(recordId);
    if (!rec) return null;
    const { splitVariant } = require('./devices');
    const n = this.store.norm();
    const { na } = this.coverageSlots();
    const base = splitVariant(n(rec.device)).base;
    const g = { platform: rec.platform || '', bundle: rec.bundle || '' };
    // The record's platform and bundle, plus records not placed in any bundle.
    const same = this.listRecords().filter((r) => ((r.platform || '') === g.platform && (r.bundle || '') === g.bundle) || (!r.platform && !r.bundle));
    const sum = (r) => ({ id: r.id, category: r.category, scheme: r.scheme, approval_number: r.approval_number, issue_date: r.issue_date, expiry_date: r.expiry_date,
      kernel_version: r.kernel_version, days: r.days, health: r.health, doc_count: r.doc_count, covers: r.covers || '', eol: r.eol || '', renewal_path: r.renewal_path || '', sharedFrom: r.sharedFrom || '' });
    const st = (r) => (r.eol ? 'eol' : r.expiry_date ? 'ok' : 'nodate');
    const parts = this.deviceParts(same, () => [g]).filter((p) => p.base === base)
      .sort((a, b) => (a.version ? Number(a.version.slice(2)) : 0) - (b.version ? Number(b.version.slice(2)) : 0));
    const sections = parts.map((d) => {
      const used = new Set();
      const rows = [];
      for (const slot of this.partSlots(d)) {
        const hits = d.records.filter((r) => r.category === slot.category && (!slot.scheme || String(r.scheme).toLowerCase() === slot.scheme.toLowerCase()));
        hits.forEach((r) => used.add(r.id));
        const label = slot.scheme ? `L2 Contactless · ${slot.label}` : slot.label;
        if (hits.length) for (const r of hits) rows.push({ slot: slot.key, label, status: st(r), record: sum(r) });
        else rows.push({ slot: slot.key, label, status: (na[d.key] || []).includes(slot.key) ? 'na' : 'missing', record: null });
      }
      for (const r of d.records) if (!used.has(r.id)) rows.push({ slot: '', label: `${r.category}${r.scheme && r.scheme !== 'EMVCo' ? ` · ${r.scheme}` : ''}`, status: st(r), record: sum(r) });
      return { device: d.device, label: d.label, key: d.key, version: d.version, reader: !!d.version, replacedBy: d.replacedBy || '', rows };
    });
    return { platform: g.platform, bundle: g.bundle, sections };
  }

  /** Saved device series that share one reader, e.g. { "Reader A": ["Lane/5000", "Lane/3600", "Desk/1700"] }. */
  listReaderGroups() { return this.store.getSettings().readerGroups || {}; }
  /** Device families: what the devices share (hardware components, kernel version), by family name. */
  listFamilyNotes() { return this.store.getSettings().familyNotes || {}; }
  setReaderGroup(name, devices, note) {
    const g = { ...this.listReaderGroups() };
    const notes = { ...this.listFamilyNotes() };
    const nm = String(name || '').trim();
    if (!nm) throw new Error('Name the family first');
    const list = [...new Set((devices || []).map((d) => String(d).trim()).filter(Boolean))];
    if (list.length) g[nm] = list; else delete g[nm];
    if (list.length && note !== undefined) { if (String(note).trim()) notes[nm] = String(note).trim(); else delete notes[nm]; }
    if (!list.length) delete notes[nm];
    this.store.setSettings({ readerGroups: g, familyNotes: notes });
    return g;
  }

  /** Mark a required certification as not applicable to a device (e.g. no contact reader), or undo that. */
  setCoverageNA(deviceKey, slotKey, value = true) {
    const na = { ...(this.store.getSettings().coverageNA || {}) };
    const list = new Set(na[deviceKey] || []);
    if (value) list.add(slotKey); else list.delete(slotKey);
    if (list.size) na[deviceKey] = [...list]; else delete na[deviceKey];
    this.store.setSettings({ coverageNA: na });
    return na;
  }

  /** Create empty records for missing certifications: [{ device, platform, bundle, slot }]. Returns how many were created. */
  createMissing(items) {
    let n = 0;
    for (const it of items || []) { try { if (this.createSlot(it)) n++; } catch (_) { /* already exists */ } }
    return n;
  }

  /** Create the empty record for one missing certification and return its id. */
  createSlot({ device, platform, bundle, slot }) {
    const SLOT = { pci: ['PCI PTS', 'PCI SSC'], l1c: ['EMV L1 Contact', 'EMVCo'], l2c: ['EMV L2 Contact', 'EMVCo'], tqm: ['TQM', 'Mastercard TQM'], l1cl: ['EMV L1 Contactless', 'EMVCo'], tqmcl: ['TQM', 'Mastercard TQM'] };
    const [category, scheme] = String(slot).startsWith('l2:') ? ['EMV L2 Contactless', slot.slice(3)] : SLOT[slot] || [];
    if (!category) return null;
    return this.store.createRecord({ device, platform, bundle, category, scheme }, { source: 'manual', note: 'Created from device certifications' }).id;
  }


  /** Make a replacement approval the current one (audited). */
  activateReplacement(approvalId) {
    const a = this.db.get('SELECT * FROM approvals WHERE id=?', [approvalId]);
    if (!a || a.role !== 'replacement') throw new Error('Replacement approval not found');
    this.db.tx(() => {
      this.db.run("UPDATE approvals SET role='superseded' WHERE record_id=? AND role='current'", [a.record_id]);
      this.db.run("UPDATE approvals SET role='current' WHERE id=?", [approvalId]);
      const r = this.store.getRecord(a.record_id);
      this.store.updateRecord(a.record_id, {
        expiry_date: a.expiry_date, issue_date: a.issue_date, approval_number: a.approval_number || r.approval_number,
        stage: r.stage === 'Replacement Received' ? '' : r.stage,
      }, { source: 'Activate replacement' });
    });
    return this.getRecord(a.record_id);
  }

  listAliases() { return this.store.aliases(); }
  /** Rules learned from corrections on review cards, newest first. */
  listLearned() { return [...(this.store.getSettings().learned || [])].reverse(); }
  forgetLearned(kind, from, scheme, category) {
    const all = this.store.getSettings().learned || [];
    const hit = (x) => x.kind === kind && x.from === from && (kind !== 'family' || (x.scheme === scheme && x.category === category));
    if (kind === 'device' && all.some(hit)) this.store.setAlias(from, '');
    this.store.setSettings({ learned: all.filter((x) => !hit(x)) });
    return this.listLearned();
  }

  setAlias(alias, device, { apply = false } = {}) {
    this.store.setAlias(alias, device);
    const res = { rematched: this.intake.rematch() };
    if (apply && device) Object.assign(res, this.applyAlias('device', alias, device));
    return res;
  }

  listFieldAliases() { return this.store.fieldAliases(); }

  /** Add (or with no value remove) a platform/bundle alias; `apply` also renames existing records that use it. */
  setFieldAlias(field, alias, value, { apply = false } = {}) {
    this.store.setFieldAlias(field, alias, value);
    return apply && value ? this.applyAlias(field, alias, value) : { changed: 0, skipped: [] };
  }

  /** Records whose field is written as the alias (ignoring case and spacing), or for devices names that match it. */
  aliasMatches(field, alias, value) {
    const { aliasKey } = require('./store');
    const norm = this.store.norm();
    const want = field === 'device' ? norm(alias) : aliasKey(alias);
    if (!want) return [];
    return this.store.listRecords().filter((r) => {
      const cur = r[field];
      if (!cur || cur === value) return false;
      return field === 'device' ? norm(cur) === want : aliasKey(cur) === want;
    });
  }

  /** How many records an alias would rename, with a few examples. */
  previewAlias(field, alias, value) {
    const hits = this.aliasMatches(field, alias, value);
    return { count: hits.length, examples: hits.slice(0, 5).map((r) => `${r.device} · ${r.scheme} ${r.category}`) };
  }

  applyAlias(field, alias, value) {
    const ids = this.aliasMatches(field, alias, value).map((r) => r.id);
    return ids.length ? this.store.bulkUpdate(ids, { [field]: value }, { source: 'alias' }) : { changed: 0, skipped: [] };
  }

  /** Apply every saved alias of a field to existing records. */
  applyAllAliases(field) {
    const out = { changed: 0, skipped: [] };
    const map = field === 'device' ? this.store.aliases() : this.store.fieldAliases()[field] || {};
    for (const [a, v] of Object.entries(map)) {
      const r = this.applyAlias(field, a, v);
      out.changed += r.changed;
      out.skipped.push(...r.skipped);
    }
    return out;
  }

  // ---------------------------------------------------- dashboard & engine
  analysis(asOf = todayIso()) {
    const replacements = this.db.all("SELECT * FROM approvals WHERE role='replacement'");
    const inboxPending = this.db.get("SELECT COUNT(*) AS n FROM inbox WHERE status='pending'").n;
    return engine.analyze(this.store.listRecords(), {
      settings: this.store.getSettings(), asOf, tasks: this.store.taskStates(), inboxPending, replacements, norm: this.store.norm(),
    });
  }

  getDashboard() {
    const asOf = todayIso();
    const a = this.analysis(asOf);
    const s = this.store.getSettings();
    return {
      asOf,
      summary: a.summary,
      actions: a.actions.filter((x) => x.status === 'open').slice(0, 12),
      openActions: a.actions.filter((x) => x.status === 'open').length,
      timeline: engine.timeline(this.store.listRecords(), { asOf, months: 18 }),
      notify: s.notify,
      nextNotification: schedule.nextSlot(s.notify) ? schedule.nextSlot(s.notify).toISOString() : null,
      recentImports: this.store.imports().slice(0, 5),
      empty: a.summary.total === 0,
    };
  }

  getActions() { return this.analysis().actions; }

  setTask(key, status, { snoozeDays = 7, note } = {}) {
    const until = status === 'snoozed' ? addDays(todayIso(), snoozeDays) : null;
    this.store.setTask(key, status, { snoozeUntil: until, note });
    return true;
  }

  digest() {
    const a = this.analysis();
    const s = this.store.getSettings();
    const dg = engine.digest(a, { frequency: s.notify.frequency });
    return { ...dg, email: reports.digestEmail(dg, a, { settings: s }) };
  }

  /** Called by the scheduler; returns the digest when one is due, and marks it sent. */
  checkNotification(now = new Date()) {
    const s = this.store.getSettings();
    if (!schedule.isDue(s.notify, now)) return null;
    if (!this.db.get('SELECT COUNT(*) AS n FROM records').n) return null; // nothing to report yet
    const dg = this.digest();
    this.store.setSettings({ notify: { ...s.notify, lastSent: now.toISOString() } });
    this.store.logNotification(s.notify.frequency, dg.title, dg.lines.join('\n'));
    return dg;
  }

  notificationHistory() { return this.store.notifications(); }

  // ------------------------------------------------------------------ LOAs
  ingestDocument(doc) {
    const res = this.intake.ingest(doc);
    return res;
  }

  listInbox(status = 'pending') { return this.store.listInbox({ status: status === 'all' ? undefined : status }); }

  applyInbox(id, decisions) { return this.intake.apply(id, decisions); }

  rejectInbox(id, note) { this.intake.reject(id, note); return true; }

  setInboxDefaults(ids, fields) { return this.intake.setDefaults(ids, fields); }

  approveInboxMany(ids) { return this.intake.approveMany(ids, { actor: this.store.actor }); }

  rejectInboxMany(ids) { return this.intake.rejectMany(ids); }

  approveAllSafe() { return this.intake.approveAllSafe({ actor: this.store.actor }); }

  rematch() { return this.intake.rematch(); }
  /** Read the files behind these review items (all waiting items when none given) again. */
  rereadInbox(ids) { return this.intake.reread(ids && ids.length ? ids : undefined); }

  listDocuments() { return this.store.listDocuments(); }

  documentPath(id) {
    const d = this.store.getDocument(id);
    return d && d.stored_path && fs.existsSync(d.stored_path) ? d.stored_path : null;
  }

  documentText(id) { return this.store.documentText(id); }

  /** The archived LOA itself, for viewing or saving a copy outside the desktop app. */
  documentFile(id) {
    const p = this.documentPath(id);
    if (!p) throw new Error('The archived file is missing');
    const d = this.store.getDocument(id);
    return { name: d.filename, bytes: fs.readFileSync(p) };
  }

  unlinkDocument(documentId, recordId) { this.store.unlinkDocument(documentId, recordId); return this.getRecord(recordId); }

  // ---------------------------------------- adding an LOA from a record's LOA tab
  /**
   * Is this file already in the app? Matches the same bytes, including copies
   * stored once per device name. Returns the existing LOA, the records it is
   * linked to, and the approval it carries for this record, or null.
   */
  checkAttach(recordId, { bytes }) {
    const { sha256 } = require('./intake');
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    if (!buf.length) return null;
    const h = sha256(buf);
    const docs = this.db.all('SELECT id, filename, uploaded_at FROM documents WHERE sha256=? OR sha256 LIKE ? ORDER BY id', [h, `${h}:%`]);
    if (!docs.length) return null;
    const doc = docs[0];
    const ids = docs.map((d) => d.id);
    const linked = this.db.all(`SELECT DISTINCT r.id, r.device, r.scheme, r.category FROM document_links l JOIN records r ON r.id = l.record_id
      WHERE l.document_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.device`, ids);
    return { document: doc, documentIds: ids, linkedHere: linked.some((r) => r.id === recordId), linkedTo: linked.filter((r) => r.id !== recordId),
      values: this.letterValues(ids, recordId) };
  }

  /** The approval number and dates an LOA gives this record: from records it already updated, else read from its text. */
  letterValues(documentIds, recordId) {
    const ids = [].concat(documentIds);
    const rec = this.store.getRecord(recordId);
    const ap = this.db.get(`SELECT approval_number, issue_date, expiry_date FROM approvals WHERE document_id IN (${ids.map(() => '?').join(',')})
      AND (approval_number <> '' OR expiry_date IS NOT NULL) ORDER BY CASE role WHEN 'current' THEN 0 ELSE 1 END, id DESC`, ids);
    if (ap) return ap;
    const text = this.store.documentText(ids[0]);
    if (!text) return null;
    const { parseDocument } = require('./loa-parser');
    const letters = parseDocument(text.split('\n\f\n')).filter((L) => !L.informational);
    const v = (f) => (f ? f.value : null);
    const L = letters.find((x) => rec && x.category === rec.category && String(x.scheme).toLowerCase() === String(rec.scheme).toLowerCase()) || letters[0];
    if (!L) return null;
    const out = { approval_number: v(L.approvalNumber) || '', issue_date: v(L.issueDate), expiry_date: v(L.expiryDate) };
    return out.approval_number || out.expiry_date ? out : null;
  }

  /**
   * Link an LOA to a record. With useValues, the letter's approval number and
   * dates also replace the record's (the old approval is kept as history).
   */
  linkDocumentToRecord(recordId, documentId, { useValues = false, values = null } = {}) {
    const rec = this.store.getRecord(recordId);
    if (!rec) throw new Error('Record not found');
    const doc = this.store.getDocument(documentId);
    if (!doc) throw new Error('LOA not found');
    const actor = this.store.actor;
    this.db.tx(() => {
      this.store.linkDocument(documentId, recordId);
      this.store.audit(recordId, 'link-document', 'document', '', doc.filename, 'manual', actor);
      const v = useValues ? (values || this.letterValues([documentId], recordId)) : null;
      if (v && (v.approval_number || v.expiry_date)) {
        this.db.run("UPDATE approvals SET role='superseded' WHERE record_id=? AND role IN ('current','replacement')", [recordId]);
        this.store.addApproval(recordId, { approval_number: v.approval_number || rec.approval_number, issue_date: v.issue_date || null,
          expiry_date: v.expiry_date || null, role: 'current', document_id: documentId }, { actor });
        const patch = { verified_at: new Date().toISOString(), verified_by: actor };
        for (const k of ['approval_number', 'issue_date', 'expiry_date']) if (v[k]) patch[k] = v[k];
        this.store.updateRecord(recordId, patch, { source: 'loa', actor });
      }
    });
    return this.getRecord(recordId);
  }

  /**
   * A file dropped in the inbox that is already in the app: which records it
   * is linked to, and the records it could also belong to (other reader
   * versions of the same device with the same approval type and brand).
   */
  duplicateInfo(documentId) {
    const doc = this.store.getDocument(documentId);
    if (!doc) throw new Error('LOA not found');
    const base = String(doc.sha256 || '').split(':')[0];
    const ids = this.db.all('SELECT id FROM documents WHERE sha256=? OR sha256 LIKE ?', [base, `${base}:%`]).map((d) => d.id);
    const linked = this.db.all(`SELECT DISTINCT r.id, r.device, r.scheme, r.category, r.platform, r.bundle FROM document_links l JOIN records r ON r.id = l.record_id
      WHERE l.document_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.device`, ids);
    const { splitVariant } = require('./devices');
    const n = this.store.norm();
    const bases = new Set(linked.map((r) => splitVariant(n(r.device)).base));
    const kinds = new Set(linked.map((r) => `${r.category}|${String(r.scheme).toLowerCase()}`));
    const mine = new Set(linked.map((r) => r.id));
    const suggestions = this.store.listRecords().filter((r) => !mine.has(r.id) && bases.has(splitVariant(n(r.device)).base)
      && kinds.has(`${r.category}|${String(r.scheme).toLowerCase()}`))
      .map((r) => ({ id: r.id, device: r.device, scheme: r.scheme, category: r.category, platform: r.platform || '', bundle: r.bundle || '' }));
    return { document: { id: doc.id, filename: doc.filename }, linkedTo: linked, suggestions, values: linked.length ? this.letterValues(ids, linked[0].id) : this.letterValues(ids, null) };
  }

  /**
   * Map an LOA that is already in the app to more records: existing ones
   * (recordIds) and new ones for other device names (create: [device]),
   * copying the approval type, brand, platform and bundle of a record it is
   * already on. The letter's approval number and dates are applied.
   */
  mapDuplicate(documentId, { recordIds = [], create = [] } = {}) {
    const info = this.duplicateInfo(documentId);
    const from = info.linkedTo[0] ? this.store.getRecord(info.linkedTo[0].id) : null;
    let n = 0;
    const out = [];
    for (const id of recordIds) { this.linkDocumentToRecord(id, documentId, { useValues: true, values: info.values }); out.push(id); n++; }
    for (const device of create.map((d) => String(d).trim()).filter(Boolean)) {
      if (!from) throw new Error('This LOA is not on any record yet; open it from the inbox instead');
      const k = this.store.norm()(device);
      const have = this.store.listRecords().find((x) => this.store.norm()(x.device) === k && x.category === from.category && String(x.scheme).toLowerCase() === String(from.scheme).toLowerCase());
      if (have) { this.linkDocumentToRecord(have.id, documentId, { useValues: true, values: info.values }); out.push(have.id); n++; continue; }
      const r = this.store.createRecord({ device, category: from.category, scheme: from.scheme, platform: from.platform, bundle: from.bundle,
        kernel_version: from.kernel_version }, { source: 'loa', note: `Created from LOA ${info.document.filename}` });
      this.linkDocumentToRecord(r.id, documentId, { useValues: true, values: info.values });
      out.push(r.id); n++;
    }
    return { linked: n, recordIds: out };
  }

  /** Save a new LOA file and link it to this record (it does not go through the LOA inbox). */
  attachNewDocument(recordId, { filename, bytes, pages = [], ocrPages = 0 }) {
    const { sha256, archiveFile } = require('./intake');
    if (!this.store.getRecord(recordId)) throw new Error('Record not found');
    const dup = this.checkAttach(recordId, { bytes });
    if (dup) return { duplicate: dup };
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    const text = (pages || []).join('\n\f\n');
    const stored = buf.length && this.archiveDir ? archiveFile(this.archiveDir, filename, buf) : null;
    const documentId = this.store.addDocument({ sha256: sha256(buf.length ? buf : Buffer.from(text)), filename, stored_path: stored, size: buf.length,
      page_count: pages.length, ocr_pages: ocrPages, text });
    this.linkDocumentToRecord(recordId, documentId);
    return { documentId, values: this.letterValues([documentId], recordId) };
  }

  /** Let the local model fill fields the reader missed (values must exist in the text). */
  async assistInbox(id) {
    const it = this.store.getInbox(id);
    if (!it) throw new Error('Review item not found');
    const text = this.store.documentText(it.document_id);
    const seg = require('./loa-parser').segmentLetters(text.split('\n\f\n'))[it.parsed.segment ?? it.letter_index] || { text };
    const has = (f) => !!(f && f.value);
    const missing = [];
    if (!has(it.parsed.approvalNumber)) missing.push('approval_number');
    if (!(it.parsed.products || []).some(has)) missing.push('products');
    if (!has(it.parsed.expiryDate)) missing.push('expiry_date');
    if (!has(it.parsed.issueDate)) missing.push('issue_date');
    if (!missing.length) return { changed: false, message: 'Nothing is missing from this letter.' };
    const found = await this.ai.assistExtract(seg.text, missing);
    const p = it.parsed;
    const f = (v) => ({ value: v, evidence: 'Suggested by local AI (verified present in the letter text)', confidence: 0.6, ai: true });
    if (found.approval_number) p.approvalNumber = f(found.approval_number);
    if (found.products) p.products = found.products.map(f);
    if (found.expiry_date) { p.expiryDate = f(found.expiry_date); p.expiryBasis = 'Suggested by local AI'; }
    if (found.issue_date) p.issueDate = f(found.issue_date);
    p.warnings = [...(p.warnings || []).filter((w) => !/^No /.test(w)), 'Some values were suggested by AI: please verify'];
    const records = this.store.listRecords();
    const proposals = require('./intake').buildProposals(p, records, this.intake.context());
    this.store.setInbox(id, { parsed: p, proposals });
    return { changed: Object.keys(found).length > 0, found };
  }

  // ---------------------------------------------------------------- import
  async importTracker(args) { return importTracker(this.store, args); }

  /**
   * Import a published certification page (portal). Accepts saved HTML/MHTML,
   * PDF positioned lines from the UI, or plain text. With `asPublished`, only
   * the published value is recorded against existing records (compare mode).
   */
  importPortal({ filename = 'portal', text, bytes, lines, dryRun = false, asPublished = false }) {
    let parsed;
    const lower = filename.toLowerCase();
    if (bytes && /\.(html?|mhtml?|mht)$/.test(lower)) parsed = portal.parseHtml(Buffer.from(bytes).toString('latin1'));
    else if (lines && lines.length) parsed = portal.parsePdfLines(lines, text);
    else parsed = portal.parsePlainText(text || '');
    let candidates = parsed.records;
    if (asPublished) {
      // Compare mode: never touch verified dates, only the published value.
      const report = { added: 0, updated: 0, unchanged: 0, conflicts: [], notFound: [], total: candidates.length, context: parsed.ctx };
      const work = () => {
        for (const c of candidates) {
          const cur = this.store.findByKey(c) || this.findLoose(c);
          if (!cur) { report.notFound.push(`${c.device} · ${c.scheme} ${c.category}`); continue; }
          if (cur.portal_date === c.portal_date) { report.unchanged++; continue; }
          report.updated++;
          if (!dryRun) {
            this.store.updateRecord(cur.id, {
              portal_date: c.portal_date,
              portal_status: cur.expiry_date && cur.expiry_date !== c.portal_date ? 'Change Needed' : 'In Sync',
            }, { source: `Portal: ${filename}` });
          }
        }
      };
      if (dryRun) work(); else this.db.tx(work);
      return report;
    }
    candidates = candidates.map((c) => ({ ...c, portal_status: 'In Sync' }));
    const report = mergeRecords(this.store, candidates, { filename, dryRun, kind: 'portal' });
    return { ...report, context: parsed.ctx };
  }

  /**
   * The record a published row refers to when platform/bundle are spelled
   * differently (or missing) on the page: same device, type and brand, and for
   * PCI the version or, failing that, the latest approval.
   */
  findLoose(c) {
    const n = this.store.norm();
    const cat = taxonomy.normalizeCategory(c.category), sch = taxonomy.normalizeScheme(c.scheme).toLowerCase();
    let hits = this.store.listRecords().filter((r) => !r.archived && n(r.device) === n(c.device) && r.category === cat && String(r.scheme).toLowerCase() === sch);
    if (hits.length > 1 && c.platform) {
      const same = hits.filter((r) => n(r.platform) === n(c.platform));
      if (same.length) hits = same;
    }
    if (hits.length > 1 && cat === 'PCI PTS' && c.kernel_version) {
      const v = hits.filter((r) => n(r.kernel_version) === n(c.kernel_version));
      if (v.length) hits = v;
    }
    if (hits.length > 1) hits = [...hits].sort((a, b) => String(b.expiry_date || '').localeCompare(String(a.expiry_date || ''))).slice(0, 1);
    return hits[0] || null;
  }

  loadSampleData() {
    if (this.store.listRecords().length) throw new Error('Sample data can only be loaded into an empty database.');
    const report = mergeRecords(this.store, sampleRecords(), { filename: 'Sample data', kind: 'sample' });
    this.store.setSettings({ sampleLoaded: true });
    return report;
  }

  clearAllData() {
    this.backup('before-clear');
    this.db.tx(() => {
      for (const t of ['document_links', 'approvals', 'inbox', 'documents', 'audit', 'tasks', 'records', 'archive', 'imports', 'notifications']) this.db.run(`DELETE FROM ${t}`);
    });
    this.store.setSettings({ sampleLoaded: false });
    return true;
  }

  // ---------------------------------------------------------------- reports
  summaryReport({ ids, filterLabel } = {}) {
    const asOf = todayIso();
    let records = this.store.listRecords();
    if (ids && ids.length) { const set = new Set(ids); records = records.filter((r) => set.has(r.id)); }
    const analysis = engine.analyze(records, { settings: this.store.getSettings(), asOf, tasks: this.store.taskStates(), replacements: this.db.all("SELECT * FROM approvals WHERE role='replacement'"), norm: this.store.norm() });
    return reports.summaryReport({ analysis, records, settings: this.store.getSettings(), asOf, filterLabel });
  }

  async exportExcel({ ids } = {}) {
    let records = this.store.listRecords();
    if (ids && ids.length) { const set = new Set(ids); records = records.filter((r) => set.has(r.id)); }
    return reports.exportExcel({ records, analysis: this.analysis() });
  }

  exportCsv({ ids } = {}) {
    let records = this.store.listRecords();
    if (ids && ids.length) { const set = new Set(ids); records = records.filter((r) => set.has(r.id)); }
    return reports.exportCsv(records);
  }

  portalChanges() { return reports.portalChanges(this.store.listRecords()); }

  /**
   * The website change request workbook. With `markRequested`, rows get a
   * change ID (CR-001…) and the status "Change Requested", so the next request
   * continues the numbering and the sent rows can be tracked until published.
   */
  async exportChangeRequest({ ids, markRequested = false } = {}) {
    let rows = this.portalChanges();
    if (ids && ids.length) { const set = new Set(ids); rows = rows.filter((r) => set.has(r.id)); }
    if (markRequested) {
      let n = Math.max(0, ...this.store.listRecords().map((r) => +(String(r.change_ticket || '').match(/^CR-(\d+)$/) || [0, 0])[1]));
      this.store.db.tx(() => {
        for (const r of rows) {
          if (!r.ticket) r.ticket = `CR-${String(++n).padStart(3, '0')}`;
          r.status = 'Requested';
          this.store.updateRecord(r.id, { change_ticket: r.ticket, portal_status: 'Change Requested' }, { source: 'change request' });
        }
      });
    }
    return reports.exportChangeRequest(rows);
  }

  listImports() { return this.store.imports(); }

  auditLog(limit = 500) { return this.store.auditLog({ limit }); }

  // --------------------------------------------------------------------- AI
  aiStatus() { return this.ai.status(); }

  aiBriefing() { return this.ai.briefing(this.analysis()); }

  /** The briefing's records as an email-ready table (HTML and tab-separated text). */
  briefingReport({ briefing = '', months = 12 } = {}) {
    return reports.briefingReport({ records: this.store.listRecords(), analysis: this.analysis(), briefing, settings: this.store.getSettings(), months });
  }

  aiAsk(question) { return this.ai.ask(question, this.analysis(), this.store.listRecords()); }

  /** Data integrity spot checks (dates, conflicting approval numbers, typos, missing foundations...). */
  dataChecks() { return require('./integrity').dataChecks(this.listRecords(), { norm: this.store.norm() }); }

  /** The data checks with clean-up recommendations from the local AI when it is on. */
  async aiDataReview() {
    const issues = this.dataChecks();
    return { ...(await this.ai.dataReview(issues, this.analysis())), issues };
  }

  aiDraftEmail(ids, opts = {}) {
    const set = new Set(ids || []);
    const recs = this.store.listRecords().filter((r) => set.has(r.id));
    return this.ai.draftEmail(recs, { ...opts, asOf: todayIso() });
  }

  // ---------------------------------------------------------------- backups
  backup(label = 'manual') {
    if (!this.backupDir) return null;
    fs.mkdirSync(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const file = path.join(this.backupDir, `loa-${stamp}-${label}.db`);
    fs.writeFileSync(file, this.db.exportBytes());
    this.store.setSettings({ lastBackup: new Date().toISOString() });
    this.pruneBackups();
    return file;
  }

  /** First start of a new app version: save the previous database untouched. */
  upgradeBackup(before) {
    const s = this.store.getSettings();
    if (s.appVersion === VERSION) return null;
    let file = null;
    if (before && this.backupDir && this.store.listRecords().length) {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      file = path.join(this.backupDir, `loa-${stamp}-before-v${VERSION}.db`);
      fs.writeFileSync(file, before);
    }
    this.store.setSettings({ appVersion: VERSION });
    this.store.tagReaders();
    this.store.migrateArchivedFlag();
    this.store.restoreL2Contact();
    this.store.unifyDeviceSpellings();
    // A new version may read letters better; refresh what is waiting for review.
    if (this.store.listInbox({ status: 'pending' }).length || this.store.listInbox({ status: 'info' }).length) this.intake.reread();
    return file;
  }

  autoBackup() {
    if (!this.backupDir) return;
    const s = this.store.getSettings();
    const last = s.lastBackup ? new Date(s.lastBackup) : null;
    if (!last || Date.now() - last.getTime() > 20 * 3600 * 1000) {
      if (this.store.listRecords().length) this.backup('auto');
    }
  }

  pruneBackups() {
    const keep = Math.max(3, this.store.getSettings().backupKeep || 14);
    const auto = this.listBackups().filter((b) => b.name.includes('-auto'));
    for (const b of auto.slice(keep)) { try { fs.unlinkSync(b.path); } catch (_) { /* ignore */ } }
  }

  listBackups() {
    if (!this.backupDir || !fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir).filter((f) => f.endsWith('.db')).map((f) => {
      const p = path.join(this.backupDir, f);
      const st = fs.statSync(p);
      return { name: f, path: p, size: st.size, mtime: st.mtime.toISOString() };
    }).sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  /** Restore replaces the database; the current one is backed up first. Caller must reload. */
  async restore(file) {
    if (!fs.existsSync(file)) throw new Error('Backup file not found');
    const { loadSql } = require('./db');
    const S = await loadSql();
    const test = new S.Database(fs.readFileSync(file));
    const ok = test.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='records'");
    test.close();
    if (!ok.length) throw new Error('That file is not an LOA Command Center database');
    this.backup('before-restore');
    this.db.close();
    fs.copyFileSync(file, path.join(this.dataDir, 'loa.db'));
    this.db = await Database.open(path.join(this.dataDir, 'loa.db'));
    this.store = new Store(this.db, { actor: this.store.actor });
    this.intake = new Intake(this.store, { archiveDir: this.archiveDir });
    return true;
  }

  health() {
    return {
      integrity: this.db.integrityCheck(),
      records: this.db.get('SELECT COUNT(*) n FROM records').n,
      documents: this.db.get('SELECT COUNT(*) n FROM documents').n,
      lastBackup: this.store.getSettings().lastBackup,
      dataDir: this.dataDir,
      version: VERSION,
    };
  }
}

// Methods the UI may call. Anything else is rejected by the IPC/HTTP bridges.
const PUBLIC_METHODS = [
  'info', 'getSettings', 'setSettings', 'listRecords', 'getRecord', 'saveRecord', 'deleteRecord', 'deleteRecords', 'bulkUpdate',
  'listArchive', 'archiveCount', 'expiredRecords', 'archiveExpired', 'restoreArchived', 'purgeArchived',
  'activateReplacement', 'deviceCoverage', 'deviceProfile', 'listBundles', 'bundleView', 'readBundlePage', 'bundleDifferences', 'cleanBundle', 'bundleReport', 'checkRecord', 'listReaderGroups', 'setReaderGroup', 'listFamilyNotes', 'setCoverageNA', 'createMissing', 'createSlot', 'listTags', 'knownDevices', 'listAliases', 'listLearned', 'forgetLearned', 'setAlias', 'listFieldAliases', 'setFieldAlias', 'previewAlias', 'applyAllAliases', 'listImports', 'getDashboard', 'getActions', 'setTask', 'digest', 'notificationHistory',
  'ingestDocument', 'documentFile', 'listInbox', 'applyInbox', 'rejectInbox', 'setInboxDefaults', 'approveInboxMany', 'rejectInboxMany', 'approveAllSafe', 'rematch', 'rereadInbox', 'listDocuments',
  'documentText', 'unlinkDocument', 'checkAttach', 'linkDocumentToRecord', 'setEol', 'dataChecks', 'aiDataReview', 'briefingReport', 'exportL3Sheet', 'duplicateInfo', 'mapDuplicate', 'attachNewDocument', 'assistInbox', 'importTracker', 'importPortal', 'loadSampleData', 'clearAllData',
  'summaryReport', 'exportExcel', 'exportCsv', 'portalChanges', 'exportChangeRequest', 'auditLog', 'aiStatus', 'aiBriefing', 'aiAsk',
  'aiDraftEmail', 'backup', 'listBackups', 'restore', 'health',
];

module.exports = { AppApi, PUBLIC_METHODS };
