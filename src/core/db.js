'use strict';
// SQLite via sql.js (WebAssembly). No native modules, so the Windows build has
// nothing to compile. The database lives in memory and is written to disk
// atomically (temp file + rename) after every committed change.

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  rkey TEXT UNIQUE,
  vendor TEXT DEFAULT '',
  platform TEXT DEFAULT '',
  bundle TEXT DEFAULT '',
  device TEXT NOT NULL,
  family TEXT DEFAULT '',
  category TEXT DEFAULT '',
  scheme TEXT DEFAULT '',
  kernel_version TEXT DEFAULT '',
  approval_number TEXT DEFAULT '',
  issue_date TEXT,
  expiry_date TEXT,
  expiry_basis TEXT DEFAULT '',
  restricted INTEGER DEFAULT 0,
  stage TEXT DEFAULT '',
  disposition TEXT DEFAULT 'Decision Required',
  owner TEXT DEFAULT '',
  customer TEXT DEFAULT '',
  market TEXT DEFAULT '',
  next_action TEXT DEFAULT '',
  next_action_date TEXT,
  extension_used INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  portal_date TEXT,
  portal_status TEXT DEFAULT 'Not Tracked',
  change_ticket TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  archived INTEGER DEFAULT 0,
  source TEXT DEFAULT 'manual',
  verified_at TEXT,
  verified_by TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  approval_number TEXT DEFAULT '',
  issue_date TEXT,
  expiry_date TEXT,
  role TEXT NOT NULL DEFAULT 'current',
  document_id INTEGER REFERENCES documents(id),
  inbox_id INTEGER,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_approvals_record ON approvals(record_id);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT UNIQUE NOT NULL,
  filename TEXT NOT NULL,
  stored_path TEXT,
  size INTEGER DEFAULT 0,
  page_count INTEGER DEFAULT 0,
  ocr_pages INTEGER DEFAULT 0,
  text TEXT DEFAULT '',
  uploaded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_links (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, record_id)
);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  letter_index INTEGER DEFAULT 0,
  parsed TEXT NOT NULL,
  proposals TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_inbox_status ON inbox(status);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT DEFAULT '',
  record_id TEXT,
  action TEXT NOT NULL,
  field TEXT DEFAULT '',
  old_value TEXT,
  new_value TEXT,
  source TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_audit_record ON audit(record_id);
CREATE TABLE IF NOT EXISTS tasks (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'open',
  snooze_until TEXT,
  note TEXT DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  filename TEXT,
  kind TEXT,
  added INTEGER DEFAULT 0,
  updated INTEGER DEFAULT 0,
  unchanged INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS aliases (
  alias TEXT PRIMARY KEY,
  device TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT,
  title TEXT,
  body TEXT
);
`;

let SQL = null;
async function loadSql() {
  if (SQL) return SQL;
  const initSqlJs = require('sql.js');
  const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
  SQL = await initSqlJs({ locateFile: (f) => path.join(wasmDir, f) });
  return SQL;
}

class Database {
  constructor(sqlDb, file) {
    this.db = sqlDb;
    this.file = file; // null = in-memory only (tests)
    this.depth = 0;
    this.dirty = false;
    this.db.run('PRAGMA foreign_keys = ON;');
  }

  static async open(file) {
    const S = await loadSql();
    let sqlDb;
    if (file && fs.existsSync(file)) {
      sqlDb = new S.Database(fs.readFileSync(file));
    } else {
      sqlDb = new S.Database();
    }
    const d = new Database(sqlDb, file || null);
    d.migrate();
    return d;
  }

  migrate() {
    this.db.exec(SCHEMA);
    const v = this.get("SELECT value FROM settings WHERE key='schema_version'");
    // v2: free-form tags on records (platform groups, programs, customers…).
    if (!this.all('PRAGMA table_info(records)').some((c) => c.name === 'tags')) this.db.exec("ALTER TABLE records ADD COLUMN tags TEXT DEFAULT ''");
    const ver = JSON.stringify(SCHEMA_VERSION);
    if (!v) this.run("INSERT INTO settings(key,value) VALUES('schema_version', ?)", [ver]);
    else if (v.value !== ver) this.run("UPDATE settings SET value=? WHERE key='schema_version'", [ver]);
    this.save();
  }

  run(sql, params = []) {
    this.db.run(sql, params);
    this.dirty = true;
    if (this.depth === 0) this.save();
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(sql, params = []) {
    return this.all(sql, params)[0] || null;
  }

  lastId() {
    return this.get('SELECT last_insert_rowid() AS id').id;
  }

  /** Run fn inside a transaction; all-or-nothing, one disk write at the end. */
  tx(fn) {
    if (this.depth > 0) {
      this.depth++;
      try { return fn(); } finally { this.depth--; }
    }
    this.depth = 1;
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      this.depth = 0;
      this.save();
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
      this.depth = 0;
      throw e;
    }
  }

  save() {
    if (!this.file) { this.dirty = false; return; }
    const data = Buffer.from(this.db.export());
    // sql.js export() resets pragmas on some versions; re-enable FK checks.
    this.db.run('PRAGMA foreign_keys = ON;');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  exportBytes() {
    return Buffer.from(this.db.export());
  }

  integrityCheck() {
    const r = this.get('PRAGMA integrity_check');
    return r ? Object.values(r)[0] : 'unknown';
  }

  close() {
    if (this.dirty) this.save();
    this.db.close();
  }
}

module.exports = { Database, loadSql, SCHEMA_VERSION };
