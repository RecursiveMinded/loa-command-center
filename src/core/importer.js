'use strict';
// Tracker import (XLSX / XLSM / CSV). Columns are recognized by name, so any
// vendor's spreadsheet works without configuration. Imports never overwrite
// a value a person typed in the app, and never replace a newer expiry with an
// older one; those cases are reported as conflicts instead.

const { parseDate } = require('./dates');
const { normalizeCategory, normalizeScheme } = require('./taxonomy');

const COLUMNS = {
  platform: ['platform', 'program', 'product line', 'solution', 'software', 'os platform'],
  bundle: ['kernel bundle', 'bundle', 'kernel bundle source', 'release', 'kb'],
  device: ['terminal', 'device', 'model', 'terminal model', 'device model', 'product', 'hardware', 'product name'],
  family: ['family', 'terminal family', 'device family', 'product family'],
  category: ['level', 'certification level', 'cert level', 'certification type', 'category', 'approval type', 'emv level'],
  scheme: ['card brand', 'brand', 'scheme', 'network', 'payment brand', 'card brand or cert type', 'cert type'],
  kernel_version: ['kernel version', 'kernel', 'version', 'pci version', 'firmware', 'firmware version', 'spec version'],
  approval_number: ['loa', 'loa number', 'loa reference', 'loa ref', 'approval number', 'approval', 'certificate', 'certificate number', 'reference', 'loa id'],
  issue_date: ['issue date', 'approval date', 'effective date', 'start date', 'issued', 'certification date'],
  expiry_date: ['exp date', 'expiration date', 'expiry', 'expiry date', 'expires', 'expiration', 'valid until', 'renewal date', 'end date'],
  owner: ['owner', 'accountable owner', 'responsible', 'assignee'],
  customer: ['customer', 'customer / processor', 'processor', 'acquirer', 'customers'],
  market: ['market', 'region', 'country', 'market / region'],
  stage: ['stage', 'workflow stage', 'status'],
  disposition: ['disposition', 'decision'],
  next_action: ['next action', 'action'],
  next_action_date: ['next action date', 'action date', 'target date', 'due date'],
  notes: ['notes', 'comments', 'comment', 'remarks'],
  tags: ['tags', 'tag', 'labels', 'groups'],
  portal_date: ['published date', 'website date', 'portal date', 'published value'],
};

function normHeader(h) {
  return String(h == null ? '' : h).toLowerCase().replace(/[\r\n]+/g, ' ').replace(/[^a-z0-9/ ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Map header cells to record fields. Exact synonym wins over contains. */
function mapHeaders(headers) {
  const map = {};
  const used = new Set();
  const hs = headers.map(normHeader);
  for (const pass of ['exact', 'contains']) {
    for (const [field, syns] of Object.entries(COLUMNS)) {
      if (map[field] != null) continue;
      for (let i = 0; i < hs.length; i++) {
        if (used.has(i) || !hs[i]) continue;
        const ok = pass === 'exact' ? syns.includes(hs[i]) : syns.some((s) => s.length > 3 && hs[i].includes(s));
        if (ok) { map[field] = i; used.add(i); break; }
      }
    }
  }
  return map;
}

function sheetHint(name) {
  const n = String(name || '');
  const cat = normalizeCategory(n);
  return ['EMV L1 Contact', 'EMV L1 Contactless', 'EMV L2 Contact', 'EMV L2 Contactless', 'PCI PTS', 'TQM'].includes(cat) ? cat : '';
}

function cellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.result !== undefined) return cellValue(v.result);
    if (v.text !== undefined) return String(v.text);
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.hyperlink && v.text) return v.text;
    return '';
  }
  return v;
}

/** Turn a 2D array into normalized record candidates. */
function rowsToRecords(table, { sheetName = '', defaults = {} } = {}) {
  let headerIdx = -1, map = null;
  for (let i = 0; i < Math.min(15, table.length); i++) {
    const m = mapHeaders(table[i]);
    if (m.device != null && Object.keys(m).length >= 2) { headerIdx = i; map = m; break; }
  }
  if (headerIdx < 0) return { records: [], skipped: table.length, mapping: null };
  const hint = sheetHint(sheetName);
  const out = [];
  let skipped = 0;
  for (let i = headerIdx + 1; i < table.length; i++) {
    const row = table[i];
    const get = (f) => (map[f] != null ? cellValue(row[map[f]]) : '');
    const device = String(get('device') || '').trim();
    if (!device) { skipped++; continue; }
    const rawScheme = String(get('scheme') || '').trim();
    let category = normalizeCategory(get('category') || hint || defaults.category || '');
    let scheme = normalizeScheme(rawScheme);
    // "Card Brand or Cert Type" columns sometimes hold "PCI v6" or "EMV Contact L1".
    if (!get('category') && rawScheme && /pci|emv|contact|level/i.test(rawScheme)) {
      const c = normalizeCategory(rawScheme);
      if (c && c !== rawScheme) category = c;
    }
    if (!category) category = scheme && !['EMVCo', 'PCI SSC'].includes(scheme) ? 'EMV L2 Contactless' : 'Other';
    if (!scheme || scheme === rawScheme && /contact|level|emv\b/i.test(rawScheme)) {
      scheme = category === 'PCI PTS' ? 'PCI SSC' : category.startsWith('EMV L1') || category === 'EMV L2 Contact' ? 'EMVCo' : category === 'TQM' ? 'Mastercard TQM' : (scheme || 'Other');
    }
    const rec = {
      platform: String(get('platform') || defaults.platform || '').trim(),
      bundle: String(get('bundle') || defaults.bundle || '').trim(),
      device,
      family: String(get('family') || '').trim(),
      category,
      scheme,
      kernel_version: String(get('kernel_version') || '').trim(),
      approval_number: String(get('approval_number') || '').trim(),
      issue_date: parseDate(get('issue_date')),
      expiry_date: parseDate(get('expiry_date')),
      owner: String(get('owner') || '').trim(),
      customer: String(get('customer') || '').trim(),
      market: String(get('market') || '').trim(),
      next_action: String(get('next_action') || '').trim(),
      next_action_date: parseDate(get('next_action_date')),
      notes: String(get('notes') || '').trim(),
      tags: String(get('tags') || '').trim(),
      portal_date: parseDate(get('portal_date')),
    };
    const st = String(get('stage') || '').trim();
    if (st) rec.stage = st;
    const dp = String(get('disposition') || '').trim();
    if (dp) rec.disposition = dp;
    out.push(rec);
  }
  return { records: out, skipped, mapping: Object.fromEntries(Object.entries(map).map(([f, i]) => [f, String(table[headerIdx][i] ?? '')])) };
}

function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  const delim = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

async function readWorkbook(filename, bytes) {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    return [{ name: filename.replace(/\.[^.]+$/, ''), rows: parseCsv(Buffer.from(bytes).toString('utf8')) }];
  }
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes));
  const sheets = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const vals = [];
      r.eachCell({ includeEmpty: true }, (c, col) => { vals[col - 1] = cellValue(c.value); });
      rows.push(vals);
    });
    sheets.push({ name: ws.name, rows });
  });
  return sheets;
}

const IMPORT_FIELDS = ['platform', 'bundle', 'family', 'kernel_version', 'approval_number', 'issue_date', 'expiry_date', 'owner', 'customer', 'market', 'next_action', 'next_action_date', 'notes', 'tags', 'portal_date', 'stage', 'disposition'];

/**
 * Merge candidates into the store. dryRun returns the same report without writing.
 */
function mergeRecords(store, candidates, { filename = '', dryRun = false, kind = 'tracker' } = {}) {
  const report = { added: 0, updated: 0, unchanged: 0, conflicts: [], duplicatesInFile: 0, total: candidates.length };
  const seen = new Set();
  const lastManual = (id, f) => store.db.get("SELECT ts FROM audit WHERE record_id=? AND field=? AND action='update' AND source='manual' ORDER BY id DESC LIMIT 1", [id, f]);
  const work = () => {
    for (const c of candidates) {
      const key = store.recordKey(c);
      if (seen.has(key)) { report.duplicatesInFile++; continue; }
      seen.add(key);
      const cur = store.findByKey(c);
      if (!cur) {
        report.added++;
        if (!dryRun) store.createRecord({ ...c, source: kind }, { source: `Import: ${filename}` });
        continue;
      }
      const patch = {};
      for (const f of IMPORT_FIELDS) {
        const nv = c[f];
        if (nv == null || nv === '') continue;
        const ov = cur[f];
        if (String(ov ?? '') === String(nv)) continue;
        if (f === 'expiry_date' && ov && nv < ov) {
          report.conflicts.push({ device: cur.device, scheme: cur.scheme, category: cur.category, field: f, current: ov, incoming: nv, reason: 'Older than the date on file' });
          continue;
        }
        if (ov && lastManual(cur.id, f)) {
          report.conflicts.push({ device: cur.device, scheme: cur.scheme, category: cur.category, field: f, current: ov, incoming: nv, reason: 'Edited by hand in the app' });
          continue;
        }
        if ((f === 'stage' || f === 'disposition') && ov && ov !== 'Decision Required') continue;
        patch[f] = nv;
      }
      if (Object.keys(patch).length) {
        report.updated++;
        if (!dryRun) store.updateRecord(cur.id, patch, { source: `Import: ${filename}` });
      } else report.unchanged++;
    }
  };
  if (dryRun) work(); else store.db.tx(work);
  if (!dryRun) store.logImport({ filename, kind, added: report.added, updated: report.updated, unchanged: report.unchanged, skipped: report.duplicatesInFile });
  return report;
}

async function importTracker(store, { filename, bytes, dryRun = false, defaults = {} }) {
  const sheets = await readWorkbook(filename, bytes);
  const all = [];
  const sheetReports = [];
  for (const s of sheets) {
    const { records, skipped, mapping } = rowsToRecords(s.rows, { sheetName: s.name, defaults });
    sheetReports.push({ sheet: s.name, rows: records.length, skipped, mapping });
    all.push(...records);
  }
  const report = mergeRecords(store, all, { filename, dryRun });
  return { ...report, sheets: sheetReports };
}

module.exports = { importTracker, mergeRecords, rowsToRecords, mapHeaders, parseCsv, readWorkbook, COLUMNS };
