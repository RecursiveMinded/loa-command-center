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
const DEFAULT_BRANDS = ['Visa', 'Mastercard', 'Amex', 'Discover', 'UnionPay', 'JCB', 'Interac'];

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
      dispositions: taxonomy.DISPOSITIONS, portalStatuses: taxonomy.PORTAL_STATUSES,
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
   * What each device needs to be certified. A contact device needs PCI, L1
   * Contact and TQM; a contactless reader (CL1, CL2...) needs L1 Contactless,
   * TQM and an L2 Contactless approval from every required brand. Each cell
   * holds the record that covers it, or is missing / not applicable.
   */
  deviceCoverage() {
    const { contact, reader, brands, na } = this.coverageSlots();
    const n = this.store.norm();
    const devices = new Map();
    for (const r of this.listRecords()) {
      const key = n(r.device);
      const grp = [r.platform, r.bundle].filter(Boolean).join(' · ') || 'Unassigned';
      const k = `${grp}||${key}`;
      if (!devices.has(k)) devices.set(k, { grp, platform: r.platform || '', bundle: r.bundle || '', device: r.device, key, records: [] });
      devices.get(k).records.push(r);
    }
    const better = (a, b) => (!b || (a.days ?? -1e9) > (b.days ?? -1e9) ? a : b);
    const rows = [];
    let missing = 0;
    for (const d of devices.values()) {
      const isReader = /CL\d+$/.test(d.key);
      const hasCless = d.records.some((r) => /Contactless/.test(r.category));
      // A device with a built-in reader but no CL suffix needs both sets.
      const slots = isReader ? reader : hasCless ? [...contact, ...reader] : contact;
      const cells = {};
      for (const slot of [...contact, ...reader]) {
        const hits = d.records.filter((r) => r.category === slot.category && (!slot.scheme || String(r.scheme).toLowerCase() === slot.scheme.toLowerCase()));
        const rec = hits.reduce((b, r) => better(r, b), null);
        const needed = slots.includes(slot);
        const isNa = (na[d.key] || []).includes(slot.key);
        const status = rec ? (rec.expiry_date ? 'ok' : 'nodate') : isNa ? 'na' : needed ? 'missing' : 'none';
        if (status === 'missing') missing++;
        cells[slot.key] = { status, record: rec ? { id: rec.id, expiry_date: rec.expiry_date, days: rec.days, health: rec.health, approval_number: rec.approval_number, scheme: rec.scheme } : null };
      }
      rows.push({ grp: d.grp, platform: d.platform, bundle: d.bundle, device: d.device, key: d.key, reader: isReader,
        missing: Object.values(cells).filter((c) => c.status === 'missing').length, cells });
    }
    rows.sort((a, b) => a.grp.localeCompare(b.grp, undefined, { numeric: true }) || a.device.localeCompare(b.device, undefined, { numeric: true }));
    return { columns: [...contact, ...reader].map(({ key, label, group }) => ({ key, label, group })), rows, missing, brands };
  }

  /** The certifications a contact device and a contactless reader need. */
  coverageSlots() {
    const s = this.store.getSettings();
    const brands = s.requiredBrands && s.requiredBrands.length ? s.requiredBrands : DEFAULT_BRANDS;
    const contact = [
      { key: 'pci', label: 'PCI', group: 'Contact device', category: 'PCI PTS' },
      { key: 'l1c', label: 'L1 Contact', group: 'Contact device', category: 'EMV L1 Contact' },
      { key: 'tqm', label: 'TQM', group: 'Contact device', category: 'TQM' },
    ];
    const reader = [
      { key: 'l1cl', label: 'L1 Contactless', group: 'Contactless reader', category: 'EMV L1 Contactless' },
      { key: 'tqmcl', label: 'TQM', group: 'Contactless reader', category: 'TQM' },
      ...brands.map((b) => ({ key: `l2:${b}`, label: b, group: 'L2 Contactless', category: 'EMV L2 Contactless', scheme: b })),
    ];
    return { contact, reader, brands, na: s.coverageNA || {} };
  }

  /**
   * Every certification of the physical device a record belongs to: the
   * terminal (PCI, L1 Contact, TQM) and each contactless reader in it (L1
   * Contactless, TQM, L2 per brand), on the record's platform and bundle.
   */
  deviceProfile(recordId) {
    const rec = this.store.getRecord(recordId);
    if (!rec) return null;
    const { splitVariant } = require('./devices');
    const n = this.store.norm();
    const { contact, reader, na } = this.coverageSlots();
    const base = splitVariant(n(rec.device)).base;
    const all = this.listRecords().filter((r) => (r.platform || '') === (rec.platform || '') && (r.bundle || '') === (rec.bundle || '') && splitVariant(n(r.device)).base === base);
    const byDev = new Map();
    for (const r of all) {
      const k = n(r.device);
      if (!byDev.has(k)) byDev.set(k, { key: k, device: r.device, records: [] });
      byDev.get(k).records.push(r);
    }
    const sum = (r) => ({ id: r.id, category: r.category, scheme: r.scheme, approval_number: r.approval_number, issue_date: r.issue_date, expiry_date: r.expiry_date,
      kernel_version: r.kernel_version, days: r.days, health: r.health, doc_count: r.doc_count });
    const sections = [...byDev.values()].sort((a, b) => a.key.length - b.key.length || a.key.localeCompare(b.key)).map((d) => {
      const isReader = /CL\d+$/.test(d.key);
      const hasCless = d.records.some((r) => /Contactless/.test(r.category));
      const slots = isReader ? reader : hasCless ? [...contact, ...reader] : contact;
      const used = new Set();
      const rows = [];
      for (const slot of slots) {
        const hits = d.records.filter((r) => r.category === slot.category && (!slot.scheme || String(r.scheme).toLowerCase() === slot.scheme.toLowerCase()));
        hits.forEach((r) => used.add(r.id));
        if (hits.length) for (const r of hits) rows.push({ slot: slot.key, label: slot.scheme ? `L2 Contactless · ${slot.label}` : slot.label, status: r.expiry_date ? 'ok' : 'nodate', record: sum(r) });
        else rows.push({ slot: slot.key, label: slot.scheme ? `L2 Contactless · ${slot.label}` : slot.label, status: (na[d.key] || []).includes(slot.key) ? 'na' : 'missing', record: null });
      }
      for (const r of d.records) if (!used.has(r.id)) rows.push({ slot: '', label: `${r.category}${r.scheme && r.scheme !== 'EMVCo' ? ` · ${r.scheme}` : ''}`, status: r.expiry_date ? 'ok' : 'nodate', record: sum(r) });
      return { device: d.device, key: d.key, reader: isReader, rows };
    });
    return { platform: rec.platform || '', bundle: rec.bundle || '', sections };
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
    const SLOT = { pci: ['PCI PTS', 'PCI SSC'], l1c: ['EMV L1 Contact', 'EMVCo'], tqm: ['TQM', 'Mastercard TQM'], l1cl: ['EMV L1 Contactless', 'EMVCo'], tqmcl: ['TQM', 'Mastercard TQM'] };
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
      settings: this.store.getSettings(), asOf, tasks: this.store.taskStates(), inboxPending, replacements,
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
    const seg = require('./loa-parser').segmentLetters(text.split('\n\f\n'))[it.letter_index] || { text };
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
    const analysis = engine.analyze(records, { settings: this.store.getSettings(), asOf, tasks: this.store.taskStates(), replacements: this.db.all("SELECT * FROM approvals WHERE role='replacement'") });
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

  aiAsk(question) { return this.ai.ask(question, this.analysis(), this.store.listRecords()); }

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
    this.store.migrateL2Contact();
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
  'activateReplacement', 'deviceCoverage', 'deviceProfile', 'setCoverageNA', 'createMissing', 'createSlot', 'listTags', 'knownDevices', 'listAliases', 'setAlias', 'listFieldAliases', 'setFieldAlias', 'previewAlias', 'applyAllAliases', 'listImports', 'getDashboard', 'getActions', 'setTask', 'digest', 'notificationHistory',
  'ingestDocument', 'documentFile', 'listInbox', 'applyInbox', 'rejectInbox', 'setInboxDefaults', 'approveInboxMany', 'rejectInboxMany', 'approveAllSafe', 'rematch', 'rereadInbox', 'listDocuments',
  'documentText', 'unlinkDocument', 'checkAttach', 'linkDocumentToRecord', 'attachNewDocument', 'assistInbox', 'importTracker', 'importPortal', 'loadSampleData', 'clearAllData',
  'summaryReport', 'exportExcel', 'exportCsv', 'portalChanges', 'exportChangeRequest', 'auditLog', 'aiStatus', 'aiBriefing', 'aiAsk',
  'aiDraftEmail', 'backup', 'listBackups', 'restore', 'health',
];

module.exports = { AppApi, PUBLIC_METHODS };
