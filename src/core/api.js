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

  deleteRecord(id) { return this.store.deleteRecord(id); }

  bulkUpdate(ids, patch, tags = null) { return this.store.bulkUpdate(ids, patch || {}, { source: 'manual' }, tags); }

  listTags() { return this.store.allTags(); }

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

  setAlias(alias, device) {
    this.store.setAlias(alias, device);
    return { rematched: this.intake.rematch() };
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

  approveAllSafe() { return this.intake.approveAllSafe({ actor: this.store.actor }); }

  rematch() { return this.intake.rematch(); }

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
          const cur = this.store.findByKey(c);
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

  loadSampleData() {
    if (this.store.listRecords().length) throw new Error('Sample data can only be loaded into an empty database.');
    const report = mergeRecords(this.store, sampleRecords(), { filename: 'Sample data', kind: 'sample' });
    this.store.setSettings({ sampleLoaded: true });
    return report;
  }

  clearAllData() {
    this.backup('before-clear');
    this.db.tx(() => {
      for (const t of ['document_links', 'approvals', 'inbox', 'documents', 'audit', 'tasks', 'records', 'imports', 'notifications']) this.db.run(`DELETE FROM ${t}`);
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
  'info', 'getSettings', 'setSettings', 'listRecords', 'getRecord', 'saveRecord', 'deleteRecord', 'bulkUpdate',
  'activateReplacement', 'listTags', 'listAliases', 'setAlias', 'listImports', 'getDashboard', 'getActions', 'setTask', 'digest', 'notificationHistory',
  'ingestDocument', 'documentFile', 'listInbox', 'applyInbox', 'rejectInbox', 'approveAllSafe', 'rematch', 'listDocuments',
  'documentText', 'unlinkDocument', 'assistInbox', 'importTracker', 'importPortal', 'loadSampleData', 'clearAllData',
  'summaryReport', 'exportExcel', 'exportCsv', 'portalChanges', 'auditLog', 'aiStatus', 'aiBriefing', 'aiAsk',
  'aiDraftEmail', 'backup', 'listBackups', 'restore', 'health',
];

module.exports = { AppApi, PUBLIC_METHODS };
