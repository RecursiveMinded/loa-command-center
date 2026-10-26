'use strict';
// Data access for the app. Every change to a record goes through updateRecord
// so the audit trail is written in the same transaction as the change.

const crypto = require('crypto');
const { normalizeCategory, normalizeScheme } = require('./taxonomy');
const { makeNormalizer, DEFAULT_NOISE_WORDS } = require('./devices');

const RECORD_FIELDS = [
  'vendor', 'platform', 'bundle', 'device', 'family', 'category', 'scheme', 'kernel_version',
  'approval_number', 'issue_date', 'expiry_date', 'expiry_basis', 'restricted', 'stage',
  'disposition', 'owner', 'customer', 'market', 'next_action', 'next_action_date',
  'extension_used', 'notes', 'portal_date', 'portal_status', 'change_ticket', 'tags', 'archived',
  'source', 'verified_at', 'verified_by',
];
const BOOL_FIELDS = new Set(['restricted', 'extension_used', 'archived']);

const DEFAULT_SETTINGS = {
  userName: '',
  companyName: '',
  notify: { frequency: 'weekly', weekday: 1, monthday: 1, time: '08:30', enabled: true, lastSent: null },
  thresholds: [365, 180, 90, 60, 30],
  // Days before expiry that renewal work should start, per approval category.
  leadTimes: {
    'EMV L1 Contact': 180, 'EMV L1 Contactless': 180, 'EMV L2 Contact': 120,
    'EMV L2 Contactless': 120, 'PCI PTS': 270, TQM: 60, 'Letter of Equivalency': 0, Other: 90,
  },
  autoApproveConfidence: 90,
  noiseWords: DEFAULT_NOISE_WORDS,
  hideExpiredByDefault: true,
  ai: { provider: 'off', baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b', apiKey: '' },
  runInBackground: true,
  startWithWindows: false,
  autoUpdate: true,
  backupKeep: 14,
  lastBackup: null,
};

function nowIso() { return new Date().toISOString(); }

function uid() { return crypto.randomBytes(8).toString('hex'); }

class Store {
  constructor(db, { actor = '' } = {}) {
    this.db = db;
    this.actor = actor;
    this._norm = null;
  }

  // ---------------------------------------------------------------- settings
  getSettings() {
    const rows = this.db.all("SELECT key, value FROM settings WHERE key <> 'schema_version'");
    const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    for (const r of rows) {
      try {
        const v = JSON.parse(r.value);
        s[r.key] = v && typeof v === 'object' && !Array.isArray(v) && s[r.key] && typeof s[r.key] === 'object'
          ? { ...s[r.key], ...v } : v;
      } catch (_) { /* ignore corrupt setting */ }
    }
    return s;
  }

  setSettings(patch) {
    this.db.tx(() => {
      for (const [k, v] of Object.entries(patch || {})) {
        if (k === 'schema_version') continue;
        this.db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, JSON.stringify(v)]);
      }
    });
    this._norm = null;
    return this.getSettings();
  }

  norm() {
    if (!this._norm) this._norm = makeNormalizer(this.getSettings().noiseWords || DEFAULT_NOISE_WORDS);
    return this._norm;
  }

  aliases() {
    const out = {};
    for (const r of this.db.all('SELECT alias, device FROM aliases')) out[r.alias] = r.device;
    return out;
  }

  setAlias(alias, device) {
    const a = this.norm()(alias);
    if (!a) return;
    if (!device) this.db.run('DELETE FROM aliases WHERE alias=?', [a]);
    else this.db.run('INSERT INTO aliases(alias,device) VALUES(?,?) ON CONFLICT(alias) DO UPDATE SET device=excluded.device', [a, device]);
  }

  // ----------------------------------------------------------------- records
  recordKey(r) {
    const n = this.norm();
    const cat = normalizeCategory(r.category);
    const parts = [n(r.platform), n(r.bundle), n(r.device), cat.toLowerCase(), normalizeScheme(r.scheme).toLowerCase()];
    // A device can hold several PCI approvals at once (e.g. v5 and v6).
    if (cat === 'PCI PTS' && r.kernel_version) parts.push(n(r.kernel_version));
    return parts.join('|');
  }

  listRecords({ includeArchived = true } = {}) {
    const rows = this.db.all(`SELECT r.*, (SELECT COUNT(*) FROM document_links l WHERE l.record_id = r.id) AS doc_count
      FROM records r ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY device, category, scheme`);
    return rows.map(fixRow);
  }

  getRecord(id) {
    const r = this.db.get(`SELECT r.*, (SELECT COUNT(*) FROM document_links l WHERE l.record_id = r.id) AS doc_count FROM records r WHERE id=?`, [id]);
    return r ? fixRow(r) : null;
  }

  findByKey(rec) {
    const r = this.db.get('SELECT * FROM records WHERE rkey=?', [this.recordKey(rec)]);
    return r ? fixRow(r) : null;
  }

  createRecord(data, { source = 'manual', actor = this.actor, note = '' } = {}) {
    const rec = sanitize(data);
    if (!rec.device) throw new Error('Device is required');
    rec.category = normalizeCategory(rec.category || 'Other');
    rec.scheme = normalizeScheme(rec.scheme || '');
    const rkey = this.recordKey(rec);
    if (this.db.get('SELECT id FROM records WHERE rkey=?', [rkey])) {
      throw new Error(`A record for ${rec.device} / ${rec.category} / ${rec.scheme} already exists`);
    }
    const id = uid();
    const ts = nowIso();
    const cols = ['id', 'rkey', ...RECORD_FIELDS.filter((f) => rec[f] !== undefined), 'created_at', 'updated_at'];
    const vals = [id, rkey, ...RECORD_FIELDS.filter((f) => rec[f] !== undefined).map((f) => rec[f]), ts, ts];
    if (!cols.includes('source')) { cols.push('source'); vals.push(source); }
    this.db.tx(() => {
      this.db.run(`INSERT INTO records(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, vals);
      this.audit(id, 'create', '', '', `${rec.device} | ${rec.category} | ${rec.scheme}`, source, actor);
      if (note) this.audit(id, 'note', '', '', note, source, actor);
      if (rec.expiry_date || rec.approval_number) {
        this.db.run('INSERT INTO approvals(record_id, approval_number, issue_date, expiry_date, role, created_at, created_by) VALUES(?,?,?,?,?,?,?)',
          [id, rec.approval_number || '', rec.issue_date || null, rec.expiry_date || null, 'current', ts, actor]);
      }
    });
    return this.getRecord(id);
  }

  /** Apply a patch, writing one audit row per changed field. Returns changed fields. */
  updateRecord(id, patch, { source = 'manual', actor = this.actor } = {}) {
    const cur = this.db.get('SELECT * FROM records WHERE id=?', [id]);
    if (!cur) throw new Error('Record not found');
    const p = sanitize(patch);
    if (p.category !== undefined) p.category = normalizeCategory(p.category);
    if (p.scheme !== undefined) p.scheme = normalizeScheme(p.scheme);
    const changed = [];
    for (const f of RECORD_FIELDS) {
      if (p[f] === undefined) continue;
      const a = cur[f] == null ? '' : String(cur[f]);
      const b = p[f] == null ? '' : String(p[f]);
      if (a !== b) changed.push([f, cur[f], p[f]]);
    }
    if (!changed.length) return [];
    const merged = { ...cur, ...Object.fromEntries(changed.map((c) => [c[0], c[2]])) };
    const rkey = this.recordKey(merged);
    if (rkey !== cur.rkey && this.db.get('SELECT id FROM records WHERE rkey=? AND id<>?', [rkey, id])) {
      throw new Error(`Another record already has ${merged.device} / ${merged.category} / ${merged.scheme}${merged.platform ? ` on ${merged.platform}` : ''}`);
    }
    this.db.tx(() => {
      const sets = changed.map(([f]) => `${f}=?`).join(', ');
      this.db.run(`UPDATE records SET ${sets}, updated_at=? WHERE id=?`, [...changed.map((c) => c[2]), nowIso(), id]);
      if (rkey !== cur.rkey) this.db.run('UPDATE records SET rkey=? WHERE id=?', [rkey, id]);
      for (const [f, a, b] of changed) this.audit(id, 'update', f, a, b, source, actor);
    });
    return changed.map((c) => c[0]);
  }

  deleteRecord(id, { actor = this.actor } = {}) {
    const cur = this.getRecord(id);
    if (!cur) return false;
    this.db.tx(() => {
      this.audit(id, 'delete', '', `${cur.device} | ${cur.category} | ${cur.scheme}`, '', 'manual', actor);
      this.db.run('DELETE FROM records WHERE id=?', [id]);
    });
    return true;
  }

  /**
   * Apply one change to many records in a single write. A record that would
   * clash with another (same device, type and brand on that platform) is
   * skipped and reported instead of failing the whole batch.
   * tags: { add: [...], remove: [...] } edits each record's tag list.
   */
  bulkUpdate(ids, patch = {}, opts = {}, tags = null) {
    const out = { changed: 0, skipped: [] };
    this.db.tx(() => {
      for (const id of ids) {
        const p = { ...patch };
        if (tags) {
          const cur = this.db.get('SELECT tags FROM records WHERE id=?', [id]);
          if (!cur) continue;
          const drop = new Set(splitTags(tags.remove).map((t) => t.toLowerCase()));
          p.tags = joinTags(splitTags([...splitTags(cur.tags).filter((t) => !drop.has(t.toLowerCase())), ...splitTags(tags.add)]));
        }
        try {
          if (this.updateRecord(id, p, opts).length) out.changed++;
        } catch (e) {
          const r = this.db.get('SELECT device, scheme, category FROM records WHERE id=?', [id]);
          out.skipped.push({ id, label: r ? `${r.device} · ${r.scheme} ${r.category}` : id, reason: e.message });
        }
      }
    });
    return out;
  }

  allTags() {
    const counts = new Map();
    for (const r of this.db.all("SELECT tags FROM records WHERE tags <> '' AND archived = 0")) {
      for (const t of splitTags(r.tags)) {
        const k = t.toLowerCase();
        const e = counts.get(k) || { tag: t, count: 0 };
        e.count++;
        counts.set(k, e);
      }
    }
    return [...counts.values()].sort((a, b) => a.tag.localeCompare(b.tag));
  }

  // ---------------------------------------------------------------- approvals
  approvals(recordId) {
    return this.db.all(`SELECT a.*, d.filename FROM approvals a LEFT JOIN documents d ON d.id = a.document_id
      WHERE record_id=? ORDER BY COALESCE(a.expiry_date, '') DESC, a.id DESC`, [recordId]);
  }

  addApproval(recordId, a, { actor = this.actor } = {}) {
    this.db.run('INSERT INTO approvals(record_id, approval_number, issue_date, expiry_date, role, document_id, inbox_id, note, created_at, created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [recordId, a.approval_number || '', a.issue_date || null, a.expiry_date || null, a.role || 'current', a.document_id || null, a.inbox_id || null, a.note || '', nowIso(), actor]);
    return this.db.lastId();
  }

  setApprovalRole(approvalId, role) {
    this.db.run('UPDATE approvals SET role=? WHERE id=?', [role, approvalId]);
  }

  // ---------------------------------------------------------------- documents
  findDocumentByHash(sha) {
    return this.db.get('SELECT id, sha256, filename, stored_path, uploaded_at FROM documents WHERE sha256=?', [sha]);
  }

  addDocument(d) {
    this.db.run('INSERT INTO documents(sha256, filename, stored_path, size, page_count, ocr_pages, text, uploaded_at) VALUES(?,?,?,?,?,?,?,?)',
      [d.sha256, d.filename, d.stored_path || null, d.size || 0, d.page_count || 0, d.ocr_pages || 0, d.text || '', nowIso()]);
    return this.db.lastId();
  }

  getDocument(id) {
    return this.db.get('SELECT id, sha256, filename, stored_path, size, page_count, ocr_pages, uploaded_at FROM documents WHERE id=?', [id]);
  }

  documentText(id) {
    const r = this.db.get('SELECT text FROM documents WHERE id=?', [id]);
    return r ? r.text : '';
  }

  linkDocument(documentId, recordId) {
    this.db.run('INSERT OR IGNORE INTO document_links(document_id, record_id) VALUES(?,?)', [documentId, recordId]);
  }

  unlinkDocument(documentId, recordId, { actor = this.actor } = {}) {
    this.db.tx(() => {
      this.db.run('DELETE FROM document_links WHERE document_id=? AND record_id=?', [documentId, recordId]);
      this.audit(recordId, 'unlink-document', 'document', String(documentId), '', 'manual', actor);
    });
  }

  documentsFor(recordId) {
    return this.db.all(`SELECT d.id, d.filename, d.stored_path, d.size, d.uploaded_at, d.page_count FROM documents d
      JOIN document_links l ON l.document_id = d.id WHERE l.record_id=? ORDER BY d.uploaded_at DESC`, [recordId]);
  }

  listDocuments() {
    return this.db.all(`SELECT d.id, d.filename, d.stored_path, d.size, d.page_count, d.ocr_pages, d.uploaded_at,
      (SELECT COUNT(*) FROM document_links l WHERE l.document_id=d.id) AS links,
      (SELECT COUNT(*) FROM inbox i WHERE i.document_id=d.id AND i.status='pending') AS pending
      FROM documents d ORDER BY d.uploaded_at DESC`);
  }

  // -------------------------------------------------------------------- inbox
  addInbox(item) {
    this.db.run('INSERT INTO inbox(document_id, letter_index, parsed, proposals, status, note, created_at) VALUES(?,?,?,?,?,?,?)',
      [item.document_id, item.letter_index || 0, JSON.stringify(item.parsed), JSON.stringify(item.proposals || []), item.status || 'pending', item.note || '', nowIso()]);
    return this.db.lastId();
  }

  listInbox({ status } = {}) {
    const rows = this.db.all(`SELECT i.*, d.filename FROM inbox i LEFT JOIN documents d ON d.id=i.document_id
      ${status ? 'WHERE i.status=?' : ''} ORDER BY i.id DESC`, status ? [status] : []);
    return rows.map((r) => ({ ...r, parsed: JSON.parse(r.parsed), proposals: JSON.parse(r.proposals) }));
  }

  getInbox(id) {
    const r = this.db.get('SELECT i.*, d.filename FROM inbox i LEFT JOIN documents d ON d.id=i.document_id WHERE i.id=?', [id]);
    return r ? { ...r, parsed: JSON.parse(r.parsed), proposals: JSON.parse(r.proposals) } : null;
  }

  setInbox(id, patch) {
    const sets = [], vals = [];
    for (const k of ['status', 'note', 'decided_at']) if (patch[k] !== undefined) { sets.push(`${k}=?`); vals.push(patch[k]); }
    if (patch.proposals !== undefined) { sets.push('proposals=?'); vals.push(JSON.stringify(patch.proposals)); }
    if (patch.parsed !== undefined) { sets.push('parsed=?'); vals.push(JSON.stringify(patch.parsed)); }
    if (!sets.length) return;
    this.db.run(`UPDATE inbox SET ${sets.join(', ')} WHERE id=?`, [...vals, id]);
  }

  // -------------------------------------------------------------------- audit
  audit(recordId, action, fieldName, oldV, newV, source = '', actor = this.actor) {
    this.db.run('INSERT INTO audit(ts, actor, record_id, action, field, old_value, new_value, source) VALUES(?,?,?,?,?,?,?,?)',
      [nowIso(), actor || '', recordId, action, fieldName || '', oldV == null ? '' : String(oldV), newV == null ? '' : String(newV), source]);
  }

  auditLog({ recordId, limit = 500 } = {}) {
    return this.db.all(`SELECT a.*, r.device, r.category, r.scheme FROM audit a LEFT JOIN records r ON r.id=a.record_id
      ${recordId ? 'WHERE a.record_id=?' : ''} ORDER BY a.id DESC LIMIT ?`, recordId ? [recordId, limit] : [limit]);
  }

  // -------------------------------------------------------------------- tasks
  taskStates() {
    const out = {};
    for (const t of this.db.all('SELECT * FROM tasks')) out[t.key] = t;
    return out;
  }

  setTask(key, status, { snoozeUntil = null, note } = {}) {
    this.db.run(`INSERT INTO tasks(key, status, snooze_until, note, updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET status=excluded.status, snooze_until=excluded.snooze_until, note=COALESCE(excluded.note, tasks.note), updated_at=excluded.updated_at`,
    [key, status, snoozeUntil, note ?? '', nowIso()]);
  }

  // ------------------------------------------------------------ misc history
  logImport(row) {
    this.db.run('INSERT INTO imports(ts, filename, kind, added, updated, unchanged, skipped) VALUES(?,?,?,?,?,?,?)',
      [nowIso(), row.filename || '', row.kind || '', row.added || 0, row.updated || 0, row.unchanged || 0, row.skipped || 0]);
  }

  imports() { return this.db.all('SELECT * FROM imports ORDER BY id DESC LIMIT 100'); }

  logNotification(kind, title, body) {
    this.db.run('INSERT INTO notifications(ts, kind, title, body) VALUES(?,?,?,?)', [nowIso(), kind, title, body]);
  }

  notifications(limit = 50) { return this.db.all('SELECT * FROM notifications ORDER BY id DESC LIMIT ?', [limit]); }
}

function sanitize(data) {
  const out = {};
  for (const f of RECORD_FIELDS) {
    if (data[f] === undefined) continue;
    let v = data[f];
    if (BOOL_FIELDS.has(f)) v = v ? 1 : 0;
    else if (v == null) v = /date|_at$/.test(f) ? null : '';
    else v = typeof v === 'string' ? v.trim() : v;
    if (/(_date|_at)$/.test(f) && v === '') v = null;
    if (f === 'tags') v = joinTags(splitTags(v));
    out[f] = v;
  }
  return out;
}

/** Tags are stored as one comma-separated string; duplicates differ only by case. */
function splitTags(v) {
  const out = [];
  const seen = new Set();
  for (const t of (Array.isArray(v) ? v : String(v || '').split(/[,;]/))) {
    const s = String(t).trim().replace(/\s+/g, ' ');
    if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
  }
  return out;
}
function joinTags(list) { return list.join(', '); }

function fixRow(r) {
  for (const f of BOOL_FIELDS) r[f] = !!r[f];
  return r;
}

module.exports = { Store, RECORD_FIELDS, DEFAULT_SETTINGS, nowIso, splitTags };
