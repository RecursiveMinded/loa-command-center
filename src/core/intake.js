'use strict';
// LOA intake: document in, review queue out. Nothing touches an approved
// record until a person approves a proposal (or uses "Approve all safe",
// which only applies high-confidence, warning-free proposals).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseDocument } = require('./loa-parser');
const { deviceScore, wildcardRegex, splitVariant, deviceFromFilename, categoryFromFilename, schemeFromFilename } = require('./devices');
const { todayIso, daysBetween } = require('./dates');
const { coverage } = require('./lifecycle');

const RENEWAL_STAGES = new Set(['Renewal Requested', 'Pending New LOA', 'Replacement Received']);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function safeName(name) {
  return String(name || 'document').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150) || 'document';
}

/** Copy the file into the archive without ever overwriting an earlier file. */
function archiveFile(archiveDir, filename, bytes) {
  const year = String(new Date().getFullYear());
  const dir = path.join(archiveDir, year);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(filename);
  const stem = safeName(path.basename(filename, ext));
  let target = path.join(dir, `${stem}${ext}`);
  let n = 1;
  while (fs.existsSync(target)) target = path.join(dir, `${stem} (${n++})${ext}`);
  fs.writeFileSync(target, bytes);
  return target;
}

/** Strip marketing words so a new record gets a clean device name. */
function displayDevice(name, noiseWords) {
  let s = String(name || '').trim();
  for (const w of noiseWords || []) s = s.replace(new RegExp(`(^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'gi'), '$1');
  return s.replace(/\s+/g, ' ').trim() || String(name || '').trim();
}

function val(f) { return f ? f.value : null; }

/**
 * Build review proposals for one parsed letter against the current records.
 * Proposal actions:
 *   update       - newer approval replaces the current one (renewal)
 *   replacement  - newer approval that is not effective yet (overlap tracking)
 *   attach       - same approval already recorded; just link the evidence
 *   history      - older than what is recorded; link as history only
 *   create       - no matching record; create one
 *   unmatched    - family/wildcard name that needs the user to choose records
 */
function buildProposals(letter, records, { norm, aliases = {}, noiseWords = [], asOf = todayIso(), auditFor } = {}) {
  const proposals = [];
  // Supporting documents (bulletins, equivalency letters) never change records.
  if (letter.informational) return proposals;

  const expiry = val(letter.expiryDate);
  const issue = val(letter.issueDate);
  const approval = val(letter.approvalNumber);
  const sameKind = records.filter((r) => r.category === letter.category && sameScheme(r.scheme, letter.scheme));

  for (const prod of letter.products) {
    const pExpiry = prod.expiry || expiry;
    const scored = sameKind
      .map((r) => {
        let s = deviceScore(prod.value, r.device, norm, aliases);
        // TQM: IFM labels belong to the contact device, PCD labels to the contactless reader.
        if (s && prod.interface) {
          const contactless = !!splitVariant(norm(r.device)).variant;
          if ((prod.interface.includes('PCD') && !contactless) || (prod.interface.includes('IFM') && contactless)) s = 0;
        }
        if (s && approval && r.approval_number && r.approval_number === approval) s = Math.min(100, s + 10);
        return { r, s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);

    const isFamily = !!wildcardRegex(splitVariant(norm(prod.value)).base);
    if (!scored.length) {
      // Statements that list many products (e.g. a TQM statement) mention
      // devices outside this portfolio; do not offer to create those.
      if (letter.products.length >= 4) continue;
      if (letter.category === 'TQM' && prod.source !== 'filename') continue;
      if (isFamily) {
        proposals.push({ action: 'unmatched', device: prod.value, category: letter.category, scheme: letter.scheme, score: 0, changes: {}, warnings: [`"${prod.value}" names a device family. Choose the records it covers.`] });
        continue;
      }
      const device = displayDevice(prod.value, noiseWords);
      const place = inferPlace(device, records, norm);
      proposals.push({
        action: 'create',
        device,
        category: letter.category,
        scheme: letter.scheme,
        score: 0,
        record: { ...letterRecord(letter, device, prod), ...place.fields },
        note: place.note,
        changes: {},
        warnings: pExpiry ? [] : ['No expiry date: the record will show as "Missing date"'],
      });
      continue;
    }

    // Exact/strong matches; a family name may legitimately match many records.
    const top = scored[0].s;
    let chosen = scored.filter((x) => x.s >= Math.min(top, isFamily ? 60 : 80));
    // Several records for one device (e.g. PCI v5 and v6): prefer the one this letter is about.
    const exact = chosen.filter((x) => (pExpiry && x.r.expiry_date === pExpiry) || (approval && x.r.approval_number === approval));
    if (exact.length) chosen = exact;
    // "Lane/5000" may match both the CL2 and CL3 readers; a person has to pick.
    const ambiguous = chosen.length > 1 && !isFamily && !splitVariant(norm(prod.value)).variant
      && chosen.some((x) => splitVariant(norm(x.r.device)).variant);
    for (const { r, s } of chosen) {
      const p = proposalFor(r, s, { ...letter, approval: prod.label || approval, expiry: pExpiry, issue }, { asOf, auditFor });
      if (ambiguous) p.warnings = [...p.warnings, `The letter says "${prod.value}" without a reader version (CL1, CL2...). Confirm it covers ${r.device}.`];
      proposals.push(p);
    }
  }
  return dedupe(proposals);
}

/**
 * Platform and bundle for a new record, taken from the register: the same
 * device under another brand or type, else every device of its family
 * ("Self/...") when they all share one platform.
 */
function inferPlace(device, records, norm) {
  const key = norm(device);
  const pickMost = (list, f) => {
    const c = {};
    for (const r of list) if (r[f]) c[r[f]] = (c[r[f]] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  };
  const same = records.filter((r) => norm(r.device) === key);
  const base = splitVariant(key).base;
  const sameBase = same.length ? same : records.filter((r) => splitVariant(norm(r.device)).base === base);
  if (sameBase.length) {
    const p = pickMost(sameBase, 'platform'), b = pickMost(sameBase, 'bundle');
    if (p || b) {
      return { fields: { ...(p ? { platform: p[0] } : {}), ...(b ? { bundle: b[0] } : {}) },
        note: `${[p && p[0], b && b[0]].filter(Boolean).join(' · ')} from your other ${sameBase[0].device} records` };
    }
  }
  const fam = (key.match(/^[A-Z]+/) || [''])[0];
  if (fam.length >= 2) {
    const kin = records.filter((r) => (norm(r.device).match(/^[A-Z]+/) || [''])[0] === fam && r.platform);
    const plats = [...new Set(kin.map((r) => r.platform))];
    if (kin.length >= 2 && plats.length === 1) return { fields: { platform: plats[0] }, note: `Platform ${plats[0]}, like your other ${fam[0]}${fam.slice(1).toLowerCase()} devices` };
  }
  return { fields: {}, note: '' };
}

/** A new record built from a letter's details, for one device it names. */
function letterRecord(letter, device, prod = {}) {
  return {
    device,
    category: letter.category,
    scheme: letter.scheme,
    approval_number: prod.label || val(letter.approvalNumber) || '',
    issue_date: val(letter.issueDate),
    expiry_date: prod.expiry || val(letter.expiryDate),
    expiry_basis: letter.expiryBasis || '',
    kernel_version: prod.interface || val(letter.kernelVersion) || '',
    restricted: !!letter.restricted,
    stage: letter.restricted ? 'Restricted Extension' : '',
  };
}

/**
 * Files are often named after the device and approval type
 * ("Self4000CL2_EmvL1Cless.pdf"). When a file holds a single letter and the
 * text does not name the device, take it from the file name instead.
 */
function fromFilename(letters, filename, records, norm) {
  const approvals = letters.filter((l) => !l.informational);
  if (approvals.length !== 1) return;
  const L = approvals[0];
  const known = [...new Set(records.map((r) => r.device))];
  const dev = deviceFromFilename(filename, known, norm);
  // Text that names no device you track and does not look like a model code
  // ("1 Main Street" from a letterhead) loses to a file name that does.
  const isKnown = (v) => known.some((d) => deviceScore(v, d, norm) > 0);
  const modelLike = (v) => /[A-Za-z]{1,12}[\s/\-_]?\d{3,5}/.test(v);
  const weakText = L.products.length && !L.products.some((p) => isKnown(p.value) || modelLike(p.value));
  if (dev && (!L.products.length || weakText)) {
    const was = L.products.map((p) => p.value).join(', ');
    L.products = [{ value: dev.value, evidence: `From the file name "${filename}"`, confidence: 0.6, source: 'filename' }];
    L.warnings = L.warnings.filter((w) => w !== 'No device/product name found');
    L.warnings.push(dev.known ? `Device taken from the file name (matches ${dev.value} in your register)` : 'Device taken from the file name; check it before approving');
    if (was) L.warnings.push(`The letter text suggested "${was}", which is not a device you track`);
    else L.confidence = Math.min(100, L.confidence + 15);
  } else if (dev && dev.known && L.products.length === 1 && [60, 80].includes(deviceScore(L.products[0].value, dev.value, norm))) {
    // "Self/4XXX" or "Self/4000" in the text, "Self4000CL2_..." as the file name:
    // the file was named for the exact device, so use it.
    const was = L.products[0].value;
    L.products = [{ value: dev.value, evidence: `From the file name "${filename}"; the letter says "${was}"`, confidence: 0.8, source: 'filename' }];
    L.warnings.push(`The letter says "${was}"; the file name narrows it to ${dev.value}`);
  } else if (dev && dev.known && L.products.length < 4 && !L.products.some((p) => deviceScore(p.value, dev.value, norm) > 0)) {
    // An L1 letter "as tested in" one device often covers others; the file was named for this one.
    L.products.push({ value: dev.value, evidence: `From the file name "${filename}"`, confidence: 0.6, source: 'filename' });
    L.warnings.push(`The file name names ${dev.value}, the letter names ${L.products.slice(0, -1).map((p) => p.value).join(', ')}. Untick the one it does not cover.`);
  }
  if (!L.scheme || L.scheme === 'Other') {
    const sch = schemeFromFilename(filename);
    if (sch) { L.scheme = sch; L.issuer = L.issuer || sch; L.warnings.push(`Card brand taken from the file name (${sch})`); }
  }
  if (!L.category || L.category === 'Other') {
    const cat = categoryFromFilename(filename);
    if (cat) { L.category = cat; L.warnings.push(`Approval type taken from the file name (${cat})`); }
  }
}

function sameScheme(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function proposalFor(r, score, L, { asOf, auditFor }) {
  const base = { record_id: r.id, device: r.device, category: r.category, scheme: r.scheme, platform: r.platform, bundle: r.bundle, score, warnings: [], changes: {} };
  const cur = r.expiry_date;
  if (!L.expiry) {
    return { ...base, action: 'attach', warnings: ['No expiry date in letter; evidence will be linked without changing dates'] };
  }
  if (cur && L.expiry === cur && (!L.approval || !r.approval_number || L.approval === r.approval_number)) {
    const changes = {};
    if (L.approval && !r.approval_number) changes.approval_number = { from: '', to: L.approval };
    if (L.issue && !r.issue_date) changes.issue_date = { from: '', to: L.issue };
    return { ...base, action: 'attach', changes, note: 'Matches the date already recorded' };
  }
  if (cur && L.expiry < cur) {
    return { ...base, action: 'history', warnings: [`Older than the recorded expiry (${cur}); it will not replace it`], note: 'Linked as history only' };
  }
  // Newer approval.
  const changes = {
    expiry_date: { from: cur || '', to: L.expiry },
  };
  if (L.approval && L.approval !== r.approval_number) changes.approval_number = { from: r.approval_number || '', to: L.approval };
  if (L.issue && L.issue !== r.issue_date) changes.issue_date = { from: r.issue_date || '', to: L.issue };
  if (L.expiryBasis && L.expiryBasis !== r.expiry_basis) changes.expiry_basis = { from: r.expiry_basis || '', to: L.expiryBasis };
  const kv = val(L.kernelVersion);
  if (kv && !r.kernel_version) changes.kernel_version = { from: '', to: kv };
  if (L.restricted && !r.restricted) changes.restricted = { from: false, to: true };

  const warnings = [];
  if (L.expiryBasis && L.expiryBasis.startsWith('Calculated')) warnings.push('Expiry was calculated from the validity period');
  if (auditFor) {
    const last = auditFor(r.id, 'expiry_date');
    if (last && last.source === 'manual' && cur) warnings.push(`Replaces a date entered by hand on ${String(last.ts).slice(0, 10)}`);
  }

  // Not effective yet while the current one is still valid -> track as replacement with overlap.
  const notYet = L.issue && L.issue > asOf && cur && cur >= asOf;
  if (notYet) {
    const cov = coverage(cur, L.issue);
    return {
      ...base, action: 'replacement', warnings,
      changes: {}, replacement: { approval_number: L.approval || '', issue_date: L.issue, expiry_date: L.expiry },
      note: cov ? (cov.kind === 'overlap' ? `Overlaps current approval by ${cov.days} days` : `Coverage gap of ${cov.days} days`) : '',
    };
  }
  if (RENEWAL_STAGES.has(r.stage)) changes.stage = { from: r.stage, to: '' };
  if (r.archived) changes.archived = { from: true, to: false };
  const gain = cur ? daysBetween(cur, L.expiry) : null;
  return { ...base, action: 'update', changes, warnings, note: gain != null ? `Extends coverage by ${gain} days` : 'Sets the first known expiry' };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((p) => {
    const k = `${p.action}|${p.record_id || p.device}|${p.category}|${p.scheme}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A proposal is "safe" when it can be applied without a human looking at it. */
function isSafe(proposal, letter, threshold) {
  if (!['update', 'attach'].includes(proposal.action)) return false;
  if (proposal.warnings && proposal.warnings.length) return false;
  if (proposal.optional) return false;
  if ((letter.warnings || []).length) return false;
  return proposal.score >= 80 && letter.confidence >= threshold;
}

class Intake {
  constructor(store, { archiveDir }) {
    this.store = store;
    this.archiveDir = archiveDir;
  }

  context() {
    const s = this.store.getSettings();
    const db = this.store.db;
    return {
      norm: this.store.norm(),
      aliases: this.store.aliases(),
      noiseWords: s.noiseWords,
      asOf: todayIso(),
      auditFor: (id, f) => db.get("SELECT ts, source FROM audit WHERE record_id=? AND field=? AND action='update' ORDER BY id DESC LIMIT 1", [id, f]),
    };
  }

  /**
   * Ingest one document. `pages` is an array of page strings already
   * extracted by the UI (text layer or OCR). Returns a summary.
   */
  ingest({ filename, bytes, pages, ocrPages = 0 }) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    const hash = sha256(buf.length ? buf : Buffer.from((pages || []).join('\n')));
    const existing = this.store.findDocumentByHash(hash);
    if (existing) {
      return { filename, status: 'duplicate', duplicateOf: existing.filename, documentId: existing.id, letters: 0 };
    }
    const text = (pages || []).join('\n\f\n');
    if (text.replace(/[^A-Za-z0-9]/g, '').length < 40) {
      return { filename, status: 'unreadable', letters: 0, message: 'No readable text found, even after OCR' };
    }
    const letters = parseDocument(pages);
    const ctx = this.context();
    const records = this.store.listRecords();
    fromFilename(letters, filename, records, ctx.norm);
    const stored = buf.length && this.archiveDir ? archiveFile(this.archiveDir, filename, buf) : null;

    return this.store.db.tx(() => {
      const documentId = this.store.addDocument({
        sha256: hash, filename, stored_path: stored, size: buf.length, page_count: pages.length, ocr_pages: ocrPages, text,
      });
      let pending = 0, info = 0;
      const items = [];
      for (const letter of letters) {
        const proposals = buildProposals(letter, records, ctx);
        const status = letter.informational ? 'info' : 'pending';
        if (status === 'pending') pending++; else info++;
        const id = this.store.addInbox({ document_id: documentId, letter_index: letter.index, parsed: letter, proposals, status });
        items.push(id);
      }
      return { filename, status: 'ok', documentId, letters: letters.length, pending, info, items, ocrPages };
    });
  }

  /** Re-run matching for pending items (after records change or aliases are added). */
  rematch() {
    const ctx = this.context();
    const records = this.store.listRecords();
    let n = 0;
    const all = this.store.listInbox();
    const lettersIn = (docId) => all.filter((x) => x.document_id === docId && x.status !== 'info').length;
    this.store.db.tx(() => {
      for (const it of all.filter((x) => x.status === 'pending')) {
        const patch = {};
        // Letters read before the file-name fallback existed get it now.
        if (!it.parsed.informational && lettersIn(it.document_id) === 1 && !it.parsed.products.some((p) => p.source === 'filename')) {
          const before = JSON.stringify(it.parsed.products);
          fromFilename([it.parsed], it.filename, records, ctx.norm);
          if (JSON.stringify(it.parsed.products) !== before) patch.parsed = it.parsed;
        }
        patch.proposals = buildProposals(it.parsed, records, ctx);
        this.store.setInbox(it.id, patch);
        n++;
      }
    });
    return n;
  }

  /**
   * Apply chosen proposals of an inbox item.
   * decisions: [{ index, edits?: {expiry_date, issue_date, approval_number, device, ...}, recordIds?: [], create?: [] }]
   * `create` lists device names to add as new records from the letter, for a
   * family letter whose records do not exist yet. A decision with no index
   * only creates records (a letter that matched nothing).
   */
  apply(inboxId, decisions, { actor = this.store.actor } = {}) {
    const item = this.store.getInbox(inboxId);
    if (!item) throw new Error('Review item not found');
    if (item.status !== 'pending' && item.status !== 'info') throw new Error('This item was already decided');
    const L = item.parsed;
    // Platform/bundle set for this letter (one by one or in bulk) apply to the records it creates.
    const defaults = L.recordDefaults || {};
    const records = this.store.listRecords();
    const norm = this.store.norm();
    const results = [];
    this.store.db.tx(() => {
      for (const d of decisions) {
        const p = item.proposals[d.index];
        const edits = d.edits || {};
        const src = `LOA: ${item.filename || 'document'}${L.pageStart ? ` p.${L.pageStart}` : ''}`;
        for (const name of d.create || []) {
          const device = String(name || '').trim();
          if (!device) continue;
          const prod = (p && (L.products || []).find((x) => x.value === p.device)) || {};
          const rec = {
            ...letterRecord(L, device, prod),
            ...inferPlace(device, records, norm).fields,
            ...nonEmpty(defaults),
            ...pick(edits, ['platform', 'bundle', 'expiry_date', 'issue_date', 'approval_number']),
            source: 'loa', verified_at: new Date().toISOString(), verified_by: actor,
          };
          if (!L.category || !L.scheme) throw new Error('The letter has no brand or approval type, so a record cannot be created from it');
          let r = this.store.findByKey(rec);
          if (!r) r = this.store.createRecord(rec, { source: src, actor });
          this.store.linkDocument(item.document_id, r.id);
          const apId = this.store.db.get('SELECT id FROM approvals WHERE record_id=? ORDER BY id DESC LIMIT 1', [r.id]);
          if (apId) this.store.db.run('UPDATE approvals SET document_id=?, inbox_id=? WHERE id=?', [item.document_id, inboxId, apId.id]);
          results.push({ action: 'created', record_id: r.id });
        }
        if (!p) continue;
        if (p.action === 'create') {
          const rec = { ...p.record, ...nonEmpty(defaults), ...edits, source: 'loa', verified_at: new Date().toISOString(), verified_by: actor };
          let r = this.store.findByKey(rec);
          if (!r) r = this.store.createRecord(rec, { source: src, actor });
          this.store.linkDocument(item.document_id, r.id);
          const apId = this.store.db.get('SELECT id FROM approvals WHERE record_id=? ORDER BY id DESC LIMIT 1', [r.id]);
          if (apId) this.store.db.run('UPDATE approvals SET document_id=?, inbox_id=? WHERE id=?', [item.document_id, inboxId, apId.id]);
          results.push({ action: 'created', record_id: r.id });
          continue;
        }
        const targets = p.action === 'unmatched' ? (d.recordIds || []) : [p.record_id];
        for (const rid of targets) {
          const r = this.store.getRecord(rid);
          if (!r) continue;
          let action = p.action;
          let changes = p.changes || {};
          if (p.action === 'unmatched') {
            const fresh = proposalFor(r, 100, { ...L, approval: val(L.approvalNumber), expiry: val(L.expiryDate), issue: val(L.issueDate) }, { asOf: todayIso() });
            action = fresh.action; changes = fresh.changes;
            if (fresh.action === 'replacement') p.replacement = fresh.replacement;
          }
          this.store.linkDocument(item.document_id, rid);
          const fill = Object.fromEntries(Object.entries(nonEmpty(defaults)).filter(([k]) => !r[k]));
          if (Object.keys(fill).length) this.store.updateRecord(rid, fill, { source: src, actor });
          if (action === 'update') {
            const patch = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to]));
            Object.assign(patch, pick(edits, ['expiry_date', 'issue_date', 'approval_number', 'kernel_version']));
            patch.verified_at = new Date().toISOString();
            patch.verified_by = actor;
            patch.source = 'loa';
            // Keep the previous approval as history.
            this.store.db.run("UPDATE approvals SET role='superseded' WHERE record_id=? AND role IN ('current','replacement')", [rid]);
            this.store.addApproval(rid, {
              approval_number: patch.approval_number || r.approval_number, issue_date: patch.issue_date || r.issue_date,
              expiry_date: patch.expiry_date, role: 'current', document_id: item.document_id, inbox_id: inboxId,
            }, { actor });
            this.store.updateRecord(rid, patch, { source: src, actor });
            results.push({ action: 'updated', record_id: rid });
          } else if (action === 'replacement') {
            const rep = { ...p.replacement, ...pick(edits, ['expiry_date', 'issue_date', 'approval_number']) };
            this.store.addApproval(rid, { ...rep, role: 'replacement', document_id: item.document_id, inbox_id: inboxId }, { actor });
            this.store.updateRecord(rid, { stage: 'Replacement Received' }, { source: src, actor });
            results.push({ action: 'replacement', record_id: rid });
          } else if (action === 'history') {
            this.store.addApproval(rid, { approval_number: val(L.approvalNumber), issue_date: val(L.issueDate), expiry_date: val(L.expiryDate), role: 'superseded', document_id: item.document_id, inbox_id: inboxId }, { actor });
            this.store.audit(rid, 'evidence', 'document', '', `${item.filename} (history)`, src, actor);
            results.push({ action: 'history', record_id: rid });
          } else {
            const patch = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to]));
            if (Object.keys(patch).length) this.store.updateRecord(rid, patch, { source: src, actor });
            if (!L.informational) {
              this.store.db.run("UPDATE approvals SET document_id=COALESCE(document_id, ?) WHERE record_id=? AND role='current'", [item.document_id, rid]);
            }
            this.store.audit(rid, 'evidence', 'document', '', item.filename, src, actor);
            results.push({ action: 'linked', record_id: rid });
          }
        }
      }
      this.store.setInbox(inboxId, { status: 'applied', decided_at: new Date().toISOString() });
    });
    return results;
  }

  /** Platform/bundle for the records these letters will create; an empty value clears it. */
  setDefaults(ids, fields) {
    let n = 0;
    this.store.db.tx(() => {
      for (const id of ids) {
        const it = this.store.getInbox(id);
        if (!it || it.status !== 'pending') continue;
        const d = { ...(it.parsed.recordDefaults || {}) };
        for (const k of ['platform', 'bundle']) if (fields[k] !== undefined) d[k] = String(fields[k] || '').trim();
        this.store.setInbox(id, { parsed: { ...it.parsed, recordDefaults: d } });
        n++;
      }
    });
    return n;
  }

  /**
   * Approve several letters with their suggested changes, as a reviewer
   * would by pressing Approve on each card. Letters that need a choice
   * (a device family, or no match at all) are skipped and stay in review.
   */
  approveMany(ids, { actor } = {}) {
    const recordIds = new Set();
    const skipped = [];
    let applied = 0, changes = 0;
    for (const id of ids) {
      const it = this.store.getInbox(id);
      if (!it || it.status !== 'pending') continue;
      const decisions = it.proposals.map((p, i) => ({ p, index: i }))
        .filter(({ p }) => p.action !== 'unmatched' && !(p.warnings || []).some((w) => /Confirm it covers/.test(w)))
        .map(({ index }) => ({ index }));
      if (!decisions.length) {
        skipped.push({ id, filename: it.filename, reason: it.proposals.length ? 'needs you to choose the records it covers' : 'no device or record to update' });
        continue;
      }
      try {
        const res = this.apply(id, decisions, { actor });
        applied++; changes += res.length;
        for (const r of res) if (r.record_id) recordIds.add(r.record_id);
      } catch (e) {
        skipped.push({ id, filename: it.filename, reason: e.message });
      }
    }
    return { applied, changes, skipped, recordIds: [...recordIds] };
  }

  rejectMany(ids) {
    let n = 0;
    for (const id of ids) {
      const it = this.store.getInbox(id);
      if (!it || (it.status !== 'pending' && it.status !== 'info')) continue;
      this.reject(id, '');
      n++;
    }
    return n;
  }

  reject(inboxId, note = '') {
    this.store.setInbox(inboxId, { status: 'rejected', note, decided_at: new Date().toISOString() });
  }

  /** Apply every safe proposal across the queue. Returns counts. */
  approveAllSafe({ actor } = {}) {
    const threshold = this.store.getSettings().autoApproveConfidence || 90;
    let items = 0, changes = 0;
    const recordIds = new Set();
    for (const it of this.store.listInbox({ status: 'pending' })) {
      if (!it.proposals.length) continue;
      const allSafe = it.proposals.every((p) => isSafe(p, it.parsed, threshold));
      if (!allSafe) continue;
      const res = this.apply(it.id, it.proposals.map((_, i) => ({ index: i })), { actor });
      items++;
      changes += res.length;
      for (const r of res) if (r.record_id) recordIds.add(r.record_id);
    }
    return { items, changes, recordIds: [...recordIds] };
  }
}

function nonEmpty(o) {
  return Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => ['platform', 'bundle'].includes(k) && v));
}

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== '') out[k] = o[k];
  return out;
}

module.exports = { Intake, buildProposals, proposalFor, isSafe, sha256, archiveFile, displayDevice };
