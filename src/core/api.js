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
const { ptsVersion } = taxonomy;
// Bump when the bundle page reader changes what it reads, so pages read before are flagged to read again.
// 2: Discover ZIP kept apart from D-PAS; a "Kernel" column keeps every number (087300 0306).
const PAGE_READER = 2;
const { sampleRecords } = require('./sample');
const schedule = require('./schedule');

const VERSION = require('../../package.json').version;
// Card brands whose L2 contactless approval a reader needs (US market by default; editable in Settings).
/** Other devices a record's LOA also certifies (its "Covers devices" list). */
/** The current contact validity letter that names a device, or null. */
function currentFamilies(letters, device, n) {
  return require('./validity').lettersFor(device, letters, n, { iface: 'contact' })[0] || null;
}
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
    extra: c.extra.length, undated: c.undated.length, waiver: (c.waiver || []).length, duplicates: c.duplicates.reduce((n, d) => n + d.others.length, 0),
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
    waiver: (c.waiver || []).map((x) => ({ record: rec(x.record), page: x.page.expiry_date || null })),
  };
}

/** An empty placeholder: no LOA, no approval number and no dates. It does not count as certified. */
const awaitingLoa = (r) => !r.doc_count && !r.expiry_date && !r.approval_number && !r.issue_date;

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
    // Pages read before this version still fill kernels and place records.
    try { api.syncFromBundlePages(); } catch (_) { /* never blocks opening */ }
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
      ptsVersions: taxonomy.PTS_VERSIONS, clessKernels: taxonomy.CLESS_KERNELS,
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
      sameReader: this.sameReader(r),
      validity: this.validityFor(r),
    };
  }

  // ------------------------------------------------------------ validity letters
  /**
   * Manufacturer validity letters read from the inbox (any not rejected):
   * each says an L2 approval on one model of a family is valid on every model.
   */
  validityLetters() {
    const out = [];
    for (const it of this.store.listInbox()) {
      const v = it.parsed && it.parsed.type === 'validity' ? it.parsed.validity : null;
      if (!v || it.status === 'rejected') continue;
      out.push({ ...v, inboxId: it.id, document_id: it.document_id, filename: it.filename || '' });
    }
    return out;
  }

  /** Validity letters, newest first, each marked current or replaced by a newer one for the same family and interface. */
  listValidityLetters() {
    const { currentLetters } = require('./validity');
    const all = this.validityLetters();
    const cur = new Set(currentLetters(all).map((L) => L.inboxId));
    return all.map((L) => ({ ...L, current: cur.has(L.inboxId) }))
      .sort((a, b) => String(a.family).localeCompare(String(b.family)) || a.interface.localeCompare(b.interface) || String(b.issued || '').localeCompare(String(a.issued || '')));
  }

  /** What the validity letters say about one record's device: the letters naming it, its spec name, and any rule it breaks. */
  validityFor(r, letters = this.validityLetters()) {
    const V = require('./validity');
    const n = this.store.norm();
    const list = V.lettersFor(r.device, letters, n);
    const out = { letters: list.map((L) => ({ inboxId: L.inboxId, document_id: L.document_id, family: L.family, interface: L.interface, reference: L.reference, issued: L.issued, group: V.groupOf(L, r.device, n), perProduct: L.perProduct, pcdCaveat: L.pcdCaveat })), spec: '', problems: [] };
    // The bundle's one L2 Contact kernel must meet a letter's minimum for this device.
    if (r.platform && r.bundle) {
      const l2c = this.store.listRecords().find((x) => !x.archived && x.category === 'EMV L2 Contact' && x.platform === r.platform && x.bundle === r.bundle && x.kernel_version);
      const pk = require('./bundles').bundleKernel(this.kernelPages(), { category: 'EMV L2 Contact', platform: r.platform, bundle: r.bundle });
      const kernel = (l2c && l2c.kernel_version) || (pk && pk.kernel);
      for (const L of list.filter((x) => x.interface === 'contact')) {
        const rule = kernel ? V.contactRuleBroken(L, r.device, kernel, n) : null;
        if (rule) out.problems.push(`${V.letterLabel(L)}: only kernel ${rule.minVersion} or newer may be used on ${r.device}, but ${r.platform} ${r.bundle} runs L2 Contact kernel ${kernel}.`);
      }
    }
    if (r.category !== 'EMV L2 Contactless') return out;
    out.spec = V.specFor(letters, r.scheme, r.kernel_version);
    for (const L of list.filter((x) => x.interface === 'contactless')) {
      const hit = V.nextGenBroken(L, r.device, r.scheme, r.kernel_version, n);
      if (hit) out.problems.push(`${V.letterLabel(L)}: ${r.scheme} kernel ${r.kernel_version} (${hit.spec}) is listed for the older generation only. Scheme rules do not allow it on ${V.groupOf(L, r.device, n) || 'this device'}.`);
    }
    return out;
  }

  /** Other L1 records on the same reader module (IFM or PCD): they rest on the same hardware approval. */
  sameReader(r) {
    const k = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^EMV L1/.test(r.category || '') || k(r.reader_id).length < 4) return [];
    return this.store.listRecords().filter((x) => x.id !== r.id && !x.archived && x.category === r.category && k(x.reader_id) === k(r.reader_id))
      .map((x) => ({ id: x.id, device: x.device, platform: x.platform, bundle: x.bundle, expiry_date: x.expiry_date }));
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
        const status = rec ? (rec.eol ? 'eol' : rec.expiry_date ? 'ok' : awaitingLoa(rec) ? 'awaiting' : 'nodate') : isNa && needed ? 'na' : needed ? 'missing' : 'none';
        if (status === 'missing' || status === 'awaiting') missing++;
        cells[slot.key] = { status, record: rec ? { id: rec.id, expiry_date: rec.expiry_date, days: rec.days, health: rec.health, approval_number: rec.approval_number, scheme: rec.scheme, eol: rec.eol || '', category: rec.category, sharedFrom: rec.sharedFrom || '' } : null };
      }
      rows.push({ grp: d.grp, platform: d.platform, bundle: d.bundle, device: d.device, label: d.label, key: d.key, base: d.base, version: d.version,
        reader: !!d.version, replacedBy: d.replacedBy || '', retired, missing: Object.values(cells).filter((c) => c.status === 'missing' || c.status === 'awaiting').length, cells });
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

  /**
   * Every bundle of every platform, numbered 1 to the newest: from your records, the website
   * pages you read, the kernel catalog, and the bundle count you set per platform
   * (Settings: bundleCounts, e.g. ARC 5, UPP 6). Bundles nobody has filled in yet are listed
   * as gaps, so all of them are tracked. Returns [{ key, platform, bundle, no, gap }].
   */
  allBundles() {
    const { bundleKey, bundleNo } = require('./bundles');
    const s = this.store.getSettings();
    const seen = new Map();
    const put = (platform, bundle) => {
      // Only numbered bundles count ("Kernel Bundle 3"); a blank or unnumbered bundle name is
      // a record to fix, not a bundle (see platformReference().unnumbered).
      if (!platform || !bundle || !/\d/.test(bundle)) return;
      const key = bundleKey(platform, bundle);
      if (!seen.has(key)) seen.set(key, { key, platform, bundle, no: bundleNo(bundle), gap: false });
    };
    for (const g of this.bundleGroups().values()) put(g.platform, g.bundle);
    for (const [, p] of Object.entries(this.kernelPages())) put(p.platform, p.bundle);
    const counts = { ...(s.bundleCounts || {}) };
    const byPlat = new Map();
    for (const b of seen.values()) { if (!byPlat.has(b.platform)) byPlat.set(b.platform, []); byPlat.get(b.platform).push(b); }
    for (const pf of Object.keys(counts)) if (!byPlat.has(pf) && counts[pf] > 0) byPlat.set(pf, []);
    for (const [pf, list] of byPlat) {
      const max = Math.max(Number(counts[pf]) || 0, ...list.map((b) => Math.floor(b.no) || 0));
      // Name a missing bundle the way this platform's bundles are named ("Bundle 3", "Kernel Bundle 3").
      const sample = (list.find((b) => /\d/.test(b.bundle)) || {}).bundle || 'Bundle 1';
      // Numbering starts at 0 on platforms that have a Bundle 0.
      for (let n = list.some((b) => b.no === 0) ? 0 : 1; n <= max; n++) {
        if (list.some((b) => Math.floor(b.no) === n)) continue;
        const bundle = sample.replace(/\d+(?:\.\d+)?/, String(n));
        const key = bundleKey(pf, bundle);
        if (!seen.has(key)) seen.set(key, { key, platform: pf, bundle, no: n, gap: true });
      }
    }
    return [...seen.values()].sort((a, b) => a.platform.localeCompare(b.platform) || a.no - b.no || a.bundle.localeCompare(b.bundle));
  }

  /** How many bundles a platform has (ARC 5, UPP 6): the ones not filled in yet are listed as gaps. */
  setBundleCount(platform, count) {
    platform = String(platform || '').trim();
    if (!platform) throw new Error('Give the platform, e.g. ARC');
    const n = Math.max(0, Math.min(50, Math.floor(Number(count) || 0)));
    const s = this.store.getSettings();
    const bundleCounts = { ...(s.bundleCounts || {}) };
    if (n) bundleCounts[platform] = n; else delete bundleCounts[platform];
    this.store.setSettings({ bundleCounts });
    return bundleCounts;
  }

  /**
   * One platform's bundles side by side, as a reference like the website's overview: the
   * kernel each bundle runs per card brand (marking where a new kernel arrived), and every
   * device's L2 dates across the bundles, so you can see which bundle a renewal landed in.
   */
  platformReference(platform) {
    const { bundleKernel, kernelMismatch } = require('./bundles');
    const pages = this.kernelPages();
    const groups = this.bundleGroups();
    const bundles = this.allBundles().filter((b) => b.platform.toLowerCase() === String(platform || '').toLowerCase());
    const brands = this.coverageSlots().brands;
    const norm = this.store.norm();
    const kernelRows = [{ key: 'EMV Contact', label: 'EMV Contact (L2)', category: 'EMV L2 Contact', scheme: 'EMVCo' },
      ...brands.map((b) => ({ key: b, label: b, category: 'EMV L2 Contactless', scheme: b }))].map((row) => {
      let prev = '';
      const cells = bundles.map((b) => {
        const k = bundleKernel(pages, { category: row.category, scheme: row.scheme, platform: b.platform, bundle: b.bundle });
        const kernel = k ? k.kernel : '';
        const changed = !!(kernel && prev && kernel !== prev);
        if (kernel) prev = kernel;
        return { kernel, changed };
      });
      return { ...row, cells };
    });
    const l2 = {};
    for (const b of bundles) {
      const g = groups.get(b.key);
      for (const r of g ? g.records : []) {
        if (r.archived || !/^EMV L2 Contactless/.test(r.category)) continue;
        const brand = brands.find((x) => x.toLowerCase() === String(r.scheme || '').toLowerCase()) || r.scheme;
        const dev = r.device;
        const row = ((l2[brand] = l2[brand] || {})[norm(dev)] = l2[brand][norm(dev)] || { device: dev, cells: {} });
        const cur = row.cells[b.key];
        if (cur && (cur.expiry_date || '') >= (r.expiry_date || '')) continue;
        row.cells[b.key] = { id: r.id, expiry_date: r.expiry_date, health: r.health, kernel_version: r.kernel_version || '', approval_number: r.approval_number || '',
          restriction: r.restriction || '', eol: r.eol || '', wrongKernel: kernelMismatch(pages, r) };
      }
    }
    const l2rows = Object.fromEntries(Object.entries(l2).map(([b, m]) => [b, Object.values(m).sort((x, y) => x.device.localeCompare(y.device, undefined, { numeric: true }))]));
    const sitePages = this.store.getSettings().bundlePages || {};
    const list = bundles.map((b) => ({ ...b, records: (groups.get(b.key) || { records: [] }).records.length, page: !!sitePages[b.key] }));
    // Records on this platform whose bundle has no number (blank, "TBD", a release such as "5.xx.xx").
    const unnumbered = [...groups.values()].filter((g) => g.platform && g.platform.toLowerCase() === String(platform).toLowerCase() && !/\d/.test(String(g.bundle || '')))
      .map((g) => ({ bundle: g.bundle || '', ids: g.records.map((r) => r.id) })).filter((g) => g.ids.length);
    // Once website pages are read for a platform, a bundle without one is not on the website.
    const read = list.filter((b) => b.page);
    const notOnSite = read.length ? list.filter((b) => !b.page).map((b) => ({ key: b.key, bundle: b.bundle, no: b.no, gap: b.gap, ids: (groups.get(b.key) || { records: [] }).records.map((r) => r.id) })) : [];
    const siteMax = read.length ? Math.max(...read.map((b) => Math.floor(b.no))) : 0;
    return { platform, bundles: list, kernelRows, brands, l2: l2rows, unnumbered, notOnSite, siteBundles: read.map((b) => b.no), siteMax };
  }

  /** Every bundle: how many dates it holds, and how it compares with its published page. */
  listBundles() {
    const { bundleCheck } = require('./bundles');
    const pages = this.store.getSettings().bundlePages || {};
    const norm = this.store.norm();
    const out = [];
    const groups = this.bundleGroups();
    for (const k of Object.keys(pages)) if (!groups.has(k)) groups.set(k, { key: k, bundle: pages[k].bundle, platform: pages[k].platform, records: [] });
    const all = this.allBundles();
    for (const b of all) if (!groups.has(b.key)) groups.set(b.key, { key: b.key, bundle: b.bundle, platform: b.platform, records: [], gap: b.gap });
    for (const g of groups.values()) {
      const page = pages[g.key];
      const check = page ? bundleCheck(page.rows, g.records, { norm }) : null;
      out.push({
        key: g.key, platform: g.platform, bundle: g.bundle, records: g.records.length,
        dates: g.records.filter((r) => r.expiry_date && require('./bundles').cellOf(r, norm)).length,
        page: page ? { filename: page.filename, at: page.at, dates: check.pageDates, stale: (page.reader || 1) < PAGE_READER } : null,
        issues: check ? summarizeCheck(check) : null, gap: !!g.gap && !g.records.length && !page,
        unnumbered: !/\d/.test(String(g.bundle || '')),
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
    const { kernelMismatch } = require('./bundles');
    const pages = this.kernelPages();
    const cell = (r) => (r ? { id: r.id, wrongKernel: kernelMismatch(pages, r), expiry_date: r.expiry_date, health: r.health, days: r.days, approval_number: r.approval_number, eol: r.eol || '', restriction: r.restriction || '', kernel_version: r.kernel_version || '', doc_count: r.doc_count, diff: diff[r.id] || null } : null);
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
    // Every card brand the bundle needs gets a column, so a brand with no approvals shows as a gap rather than disappearing.
    const allBrands = [...brands.map((b) => ({ key: b.toLowerCase(), label: b })), ...view.brands.filter((b) => !brands.some((x) => x.toLowerCase() === b.key))];
    // Each brand's contactless kernel: from the page's kernel table, else the version most records carry.
    const kernels = {};
    const seen = {};
    for (const r of records) {
      if (r.archived || r.category !== 'EMV L2 Contactless' || !r.kernel_version) continue;
      const k = String(r.scheme || '').toLowerCase();
      (seen[k] = seen[k] || {})[r.kernel_version] = (seen[k][r.kernel_version] || 0) + 1;
    }
    for (const [k, m] of Object.entries(seen)) kernels[k] = Object.entries(m).sort((a, b) => b[1] - a[1])[0][0];
    const kp = pages[key];
    for (const [b, v] of Object.entries((kp && kp.ctx.kernels) || {})) kernels[b.toLowerCase()] = v;
    const { kernelBundles } = require('./bundles');
    const platform = g ? g.platform : kp ? kp.platform : '';
    // The same kernel often runs in several bundles: name the others.
    const alsoIn = (category, scheme, kernel) => kernelBundles(pages, { category, scheme, platform }, kernel).filter((b) => b.key !== key).map((b) => b.bundle);
    const l2k = view.l2contact ? view.l2contact.kernel_version || '' : (kp && kp.ctx.l2Contact ? kp.ctx.l2Contact.version : '');
    return {
      key, platform: g ? g.platform : page ? page.platform : '', bundle: g ? g.bundle : page ? page.bundle : '',
      sections, l2missing,
      l2contact: cell(view.l2contact), l2contactKernel: l2k, l2contactAlsoIn: l2k ? alsoIn('EMV L2 Contact', 'EMVCo', l2k) : [],
      brands: allBrands.map((b) => ({ ...b, kernel: kernels[b.key] || '', alsoIn: kernels[b.key] ? alsoIn('EMV L2 Contactless', b.label, kernels[b.key]) : [] })), dates: view.dates, duplicates: view.duplicates.length,
      page: page ? { filename: page.filename, at: page.at, dates: check.pageDates, blanks: check.pageBlanks, stale: (page.reader || 1) < PAGE_READER } : null,
      issues: check ? summarizeCheck(check) : null, missing,
    };
  }

  /** Brand kernels per bundle: website pages read, overlaid with the kernel catalog. */
  kernelPages() { return require('./bundles').kernelPages(this.store.getSettings()); }

  /**
   * The kernel catalog: every bundle of every platform with the kernel it runs per card
   * brand (and the EMV contact kernel), from the website pages you read and what you
   * typed or imported. `spans` lists each brand kernel with every bundle that runs it.
   */
  kernelCatalog() {
    const { bundleNo } = require('./bundles');
    const pages = this.kernelPages();
    const catalog = this.store.getSettings().kernelCatalog || {};
    const known = this.coverageSlots().brands;
    const brandSet = new Map(known.map((b) => [b.toLowerCase(), b]));
    const bundles = Object.entries(pages).map(([key, p]) => {
      const kernels = {};
      for (const [b, v] of Object.entries(p.ctx.kernels || {})) {
        if (!brandSet.has(b.toLowerCase())) brandSet.set(b.toLowerCase(), b);
        kernels[b.toLowerCase()] = { value: v, source: p.source[b] || 'page' };
      }
      const l2 = p.ctx.l2Contact && p.ctx.l2Contact.version ? { value: p.ctx.l2Contact.version, source: p.source['EMV Contact'] || 'page' } : null;
      return { key, platform: p.platform || key.split('|')[0], bundle: p.bundle || key.split('|')[1], l2Contact: l2, kernels, page: !!(this.store.getSettings().bundlePages || {})[key], inCatalog: !!catalog[key] };
    });
    // Bundles your records name with no kernels yet are listed too, as gaps to fill.
    for (const g of this.bundleGroups().values()) {
      if (!g.bundle || pages[g.key]) continue;
      if (!g.records.some((r) => /^EMV L2/.test(r.category))) continue;
      bundles.push({ key: g.key, platform: g.platform, bundle: g.bundle, l2Contact: null, kernels: {}, page: false, inCatalog: false });
    }
    // Every bundle number up to the newest (or the count you set), so none is left untracked.
    for (const b of this.allBundles()) {
      if (bundles.some((x) => x.key === b.key)) continue;
      bundles.push({ key: b.key, platform: b.platform, bundle: b.bundle, l2Contact: null, kernels: {}, page: false, inCatalog: false, gap: true });
    }
    bundles.sort((a, b) => a.platform.localeCompare(b.platform) || bundleNo(a.bundle) - bundleNo(b.bundle) || a.bundle.localeCompare(b.bundle));
    const kernelIds = (v) => (String(v || '').match(/\d+(?:\.\d+)*/g) || []).map((t) => t.replace(/\./g, '').replace(/^0+/, '')).join('.');
    const spans = [];
    const add = (platform, brand, kernel, bundle) => {
      const id = `${platform}|${brand.toLowerCase()}|${kernelIds(kernel) || kernel}`;
      let x = spans.find((s) => s.id === id);
      if (!x) spans.push(x = { id, platform, brand, kernel, bundles: [] });
      x.bundles.push(bundle);
    };
    for (const b of bundles) {
      if (b.l2Contact) add(b.platform, 'EMV Contact', b.l2Contact.value, b.bundle);
      for (const [k, v] of Object.entries(b.kernels)) add(b.platform, brandSet.get(k) || k, v.value, b.bundle);
    }
    return { bundles, brands: [...brandSet.values()], spans, counts: this.store.getSettings().bundleCounts || {} };
  }

  /**
   * Set one bundle's kernels in the catalog: { platform, bundle, l2Contact, kernels: { Brand: version } }.
   * An empty version clears what you typed (a website page's value shows again).
   */
  setKernelCatalog({ platform, bundle, l2Contact, kernels = {} }) {
    const { bundleKey } = require('./bundles');
    platform = String(platform || '').trim(); bundle = String(bundle || '').trim();
    if (!platform || !bundle) throw new Error('Give the platform and the bundle, e.g. ARC and Bundle 3');
    const key = bundleKey(platform, bundle);
    const all = { ...(this.store.getSettings().kernelCatalog || {}) };
    // Keep the spelling your records use for this bundle.
    const g = this.bundleGroups().get(key);
    const cur = all[key] || { platform: g ? g.platform : platform, bundle: g ? g.bundle : bundle, kernels: {} };
    const next = { ...cur, kernels: { ...cur.kernels } };
    if (l2Contact !== undefined) next.l2Contact = String(l2Contact || '').trim();
    for (const [b, v] of Object.entries(kernels)) {
      const had = Object.keys(next.kernels).find((x) => x.toLowerCase() === b.toLowerCase());
      if (had) delete next.kernels[had];
      if (String(v || '').trim()) next.kernels[b] = String(v).trim();
    }
    all[key] = next;
    this.store.setSettings({ kernelCatalog: all });
    this.syncFromBundlePages();
    return { key };
  }

  /** Remove a bundle from the kernel catalog (a website page read for it stays). */
  removeKernelBundle(key) {
    const all = { ...(this.store.getSettings().kernelCatalog || {}) };
    delete all[key];
    this.store.setSettings({ kernelCatalog: all });
    return { key };
  }

  /**
   * Import kernels from a spreadsheet, CSV or pasted table. Either one row per bundle
   * (Platform, Bundle, then a column per card brand and EMV Contact) or one row per
   * kernel (Platform, Bundle, Brand, Kernel).
   */
  async importKernelCatalog({ filename = 'pasted.txt', bytes, text }) {
    const { readWorkbook } = require('./importer');
    let sheets;
    if (text != null) {
      const t = String(text);
      const rows = t.split(/\r?\n/).filter((l) => l.trim()).map((l) => (l.includes('\t') ? l.split('\t') : null));
      sheets = rows.every(Boolean) ? [{ name: 'Pasted', rows }] : await readWorkbook('pasted.csv', Buffer.from(t));
    } else sheets = await readWorkbook(filename, bytes);
    const h = (v) => String(v == null ? '' : v).trim();
    const brands = this.coverageSlots().brands;
    const brandOf = (v) => {
      const x = h(v).toLowerCase().replace(/\s*(kernel|l2|contactless|version)\s*/g, ' ').trim();
      if (/^(emv\s*)?contact$|^emvco$|^l2 contact$|^emv l2 contact$/.test(x) || /^emv contact/.test(h(v).toLowerCase())) return 'EMV Contact';
      if (/^(mc|master ?card)/.test(x)) return 'Mastercard';
      if (/^(amex|american express)/.test(x)) return 'Amex';
      if (/^(upi|cup|union ?pay)/.test(x)) return brands.find((b) => /union|upi/i.test(b)) || 'UnionPay';
      return brands.find((b) => b.toLowerCase() === x || x.startsWith(b.toLowerCase())) || (x ? h(v).replace(/\s*(kernel|version)\s*$/i, '') : '');
    };
    const found = new Map();
    const put = (platform, bundle, brand, kernel) => {
      platform = h(platform); bundle = h(bundle); kernel = h(kernel); brand = brandOf(brand);
      if (!platform || !bundle || !brand || !kernel || /^[-—n\/a]+$/i.test(kernel)) return;
      if (!/bundle/i.test(bundle) && /^\d+(\.\d+)?$/.test(bundle)) bundle = `Bundle ${bundle}`;
      const k = `${platform}|${bundle}`;
      if (!found.has(k)) found.set(k, { platform, bundle, l2Contact: undefined, kernels: {} });
      const e = found.get(k);
      if (brand === 'EMV Contact') e.l2Contact = kernel; else e.kernels[brand] = kernel;
    };
    for (const sh of sheets) {
      const rows = sh.rows.map((r) => (r || []).map(h));
      const hi = rows.findIndex((r) => r.some((c) => /^platform$/i.test(c)) && r.some((c) => /bundle/i.test(c)));
      if (hi < 0) continue;
      const head = rows[hi].map((c) => c.toLowerCase());
      const pi = head.findIndex((c) => c === 'platform');
      const bi = head.findIndex((c) => /bundle/.test(c));
      const ri = head.findIndex((c) => /^(brand|card brand|scheme)$/.test(c));
      const ki = head.findIndex((c) => /^(kernel|kernel version|version)$/.test(c));
      for (const r of rows.slice(hi + 1)) {
        if (ri >= 0 && ki >= 0) put(r[pi], r[bi], r[ri], r[ki]);
        else head.forEach((c, i) => { if (i !== pi && i !== bi && c) put(r[pi], r[bi], rows[hi][i], r[i]); });
      }
    }
    if (!found.size) throw new Error('No kernels found. Use columns Platform, Bundle and one column per card brand (or Platform, Bundle, Brand, Kernel).');
    let kernels = 0;
    for (const e of found.values()) {
      this.setKernelCatalog(e);
      kernels += Object.keys(e.kernels).length + (e.l2Contact ? 1 : 0);
    }
    return { bundles: found.size, kernels };
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
    if (ctx.notBundle) throw new Error(`"${ctx.notBundle}" is not a kernel bundle page (a bundle page is titled "Kernel Bundle N"), so it was skipped.`);
    if (!ctx.platform && !ctx.bundle) throw new Error('The page does not say which platform and bundle it is for. Check that it is a kernel bundle page.');
    const key = bundleKey(ctx.platform, ctx.bundle);
    const g = this.bundleGroups().get(key);
    const rows = parsed.records.map((r) => ({ device: r.device, category: r.category, scheme: r.scheme, kernel_version: r.kernel_version || '', expiry_date: r.expiry_date || null, ...(r.restriction ? { restriction: r.restriction } : {}) }));
    const pages = { ...(this.store.getSettings().bundlePages || {}) };
    pages[key] = { filename, at: new Date().toISOString(), platform: g ? g.platform : ctx.platform, bundle: g ? g.bundle : ctx.bundle, ctx: { l2Contact: ctx.l2Contact || null, kernels: { ...(ctx.kernels || {}) }, kernelIds: ctx.kernelIds || {}, appVersions: ctx.appVersions || {} }, reader: PAGE_READER, rows };
    this.store.setSettings({ bundlePages: pages });
    const sync = this.syncFromBundlePages();
    const g2 = this.bundleGroups().get(key) || g;
    const check = bundleCheck(rows, g2 ? g2.records : [], { norm: this.store.norm() });
    return { key, sync, filename: pages[key].filename, platform: pages[key].platform, bundle: pages[key].bundle, ...summarizeCheck(check), details: checkDetails(check) };
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
      if (fix.waiver) {
        for (const x of check.waiver || []) {
          this.store.updateRecord(x.record.id, { restriction: 'waiver' }, { source: src, note: 'The website strikes this date or shows XX: expired, restricted renewal (customer waiver)' });
          done.waiver = (done.waiver || 0) + 1;
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
    const { bundleKey, cellOf, kernelMismatch, fitsNote } = require('./bundles');
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
    // An LOA for another kernel than the bundle runs does not apply to the bundle.
    const km = (keyChanged || dateChanged) && kernelMismatch(this.kernelPages(), r);
    if (km) out.push({ level: 'stop', title: `Wrong kernel: this approval is for kernel ${km.kernel}, ${km.platform} ${km.bundle} runs ${km.expected}`, detail: `${r.scheme ? `${r.scheme} ` : ''}${r.category} dates only apply to the kernel the bundle runs. Find the LOA for kernel ${km.expected}, or leave the website date as it is.${fitsNote(km)}` });
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
    return this.deviceView(rec);
  }

  /**
   * Everything a device is certified for, by device name: the device (PCI, L1
   * Contact, TQM) and each hardware version (L1 Contactless, TQM, L2 per brand),
   * plus the bundle's shared EMV L2 contact kernel. One place to see a device.
   */
  deviceView({ device, platform = '', bundle = '' }) {
    const rec = { device, platform, bundle };
    const { splitVariant } = require('./devices');
    const n = this.store.norm();
    const { na } = this.coverageSlots();
    const base = splitVariant(n(rec.device)).base;
    const g = { platform: rec.platform || '', bundle: rec.bundle || '' };
    // The record's platform and bundle, plus records not placed in any bundle.
    const same = this.listRecords().filter((r) => ((r.platform || '') === g.platform && (r.bundle || '') === g.bundle) || (!r.platform && !r.bundle));
    const sum = (r) => ({ id: r.id, category: r.category, scheme: r.scheme, approval_number: r.approval_number, issue_date: r.issue_date, expiry_date: r.expiry_date,
      kernel_version: r.kernel_version, days: r.days, health: r.health, doc_count: r.doc_count, covers: r.covers || '', eol: r.eol || '', renewal_path: r.renewal_path || '', sharedFrom: r.sharedFrom || '', via: r.via || '' });
    const letters = this.validityLetters();
    const st = (r) => (r.eol ? 'eol' : r.expiry_date ? 'ok' : awaitingLoa(r) ? 'awaiting' : 'nodate');
    const parts = this.deviceParts(same, () => [g]).filter((p) => p.base === base)
      .sort((a, b) => (a.version ? Number(a.version.slice(2)) : 0) - (b.version ? Number(b.version.slice(2)) : 0));
    const sections = parts.map((d) => {
      const used = new Set();
      const rows = [];
      for (const slot of this.partSlots(d)) {
        const hits = d.records.filter((r) => r.category === slot.category && (!slot.scheme || String(r.scheme).toLowerCase() === slot.scheme.toLowerCase()));
        hits.forEach((r) => used.add(r.id));
        const label = slot.scheme ? `L2 · ${slot.label}` : slot.label;
        if (hits.length) for (const r of hits) rows.push({ slot: slot.key, label, status: st(r), record: sum(r) });
        else rows.push({ slot: slot.key, label, status: (na[d.key] || []).includes(slot.key) ? 'na' : 'missing', record: null });
      }
      for (const r of d.records) if (!used.has(r.id)) rows.push({ slot: '', label: `${r.category}${r.scheme && r.scheme !== 'EMVCo' ? ` · ${r.scheme}` : ''}`, status: st(r), record: sum(r) });
      return { device: d.device, label: d.label, key: d.key, version: d.version, reader: !!d.version, replacedBy: d.replacedBy || '', rows };
    });
    // The EMV L2 contact kernel is one approval for the whole bundle.
    const l2c = same.find((r) => r.category === 'EMV L2 Contact' && !r.archived && (r.platform || '') === g.platform && (r.bundle || '') === g.bundle);
    const dev = parts.length ? parts[0].device : device;
    const names = [...new Set([dev, ...parts.map((p) => p.device)])];
    const V = require('./validity');
    const seen = new Set();
    const validity = names.flatMap((nm) => V.lettersFor(nm, letters, n)).filter((L) => !seen.has(L.inboxId) && seen.add(L.inboxId))
      .map((L) => ({ inboxId: L.inboxId, document_id: L.document_id, family: L.family, interface: L.interface, reference: L.reference, issued: L.issued, label: V.letterLabel(L), perProduct: L.perProduct, pcdCaveat: L.pcdCaveat, group: names.map((nm) => V.groupOf(L, nm, n)).find(Boolean) || '' }));
    // The bundle's one L2 Contact LoA names one model; a contact validity letter is what extends it to this one.
    const pageK = require('./bundles').bundleKernel(this.kernelPages(), { category: 'EMV L2 Contact', platform: g.platform, bundle: g.bundle });
    const kernel = (l2c && l2c.kernel_version) || (pageK && pageK.kernel) || '';
    const contactLetters = names.flatMap((nm) => V.lettersFor(nm, letters, n, { iface: 'contact' }));
    let l2contactNote = null;
    if (contactLetters.length) {
      const L = contactLetters[0];
      const nm = names.find((x) => V.lettersFor(x, [L], n).length) || dev;
      const rule = kernel ? V.contactRuleBroken(L, nm, kernel, n) : null;
      l2contactNote = rule
        ? { level: 'bad', text: `The ${V.letterLabel(L)} allows only kernel ${rule.minVersion} or newer on ${nm}; this bundle runs ${kernel}.` }
        : { level: 'ok', text: `Covered by the ${V.letterLabel(L)}${(L.products.find((p) => n(p.value) === n(nm)) || {}).condition ? ` (${L.products.find((p) => n(p.value) === n(nm)).condition})` : ''}.` };
    } else if (l2c && n(l2c.device) !== n(dev)) {
      const fam = currentFamilies(letters, l2c.device, n);
      if (fam) l2contactNote = { level: 'warn', text: `The L2 Contact LoA names ${l2c.device}. ${dev} is not listed in the ${V.letterLabel(fam)}${fam.openList ? ', which says its list is not complete' : ''}. Confirm it is part of the family.` };
    }
    return { device: dev, platform: g.platform, bundle: g.bundle, sections, l2contact: l2c ? sum(l2c) : null, l2contactNote, validity };
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


  /**
   * Add a missing certification from its LOA: the record is created only once
   * a letter is given, and is filled from it. Without a letter nothing is made,
   * so a device never looks certified before its LOA is on file.
   */
  addCertWithLoa(slotInfo, { filename, bytes, pages = [], ocrPages = 0 } = {}) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    if (!buf.length && !(pages || []).some((p) => String(p).trim())) throw new Error('Choose the LOA for this certification');
    const id = this.createSlot(slotInfo);
    if (!id) throw new Error('Unknown certification');
    const dup = this.checkAttach(id, { bytes: buf });
    let documentId;
    if (dup) {
      documentId = dup.document.id;
      this.linkDocumentToRecord(id, documentId);
    } else {
      documentId = this.attachNewDocument(id, { filename, bytes: buf, pages, ocrPages }).documentId;
    }
    // Dates and approval number only from a letter in the file for this exact certification.
    const values = this.slotValues(documentId, id);
    if (values) this.linkDocumentToRecord(id, documentId, { useValues: true, values });
    return { id, documentId, existing: !!dup, values };
  }

  /** The approval number and dates a file gives one record, only from a letter of the record's own type and brand. */
  slotValues(documentId, recordId) {
    const rec = this.store.getRecord(recordId);
    const text = this.store.documentText(documentId);
    if (!rec || !text) return null;
    const { parseDocument } = require('./loa-parser');
    const same = (x) => x.category === rec.category && String(x.scheme).toLowerCase() === String(rec.scheme).toLowerCase();
    const L = parseDocument(text.split('\n\f\n')).filter((x) => !x.informational).find(same);
    if (!L) return null;
    const v = (f) => (f ? f.value : null);
    const out = { approval_number: v(L.approvalNumber) || '', issue_date: v(L.issueDate), expiry_date: v(L.expiryDate) };
    return out.approval_number || out.expiry_date ? out : null;
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

  /** Platforms and the devices each one runs, e.g. { UPP: ["Lane/3000", "Lane/5000"], Tetra: ["Desk/5000"] }. */
  listPlatformDevices() { return this.store.getSettings().platformDevices || {}; }

  /** Save (or with no devices remove) the device list of one platform. */
  setPlatformDevices(platform, devices) {
    const pf = String(platform || '').trim();
    if (!pf) throw new Error('Name the platform first');
    const all = { ...this.listPlatformDevices() };
    const n = this.store.norm();
    const seen = new Set();
    const list = [];
    for (const d of devices || []) {
      const v = String(d || '').trim();
      if (v && !seen.has(n(v))) { seen.add(n(v)); list.push(v); }
    }
    if (list.length) all[pf] = list; else delete all[pf];
    this.store.setSettings({ platformDevices: all });
    this.intake.rematch();
    return all;
  }

  /** The platform a device is listed under, or '' when it is on none (or on more than one). */
  platformForDevice(device) {
    const { presetPlatform } = require('./intake');
    return presetPlatform(device, this.listPlatformDevices(), this.store.norm());
  }

  /** Devices each platform already has in the register, to start a platform's list from. */
  devicesOnPlatform(platform) {
    const { splitVariant, baseDisplayName } = require('./devices');
    const n = this.store.norm();
    const out = new Map();
    for (const r of this.listRecords()) {
      if (r.platform !== platform) continue;
      const base = splitVariant(n(r.device)).base;
      if (!out.has(base) || n(r.device) === base) out.set(base, n(r.device) === base ? r.device : baseDisplayName(r.device));
    }
    return [...out.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  /** Give records with no platform the platform their device is listed under. */
  applyPlatformDevices() {
    const ids = {};
    for (const r of this.listRecords()) {
      if (r.platform) continue;
      const pf = this.platformForDevice(r.device);
      if (pf) (ids[pf] = ids[pf] || []).push(r.id);
    }
    const out = { changed: 0, skipped: [] };
    for (const [pf, list] of Object.entries(ids)) {
      const r = this.store.bulkUpdate(list, { platform: pf }, { source: 'platform list' });
      out.changed += r.changed;
      out.skipped.push(...r.skipped);
    }
    return out;
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
    const records = this.store.listRecords();
    const a = engine.analyze(records, {
      settings: this.store.getSettings(), asOf, tasks: this.store.taskStates(), inboxPending, replacements, norm: this.store.norm(),
    });
    a.summary.teamMailOpen = (this.store.getSettings().teamMail || []).filter((m) => m.status === 'open').length;
    // Every action names the kernel(s) its records run: decisions are made per kernel.
    const byId = new Map(records.map((r) => [r.id, r]));
    for (const x of a.actions) {
      const ks = [...new Set((x.recordIds || []).map((id) => byId.get(id)).filter((r) => r && /^EMV L2/.test(r.category)).map((r) => r.kernel_version || 'kernel not known'))];
      if (ks.length) x.kernels = ks;
    }
    return a;
  }

  /**
   * Bring records in line with the website bundle pages that have been read, with no typing:
   * 1. place records that have no bundle into the bundle whose page lists the same device,
   *    approval and date (a kernel on the record must be the one that bundle runs; a record
   *    typed "Other" takes the page's approval type when only one row fits);
   * 2. fill the kernel of every L2 record from its bundle's page (the kernel per brand at the
   *    top of the page; the EMV contact kernel for L2 Contact).
   * Each change is audited as "bundle page". Returns { placed, kernels }.
   */
  syncFromBundlePages() {
    const { bundleKernel, kernelMatches, bundleKey } = require('./bundles');
    const { certHome } = require('./devices');
    const pages = this.store.getSettings().bundlePages || {};
    const kp = this.kernelPages();
    if (!Object.keys(kp).length) return { placed: 0, kernels: 0 };
    const norm = this.store.norm();
    const home = (d, c) => certHome(norm(d), c).key;
    let placed = 0, kernels = 0;
    this.store.db.tx(() => {
      const recs = this.store.listRecords().filter((r) => !r.archived);
      const taken = new Set(recs.filter((r) => r.bundle).map((r) => `${bundleKey(r.platform, r.bundle)}|${home(r.device, r.category)}|${r.category}|${r.scheme || ''}`));
      for (const r of recs) {
        if (r.bundle || !r.expiry_date || !r.device) continue;
        const loose = !r.category || r.category === 'Other';
        const hits = [];
        for (const [key, pg] of Object.entries(pages)) {
          if (r.platform && pg.platform && r.platform.toLowerCase() !== String(pg.platform).toLowerCase()) continue;
          for (const row of pg.rows || []) {
            if (row.expiry_date !== r.expiry_date) continue;
            const cat = loose ? row.category : r.category;
            if (!loose && (row.category !== r.category || (row.scheme || '') !== (r.scheme || ''))) continue;
            if (home(row.device, cat) !== home(r.device, cat)) continue;
            if (r.kernel_version && /^EMV L2/.test(cat)) { const k = bundleKernel(kp, { ...r, category: cat, scheme: row.scheme, platform: pg.platform, bundle: pg.bundle }); if (k && !kernelMatches(r.kernel_version, k.ids)) continue; }
            hits.push({ key, pg, row });
          }
        }
        if (loose && new Set(hits.map((h) => `${h.row.category}|${h.row.scheme || ''}`)).size !== 1) continue;
        const free = hits.filter((h) => !taken.has(`${h.key}|${home(r.device, h.row.category)}|${h.row.category}|${h.row.scheme || ''}`))
          .sort((a, b) => (parseFloat(a.pg.bundle.replace(/\D+/, '')) || 0) - (parseFloat(b.pg.bundle.replace(/\D+/, '')) || 0));
        if (!free.length) continue;
        const h = free[0];
        const patch = { platform: h.pg.platform, bundle: h.pg.bundle, ...(loose ? { category: h.row.category, scheme: h.row.scheme || '' } : {}) };
        try {
          this.store.updateRecord(r.id, patch, { source: 'bundle page' });
          taken.add(`${h.key}|${home(r.device, h.row.category)}|${h.row.category}|${h.row.scheme || ''}`);
          placed++;
        } catch (_) { /* would clash with another record: left for review */ }
      }
      const { kernelIds } = require('./bundles');
      const same = (a, b) => kernelIds(a).join(' ') === kernelIds(b).join(' ');
      for (const r of this.store.listRecords()) {
        if (r.archived || !/^EMV L2/.test(r.category || '')) continue;
        const k = bundleKernel(kp, r);
        if (!k || !k.kernel) continue;
        const app = ((k.page && k.page.ctx && k.page.ctx.appVersions) || {})[r.category === 'EMV L2 Contact' ? 'EMV Contact' : r.scheme] || '';
        const patch = {};
        if (!r.kernel_version) patch.kernel_version = k.kernel;
        // A kernel the app filled in from a page earlier follows the page when it is read again (a person's entry is never touched).
        else if (!same(r.kernel_version, k.kernel)) {
          const last = this.store.auditLog({ recordId: r.id, limit: 200 }).find((a) => a.field === 'kernel_version');
          if (last && last.source === 'bundle page') patch.kernel_version = k.kernel;
        }
        if (app && !r.app_version) patch.app_version = app;
        if (!Object.keys(patch).length) continue;
        this.store.updateRecord(r.id, patch, { source: 'bundle page' });
        if (patch.kernel_version) kernels++;
      }
    });
    if (placed || kernels) this.store.setSettings({ lastPageSync: { at: new Date().toISOString(), placed, kernels } });
    return { placed, kernels };
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

  listInbox(status = 'pending') {
    const list = this.store.listInbox({ status: status === 'all' ? undefined : status });
    // Each L2 letter says which bundles its kernel belongs to, so a renewal is never read by device alone.
    const { kernelFit } = require('./bundles');
    const pages = this.kernelPages();
    const all = list.some((it) => /^EMV L2/.test((it.parsed || {}).category || '')) ? this.allBundles() : [];
    for (const it of list) {
      const L = it.parsed || {};
      if (!/^EMV L2/.test(L.category || '') || L.informational) continue;
      it.kernelFit = kernelFit(pages, { category: L.category, scheme: L.scheme, kernel: L.kernelVersion ? L.kernelVersion.value : '' }, all);
      it.kernelOptions = [...new Set((it.kernelFit ? it.kernelFit.platforms : []).flatMap((p) => p.others.map((o) => o.kernel)).concat(
        (it.kernelFit ? it.kernelFit.platforms : []).flatMap((p) => (p.fits.length && it.kernelFit.kernel ? [it.kernelFit.kernel] : []))))];
    }
    return list;
  }

  setInboxKernel(id, kernel) { return this.intake.setKernel(id, kernel); }

  /**
   * Questions for the certification team, as an email to copy: LOAs whose bundle cannot be
   * decided (kernel not stated, or no bundle runs it), bundle kernels not known yet, renewal
   * status for L2 approvals expiring soon (with their kernel), and kernels a mandate blocks.
   */
  certQuestions({ months = 12 } = {}) {
    const s = this.store.getSettings();
    return require('./questions').certQuestions({
      records: this.listRecords(), inbox: this.store.listInbox({ status: 'pending' }), pages: this.kernelPages(), bundles: this.allBundles(),
      months: Number(months) || 12, userName: s.userName || '', platformDevices: s.platformDevices || {},
    });
  }

  /** Every live approval's certification status, grouped with its kernel version leading. */
  certStatus() {
    return require('./questions').certStatus({ records: this.listRecords(), pages: this.kernelPages(), platformDevices: this.store.getSettings().platformDevices || {} });
  }

  /** Read a reply pasted from the certifications team into decisions to review. Changes nothing. */
  readCertReply(text) {
    return require('./questions').readCertReply({ text, records: this.listRecords(), pages: this.kernelPages() });
  }

  /**
   * Apply the decisions picked from a cert team reply: items [{ decision, ids, line, replacement, date }].
   * Each record gets the decision and a dated note quoting the team.
   */
  applyCertReply(items = []) {
    const { decisionPatch } = require('./questions');
    let changed = 0;
    const skipped = [];
    this.store.db.tx(() => {
      for (const it of items || []) {
        for (const id of it.ids || []) {
          const r = this.store.getRecord(id);
          if (!r) continue;
          const p = decisionPatch(it, r);
          if (!p) continue;
          try { if (this.store.updateRecord(id, p, { source: 'cert team reply' }).length) changed++; } catch (e) { skipped.push({ id, reason: e.message }); }
        }
      }
    });
    return { changed, skipped };
  }

  // ------------------------------------------------------------ team emails
  /**
   * Emails from team members, dropped or pasted in the LOA inbox. Each is read against
   * the register: decisions to confirm, questions only the person can settle, the
   * sender's own questions with answers from the register, and a follow-up reply.
   */
  teamMailContext() {
    const s = this.store.getSettings();
    return { records: this.listRecords(), pages: this.kernelPages(), aliases: this.store.aliases(), userName: s.userName || '' };
  }

  addTeamEmail(mail = {}) {
    const { teamMailEntry, readTeamEmail } = require('./teammail');
    const e = teamMailEntry(mail);
    if (!String(e.text).trim()) throw new Error('The email has no text to read');
    const all = this.store.getSettings().teamMail || [];
    const had = all.find((x) => x.id === e.id);
    const read = readTeamEmail(had || e, this.teamMailContext());
    // A dropped "please find attached" with nothing to act on is not kept; a pasted one always is.
    const empty = !read.items.length && !read.theyAsked.length && !read.forYou.length;
    if (empty && !mail.force && !had) return { skipped: true, from: e.from, subject: e.subject, counts: read.counts };
    if (!had) this.store.setSettings({ teamMail: [...all, e].slice(-200) });
    return { id: e.id, duplicate: !!had, from: e.from, subject: e.subject, counts: read.counts };
  }

  listTeamEmails({ status = 'open' } = {}) {
    const { readTeamEmail } = require('./teammail');
    const ctx = this.teamMailContext();
    return (this.store.getSettings().teamMail || []).filter((m) => status === 'all' || m.status === status)
      .map((m) => ({ ...m, read: readTeamEmail(m, ctx) })).reverse();
  }

  teamMailUpdate(id, fn) {
    const all = this.store.getSettings().teamMail || [];
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('That email is no longer in the inbox');
    all[i] = fn({ ...all[i] }) || all[i];
    this.store.setSettings({ teamMail: all });
    return all[i];
  }

  /** Answer one of the email's questions (a device name, which approvals, a scope, or a reply to the sender). */
  answerTeamEmail(id, key, value) {
    this.teamMailUpdate(id, (m) => { m.answers = { ...(m.answers || {}), [key]: value == null ? '' : String(value) }; return m; });
    return this.listTeamEmails({ status: 'all' }).find((m) => m.id === id);
  }

  /** Apply the decisions picked on a team email: items [{ key, decision, ids, line, replacement, date }]. */
  applyTeamEmail(id, items = []) {
    const { decisionPatch } = require('./questions');
    const m = (this.store.getSettings().teamMail || []).find((x) => x.id === id);
    if (!m) throw new Error('That email is no longer in the inbox');
    const who = `${m.from || 'team'} (email)`;
    let changed = 0;
    const skipped = [];
    this.store.db.tx(() => {
      for (const it of items || []) {
        for (const rid of it.ids || []) {
          const r = this.store.getRecord(rid);
          if (!r) continue;
          const p = decisionPatch(it, r, todayIso(), who);
          if (!p) continue;
          try { if (this.store.updateRecord(rid, p, { source: `team email: ${m.from}` }).length) changed++; } catch (e) { skipped.push({ id: rid, reason: e.message }); }
        }
      }
    });
    this.teamMailUpdate(id, (x) => { x.applied = [...new Set([...(x.applied || []), ...items.map((it) => it.key).filter(Boolean)])]; return x; });
    return { changed, skipped };
  }

  /** Mark a team email done (or open again). */
  closeTeamEmail(id, done = true) {
    this.teamMailUpdate(id, (m) => { m.status = done ? 'done' : 'open'; m.closedAt = done ? new Date().toISOString() : ''; return m; });
    return true;
  }

  /** Ask the local AI to read the email too: a summary, more questions for the person, more follow-ups. */
  async aiReadTeamEmail(id) {
    const { splitEmail, readTeamEmail } = require('./teammail');
    const m = (this.store.getSettings().teamMail || []).find((x) => x.id === id);
    if (!m) throw new Error('That email is no longer in the inbox');
    const ctx = this.teamMailContext();
    const read = readTeamEmail({ ...m, ai: null }, ctx);
    const ids = new Set(read.items.flatMap((it) => it.ids));
    const ai = await this.ai.readTeamEmail(splitEmail(m.text).body, {
      from: m.from, subject: m.subject, found: read.items.map((it) => `${it.summary} (${it.devices}): ${it.label}`), records: ctx.records.filter((r) => ids.has(r.id)),
    });
    this.teamMailUpdate(id, (x) => { x.ai = ai; return x; });
    return ai;
  }

  // ------------------------------------------------------------ letter templates
  /**
   * Letter templates: regions marked on a sample letter of each type (PCI, L1 Contact,
   * L1 Contact TQM, L1 Contactless, L1 Contactless TQM, L2 Contactless per brand) that
   * say where the device, approval number, dates and kernel are printed.
   */
  listLetterTemplates() {
    const { LETTER_TYPES, FIELDS } = require('./templates');
    const saved = this.store.getSettings().letterTemplates || {};
    return { types: LETTER_TYPES.map((t) => ({ ...t, template: saved[t.key] || null })), fields: FIELDS, kernelLabels: this.store.getSettings().kernelLabels || [] };
  }

  /** Forget a kernel label learned from a kernel you typed on a review card. */
  removeKernelLabel(label) {
    const all = (this.store.getSettings().kernelLabels || []).filter((x) => x.label !== label);
    this.store.setSettings({ kernelLabels: all });
    return all;
  }

  /** Saves even before any box is drawn (a placeholder, with or without its sample), so it can be finished later. Only Remove deletes it. */
  saveLetterTemplate(key, { regions = [], sample = null } = {}) {
    const { LETTER_TYPES, FIELDS } = require('./templates');
    const type = LETTER_TYPES.find((t) => t.key === key);
    if (!type) throw new Error('Unknown letter type');
    const ok = new Set(FIELDS.map((f) => f.key));
    const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));
    const clean = regions.filter((r) => ok.has(r.field) && Number(r.w) > 0.002 && Number(r.h) > 0.002)
      .map((r) => ({ field: r.field, page: Math.max(0, Math.floor(Number(r.page) || 0)), x: clamp(r.x), y: clamp(r.y), w: clamp(r.w), h: clamp(r.h) }));
    const all = { ...(this.store.getSettings().letterTemplates || {}) };
    const keepSample = sample || (all[key] && all[key].sample) || null;
    all[key] = { label: type.label, regions: clean, sample: keepSample, savedAt: new Date().toISOString() };
    this.store.setSettings({ letterTemplates: all });
    return all[key] || null;
  }

  removeLetterTemplate(key) {
    const all = { ...(this.store.getSettings().letterTemplates || {}) };
    delete all[key];
    this.store.setSettings({ letterTemplates: all });
    return null;
  }

  /** What each region reads on a sample: [{ field, text, value }]. */
  previewLetterTemplate(regions = [], words = []) {
    const { regionText, valueFor } = require('./templates');
    return regions.map((r) => { const text = regionText(words, r); return { field: r.field, text, value: valueFor(r.field, text) }; });
  }

  /** Guess the letter type of a sample from its text, to open the right template. */
  sampleLetterType(pages = []) {
    const { parseDocument } = require('./loa-parser');
    const { letterTypeOf } = require('./templates');
    const L = parseDocument(pages).find((x) => !x.informational);
    return L ? letterTypeOf(L) : '';
  }

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
  attachNewDocument(recordId, { filename, bytes, pages = [], ocrPages = 0, useValues = false }) {
    const { sha256, archiveFile } = require('./intake');
    if (!this.store.getRecord(recordId)) throw new Error('Record not found');
    const dup = this.checkAttach(recordId, { bytes });
    if (dup) return { duplicate: dup };
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    const text = (pages || []).join('\n\f\n');
    const stored = buf.length && this.archiveDir ? archiveFile(this.archiveDir, filename, buf) : null;
    const documentId = this.store.addDocument({ sha256: sha256(buf.length ? buf : Buffer.from(text)), filename, stored_path: stored, size: buf.length,
      page_count: pages.length, ocr_pages: ocrPages, text });
    const values = this.letterValues([documentId], recordId);
    this.linkDocumentToRecord(recordId, documentId, { useValues: useValues && !!values, values });
    return { documentId, values };
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
      const v = hits.filter((r) => ptsVersion(r.kernel_version) === ptsVersion(c.kernel_version));
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

  /**
   * Website changes to request, each with the evidence a reviewer checks: the LOA's kernel
   * next to the kernel the bundle runs, and the LOA file. Rows the website would reject are
   * held back with the reason: an LOA for another kernel, or an LOA file that names another device.
   */
  changeRequest() {
    const { bundleKernel, kernelMismatch, fitsNote } = require('./bundles');
    const { deviceFromFilename, splitVariant } = require('./devices');
    const pages = this.kernelPages();
    const norm = this.store.norm();
    const records = this.store.listRecords();
    const byId = new Map(records.map((r) => [r.id, r]));
    const devices = [...new Set(records.map((r) => r.device))];
    const rows = [], held = [];
    for (const row of reports.portalChanges(records)) {
      const r = byId.get(row.id);
      const k = bundleKernel(pages, r);
      const doc = this.store.documentsFor(r.id)[0];
      row.loaKernel = /^EMV L2/.test(r.category) ? r.kernel_version || '' : '';
      row.bundleKernel = k ? k.kernel : '';
      row.evidence = doc ? doc.filename : '';
      const km = kernelMismatch(pages, r);
      let reason = '';
      if (km) reason = `The LOA is for kernel ${km.kernel}; ${km.platform} ${km.bundle} runs ${km.expected}. Find the LOA for ${km.expected}.${fitsNote(km)}`;
      else if (doc && /^EMV L2/.test(r.category)) {
        // An LOA file named after another device, linked to this record alone, is usually the wrong letter.
        const named = deviceFromFilename(doc.filename, devices, norm);
        const links = this.db.get('SELECT COUNT(*) AS n FROM document_links WHERE document_id=?', [doc.id]).n;
        if (named && named.known && links === 1 && splitVariant(norm(named.value)).base !== splitVariant(norm(r.device)).base) reason = `The LOA on file (${doc.filename}) names ${named.value}, not ${r.device}. Link the ${r.device} letter.`;
      }
      if (reason) held.push({ ...row, reason }); else rows.push(row);
    }
    return { rows, held };
  }

  portalChanges() { return this.changeRequest().rows; }

  heldChanges() { return this.changeRequest().held; }

  /**
   * The website change request workbook. With `markRequested`, rows get a
   * change ID (CR-001…) and the status "Change Requested", so the next request
   * continues the numbering and the sent rows can be tracked until published.
   */
  async exportChangeRequest({ ids, markRequested = false } = {}) {
    const cr = this.changeRequest();
    let rows = cr.rows;
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
    return reports.exportChangeRequest(rows, { held: cr.held });
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
  /** Renames and merges that make device names follow the hardware version (CL) rules. Changes nothing. */
  clCleanupPlan() { return require('./clcleanup').plan(this.listRecords(), this.store.norm()); }

  /**
   * Apply picked items from clCleanupPlan (by record id). A rename changes the device name; a
   * merge keeps the record with the later expiry, moves the other's LOAs and missing values to
   * it, and moves the other to the Archive. A backup is taken first.
   */
  applyClCleanup(ids = []) {
    const want = new Set(ids);
    const items = this.clCleanupPlan().filter((x) => want.has(x.id));
    if (!items.length) return { renamed: 0, merged: 0, skipped: [] };
    this.backup('before-cl-cleanup');
    let renamed = 0, merged = 0;
    const skipped = [];
    const FILL = ['approval_number', 'issue_date', 'expiry_date', 'kernel_version', 'expiry_basis', 'restriction', 'notes'];
    for (const it of items) {
      try {
        if (it.action === 'rename') {
          this.store.updateRecord(it.id, { device: it.to }, { source: 'CL clean-up' });
          renamed++;
          continue;
        }
        const a = this.store.getRecord(it.id), b = this.store.getRecord(it.into.id);
        if (!a || !b) continue;
        const [keep, drop] = String(a.expiry_date || '') > String(b.expiry_date || '') ? [a, b] : [b, a];
        this.store.db.tx(() => {
          for (const d of this.store.documentsFor(drop.id)) this.store.linkDocument(d.id, keep.id);
          const fill = {};
          for (const f of FILL) if (!keep[f] && drop[f]) fill[f] = drop[f];
          if (keep.id === a.id) fill.device = it.to;
          this.store.archiveRecords([drop.id], { reason: `Merged into ${it.to} (CL clean-up)` });
          if (Object.keys(fill).length) this.store.updateRecord(keep.id, fill, { source: 'CL clean-up' });
        });
        merged++;
      } catch (e) { skipped.push({ id: it.id, label: `${it.from} · ${it.scheme} ${it.category}`, reason: e.message }); }
    }
    return { renamed, merged, skipped };
  }

  dataChecks() { return require('./integrity').dataChecks(this.listRecords(), { norm: this.store.norm(), pages: this.kernelPages(), validity: this.validityLetters() }); }

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
    this.store.tidyLevelFields();
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
  'activateReplacement', 'deviceCoverage', 'deviceProfile', 'listBundles', 'bundleView', 'kernelCatalog', 'setKernelCatalog', 'removeKernelBundle', 'importKernelCatalog', 'readBundlePage', 'bundleDifferences', 'cleanBundle', 'bundleReport', 'checkRecord', 'listReaderGroups', 'setReaderGroup', 'listFamilyNotes', 'setCoverageNA', 'createMissing', 'createSlot', 'addCertWithLoa', 'listTags', 'knownDevices', 'listAliases', 'listLearned', 'forgetLearned', 'setAlias', 'listFieldAliases', 'setFieldAlias', 'listPlatformDevices', 'setPlatformDevices', 'platformForDevice', 'devicesOnPlatform', 'applyPlatformDevices', 'previewAlias', 'applyAllAliases', 'listImports', 'getDashboard', 'getActions', 'setTask', 'digest', 'notificationHistory',
  'ingestDocument', 'documentFile', 'listInbox', 'setInboxKernel', 'certQuestions', 'syncFromBundlePages', 'clCleanupPlan', 'applyClCleanup', 'removeKernelLabel', 'certStatus', 'readCertReply', 'applyCertReply', 'listLetterTemplates', 'saveLetterTemplate', 'removeLetterTemplate', 'previewLetterTemplate', 'sampleLetterType', 'platformReference', 'setBundleCount', 'allBundles', 'applyInbox', 'rejectInbox', 'setInboxDefaults', 'approveInboxMany', 'rejectInboxMany', 'approveAllSafe', 'rematch', 'rereadInbox', 'listDocuments',
  'documentText', 'deviceView', 'listValidityLetters', 'unlinkDocument', 'checkAttach', 'linkDocumentToRecord', 'setEol', 'dataChecks', 'aiDataReview', 'briefingReport', 'exportL3Sheet', 'duplicateInfo', 'mapDuplicate', 'attachNewDocument', 'assistInbox', 'importTracker', 'importPortal', 'loadSampleData', 'clearAllData',
  'summaryReport', 'exportExcel', 'exportCsv', 'portalChanges', 'heldChanges', 'exportChangeRequest', 'auditLog', 'aiStatus', 'aiBriefing', 'aiAsk',
  'aiDraftEmail', 'addTeamEmail', 'listTeamEmails', 'answerTeamEmail', 'applyTeamEmail', 'closeTeamEmail', 'aiReadTeamEmail', 'backup', 'listBackups', 'restore', 'health',
];

module.exports = { AppApi, PUBLIC_METHODS };
