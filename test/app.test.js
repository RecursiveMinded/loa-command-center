'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AppApi } = require('../src/core/api');
const { addDays, todayIso } = require('../src/core/dates');
const L = require('./fixtures/letters');

async function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loa-test-'));
  const api = await AppApi.create({ dataDir: dir });
  api.setSettings({ userName: 'Tester' });
  return { api, dir };
}

const CSV = [
  'Platform,Bundle,Device,Brand,Approval type,Approval number,Expiry date,Owner',
  'Alpha,Bundle 1,NX200,Amex,EMV L2 Contactless,42.OLD,2026-06-01,',
  'Alpha,Bundle 1,NX100,EMVCo,EMV L1 Contact,11111,2027-01-01,Sam',
  'Alpha,Bundle 1,Flex/3500-CL1,Discover,EMV L2 Contactless,,2026-03-01,',
  'Alpha,Bundle 1,NX300,Mastercard,EMV L2 Contactless,TLOA-OLD,2025-01-01,',
].join('\n');

test('tracker import creates records; re-import never overwrites newer or manual data', async () => {
  const { api } = await fresh();
  const dry = await api.importTracker({ filename: 'tracker.csv', bytes: Buffer.from(CSV), dryRun: true });
  assert.equal(dry.added, 4);
  assert.equal(api.listRecords().length, 0, 'dry run changes nothing');
  await api.importTracker({ filename: 'tracker.csv', bytes: Buffer.from(CSV) });
  const recs = api.listRecords();
  assert.equal(recs.length, 4);
  const nx100 = recs.find((r) => r.device === 'NX100');
  assert.equal(nx100.owner, 'Sam');

  api.saveRecord(nx100.id, { owner: 'Lee' });
  const older = CSV.replace('11111,2027-01-01,Sam', '11111,2026-01-01,Sam');
  const rep = await api.importTracker({ filename: 'tracker2.csv', bytes: Buffer.from(older) });
  const after = api.getRecord(nx100.id).record;
  assert.equal(after.expiry_date, '2027-01-01', 'older date ignored');
  assert.equal(after.owner, 'Lee', 'manual edit kept');
  assert.ok(rep.conflicts.length >= 1);
});

test('dropping LOAs: proposals, review, apply, audit and dedupe', async () => {
  const { api } = await fresh();
  await api.importTracker({ filename: 'tracker.csv', bytes: Buffer.from(CSV) });

  const res = api.ingestDocument({ filename: 'merged.pdf', bytes: Buffer.from('pdf-bytes-1'), pages: [L.amex, L.discover, L.mastercard, L.bulletin] });
  assert.equal(res.status, 'ok');
  assert.equal(res.letters, 4);
  assert.equal(res.info, 1, 'bulletin is supporting evidence only');

  const items = api.listInbox();
  const amex = items.find((i) => i.parsed.scheme === 'Amex');
  assert.equal(amex.proposals[0].action, 'update');
  assert.equal(amex.proposals[0].changes.expiry_date.to, '2027-05-22');

  const disc = items.find((i) => i.parsed.scheme === 'Discover');
  assert.equal(disc.proposals[0].device, 'Flex/3500-CL1', 'wildcard family matched the right reader');

  const mc = items.find((i) => i.parsed.scheme === 'Mastercard');
  assert.ok(mc.proposals.some((p) => p.action === 'update' && p.device === 'NX300'));
  assert.ok(mc.proposals.some((p) => p.action === 'create' && p.device === 'NX200'), 'NX200 has no Mastercard record yet');

  // Approve the Amex letter with a reviewer correction.
  api.applyInbox(amex.id, [{ index: 0, edits: { approval_number: '42.LABX.NORTHWIND.NX200.20240522-F' } }]);
  const nx200 = api.listRecords().find((r) => r.device === 'NX200' && r.scheme === 'Amex');
  assert.equal(nx200.expiry_date, '2027-05-22');
  assert.equal(nx200.doc_count, 1);
  const detail = api.getRecord(nx200.id);
  assert.deepEqual(detail.approvals.map((a) => a.role).sort(), ['current', 'superseded']);
  assert.ok(detail.audit.some((a) => a.field === 'expiry_date' && a.old_value === '2026-06-01' && a.actor === 'Tester'));
  assert.equal(detail.documents.length, 1);
  assert.equal(detail.documents[0].missing, false);
  assert.equal(detail.documents[0].stored_path, undefined, 'file paths stay in the main process');
  const loa = api.documentFile(detail.documents[0].id);
  assert.equal(loa.name, 'merged.pdf');
  assert.equal(loa.bytes.toString(), 'pdf-bytes-1', 'the archived LOA can be reopened or saved');

  // Dropped again while other letters wait: those are read again, the
  // approved Amex letter is not offered a second time.
  const again = api.ingestDocument({ filename: 'copy.pdf', bytes: Buffer.from('pdf-bytes-1'), pages: [L.amex] });
  assert.equal(again.status, 'ok');
  assert.equal(again.reread, true);
  const waiting = api.listInbox('pending');
  assert.ok(!waiting.some((i) => i.parsed.scheme === 'Amex'), 'approved letter stays approved');
  const mc2 = waiting.find((i) => i.parsed.scheme === 'Mastercard');
  assert.ok(mc2, 'waiting letters are read again');

  api.rejectInbox(mc2.id, 'not now');
  assert.equal(api.listInbox('rejected').length, 1);
  for (const i of api.listInbox('pending')) api.rejectInbox(i.id, 'test');
  for (const i of api.listInbox('info')) api.rejectInbox(i.id, 'test');
  const third = api.ingestDocument({ filename: 'copy.pdf', bytes: Buffer.from('pdf-bytes-1'), pages: [L.amex] });
  assert.equal(third.status, 'duplicate', 'nothing left to review: a true duplicate');
});

test('a renewal that starts in the future is tracked as a replacement', async () => {
  const { api } = await fresh();
  const soon = addDays(todayIso(), 60);
  const future = addDays(todayIso(), 30);
  api.saveRecord(null, { device: 'NX100', scheme: 'EMVCo', category: 'EMV L1 Contact', expiry_date: soon, approval_number: '11111' });
  const letter = L.emvco.replace('January 10, 2024', future.replace(/(\d+)-(\d+)-(\d+)/, (m, y, mo, d) => `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][mo - 1]} ${Number(d)}, ${y}`));
  api.ingestDocument({ filename: 'renewal.pdf', bytes: Buffer.from('r'), pages: [letter] });
  const it = api.listInbox()[0];
  assert.equal(it.proposals[0].action, 'replacement');
  api.applyInbox(it.id, [{ index: 0 }]);
  const r = api.listRecords()[0];
  assert.equal(r.expiry_date, soon, 'current approval stays in force');
  assert.equal(r.stage, 'Replacement Received');
  const d = api.getRecord(r.id);
  assert.equal(d.coverage.kind, 'overlap');
  const rep = d.approvals.find((a) => a.role === 'replacement');
  api.activateReplacement(rep.id);
  assert.equal(api.getRecord(r.id).record.expiry_date, '2028-06-30');
});

test('approve all safe applies only confident, warning-free letters', async () => {
  const { api } = await fresh();
  await api.importTracker({ filename: 'tracker.csv', bytes: Buffer.from(CSV) });
  api.ingestDocument({ filename: 'a.pdf', bytes: Buffer.from('a'), pages: [L.emvco] });
  api.ingestDocument({ filename: 'b.pdf', bytes: Buffer.from('b'), pages: [L.amex] });
  const r = api.approveAllSafe();
  assert.equal(r.items, 1, 'EMVCo letter is safe; Amex expiry was calculated so it waits for review');
  assert.equal(api.listInbox().length, 1);
  assert.equal(api.listRecords().find((x) => x.device === 'NX100').expiry_date, '2028-06-30');
});

test('planner: renewal waves, grouped expiries, snooze and digest', async () => {
  const { api } = await fresh();
  const d = addDays(todayIso(), 100);
  for (const dev of ['A1', 'A2', 'A3']) api.saveRecord(null, { device: dev, scheme: 'Visa', category: 'EMV L2 Contactless', expiry_date: d });
  const past = addDays(todayIso(), -20);
  for (const dev of ['B1', 'B2', 'B3']) api.saveRecord(null, { device: dev, scheme: 'JCB', category: 'EMV L2 Contactless', expiry_date: past });
  api.saveRecord(null, { device: 'C1', scheme: 'Amex', category: 'EMV L2 Contactless', expiry_date: addDays(todayIso(), 20) });

  const acts = api.getActions();
  const wave = acts.find((a) => a.kind === 'wave');
  assert.equal(wave.recordIds.length, 3);
  const grp = acts.find((a) => a.key.startsWith('expiredgroup:'));
  assert.equal(grp.recordIds.length, 3);
  assert.equal(grp.priority, 1);
  const renew = acts.find((a) => a.kind === 'renewal');
  assert.match(renew.title, /C1/);

  api.setTask(renew.key, 'snoozed', { snoozeDays: 7 });
  assert.equal(api.getActions().find((a) => a.key === renew.key).status, 'snoozed');

  const dg = api.digest();
  assert.ok(dg.critical >= 1);
  assert.match(dg.email, /JCB/);
  const sent = api.checkNotification(new Date());
  assert.ok(sent, 'first scheduled check sends');
  assert.equal(api.checkNotification(new Date()), null, 'only once per slot');
});

test('an empty database sends no digest', async () => {
  const { api } = await fresh();
  assert.equal(api.checkNotification(new Date()), null);
});

test('portal page import and compare mode', async () => {
  const { api } = await fresh();
  const html = `<html><body><h2>Kernel Bundle 9</h2><p>Platform Alpha</p>
    <table><tr><th>Terminal</th><th>Amex</th><th>Discover</th><th>Visa</th></tr>
    <tr><td>NX200</td><td>22-May-2027</td><td>07-Feb-2028</td><td></td></tr>
    <tr><td>NX300</td><td>01-Jan-2027</td><td></td><td>30-Jun-2029</td></tr></table></body></html>`;
  const rep = api.importPortal({ filename: 'portal.html', bytes: Buffer.from(html) });
  assert.equal(rep.added, 4);
  const nx200 = api.listRecords().find((r) => r.device === 'NX200' && r.scheme === 'Amex');
  assert.equal(nx200.expiry_date, '2027-05-22');
  api.saveRecord(nx200.id, { expiry_date: '2030-05-22' });
  const cmp = api.importPortal({ filename: 'portal.html', bytes: Buffer.from(html), asPublished: true });
  assert.equal(cmp.total, 4);
  assert.equal(cmp.notFound.length, 0);
  const changes = api.portalChanges();
  assert.ok(changes.some((c) => c.device === 'NX200' && c.published === '2027-05-22' && c.verified === '2030-05-22'));
});

test('reports, exports, backup and restore', async () => {
  const { api, dir } = await fresh();
  api.loadSampleData();
  const html = api.summaryReport({});
  assert.match(html, /Certification Summary Report/);
  assert.ok(!html.includes(dir), 'report never shows the data folder');
  const xlsx = await api.exportExcel({});
  assert.equal(xlsx.slice(0, 2).toString(), 'PK');
  assert.match(api.exportCsv({}), /Device/);

  const file = api.backup('test');
  const n = api.listRecords().length;
  api.clearAllData();
  assert.equal(api.listRecords().length, 0);
  await api.restore(file);
  assert.equal(api.listRecords().length, n);
  assert.equal(api.health().integrity, 'ok');
});

test('a new app version saves the old database before opening it', async () => {
  const { api, dir } = await fresh();
  assert.equal(api.listBackups().filter((b) => b.name.includes('-before-v')).length, 0, 'no backup on a first install');
  api.loadSampleData();
  api.setSettings({ appVersion: '0.9.0' });
  api.db.close();
  const old = fs.readFileSync(path.join(dir, 'loa.db'));

  const next = await AppApi.create({ dataDir: dir });
  const saved = next.listBackups().filter((b) => b.name.includes('-before-v'));
  assert.equal(saved.length, 1);
  assert.deepEqual(fs.readFileSync(saved[0].path), old, 'the backup is the untouched previous file');
  assert.equal(next.listRecords().length > 0, true, 'records carry over');
  next.db.close();

  const again = await AppApi.create({ dataDir: dir });
  assert.equal(again.listBackups().filter((b) => b.name.includes('-before-v')).length, 1, 'only once per version');
});

test('bulk edit sets platform and tags, and skips clashing records', async () => {
  const { api } = await fresh();
  const a = api.saveRecord(null, { device: 'NX200', scheme: 'Amex', category: 'EMV L2 Contactless' }).record;
  const b = api.saveRecord(null, { device: 'NX300', scheme: 'Amex', category: 'EMV L2 Contactless' }).record;
  const c = api.saveRecord(null, { device: 'NX300', scheme: 'Amex', category: 'EMV L2 Contactless', platform: 'Alpha' }).record;

  let r = api.bulkUpdate([a.id, b.id], { platform: 'Alpha' });
  assert.equal(r.changed, 1, 'NX200 moves to Alpha');
  assert.equal(r.skipped.length, 1, 'NX300 already exists on Alpha');
  assert.equal(r.skipped[0].id, b.id);
  assert.equal(api.getRecord(a.id).record.platform, 'Alpha');
  assert.equal(api.getRecord(b.id).record.platform, '', 'the skipped record is untouched');

  r = api.bulkUpdate([a.id, c.id], {}, { add: ['Retail', ' program x '] });
  assert.equal(r.changed, 2);
  api.bulkUpdate([a.id], {}, { add: ['retail', 'Customer A'] });
  assert.equal(api.getRecord(a.id).record.tags, 'Retail, program x, Customer A', 'no duplicate tags, case-insensitive');
  api.bulkUpdate([a.id, c.id], {}, { remove: ['PROGRAM X'] });
  assert.equal(api.getRecord(c.id).record.tags, 'Retail');
  assert.deepEqual(api.listTags().map((t) => [t.tag, t.count]), [['Customer A', 1], ['Retail', 2]]);
  assert.match(api.exportCsv({}), /Tags/);
  assert.ok(api.getRecord(a.id).audit.some((x) => x.field === 'tags'), 'tag changes are audited');
});

test('a version 1 database gains the tags column on open', async () => {
  const { Database, SCHEMA_VERSION } = require('../src/core/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loa-mig-'));
  const file = path.join(dir, 'loa.db');
  const db = await Database.open(file);
  db.db.exec('CREATE TABLE r2 AS SELECT * FROM records');
  db.db.exec('DROP TABLE records');
  db.db.exec(`CREATE TABLE records AS SELECT ${db.all('PRAGMA table_info(r2)').map((c) => c.name).filter((n) => n !== 'tags').join(', ')} FROM r2`);
  db.db.exec('DROP TABLE r2');
  db.run("UPDATE settings SET value='1' WHERE key='schema_version'");
  db.close();
  const again = await Database.open(file);
  assert.ok(again.all('PRAGMA table_info(records)').some((c) => c.name === 'tags'));
  assert.equal(again.get("SELECT value FROM settings WHERE key='schema_version'").value, String(SCHEMA_VERSION));
  again.close();
});

test('AI help on a letter with no device rebuilds its proposals', async () => {
  const { api } = await fresh();
  api.loadSampleData();
  api.ingestDocument({ filename: 'blind.pdf', bytes: Buffer.from('blind'), pages: [L.discover.replace('Product: Flex/3XXX CL1 ', '')] });
  const it = api.listInbox('pending').find((i) => i.filename === 'blind.pdf');
  assert.equal(it.proposals.length, 0);
  let asked = null;
  api.ai.assistExtract = async (_t, missing) => { asked = missing; return { products: ['Flex/3500-CL1'] }; };
  const r = await api.assistInbox(it.id);
  assert.ok(asked.includes('products'), 'an empty device list counts as missing');
  assert.ok(!asked.includes('expiry_date'), 'a date that was found is not asked for');
  assert.equal(r.changed, true);
  const after = api.listInbox('pending').find((i) => i.id === it.id);
  assert.ok(after.proposals.length > 0);
  api.rejectInbox(it.id, '');
  assert.ok(!api.listInbox('pending').some((i) => i.id === it.id));
});

test('records can be created from a letter when the ones it covers do not exist yet', async () => {
  const { api } = await fresh();
  api.ingestDocument({ filename: 'family.pdf', bytes: Buffer.from('family'), pages: [L.discover] });
  const fam = api.listInbox('pending').find((i) => i.filename === 'family.pdf');
  assert.equal(fam.proposals[0].action, 'unmatched');
  const res = api.applyInbox(fam.id, [{ index: 0, recordIds: [], create: ['Flex/3500-CL1', ' ', 'Flex/3600-CL1'], edits: { platform: 'Beta' } }]);
  assert.deepEqual(res.map((r) => r.action), ['created', 'created']);
  const made = api.listRecords();
  assert.equal(made.length, 2);
  for (const r of made) {
    assert.equal(r.scheme, fam.parsed.scheme);
    assert.equal(r.category, fam.parsed.category);
    assert.equal(r.platform, 'Beta');
    assert.equal(r.expiry_date, fam.parsed.expiryDate.value);
    const full = api.getRecord(r.id);
    assert.equal(full.documents.length, 1, 'the letter is linked to the new record');
  }

  api.ingestDocument({ filename: 'blind.pdf', bytes: Buffer.from('blind'), pages: [L.discover.replace('Product: Flex/3XXX CL1 ', '')] });
  const blind = api.listInbox('pending').find((i) => i.filename === 'blind.pdf');
  assert.equal(blind.proposals.length, 0);
  const res2 = api.applyInbox(blind.id, [{ create: ['NX900'], edits: { expiry_date: '2030-01-31' } }]);
  assert.equal(res2[0].action, 'created');
  assert.equal(api.getRecord(res2[0].record_id).record.expiry_date, '2030-01-31');
  assert.ok(!api.listInbox('pending').some((i) => i.id === blind.id));
});

test('device and approval type are read from the file name when the letter does not say', async () => {
  const { deviceFromFilename, categoryFromFilename } = require('../src/core/devices');
  assert.deepEqual(deviceFromFilename('Self4000CL2_EmvL1Cless.pdf'), { value: 'Self/4000-CL2', known: false });
  assert.deepEqual(deviceFromFilename('Self4000CL2_EmvL1Cless.pdf', ['Self/4000', 'Self/4000-CL2']), { value: 'Self/4000-CL2', known: true });
  assert.equal(deviceFromFilename('AXIUM DX8000 - L2.pdf').value, 'DX8000');
  assert.equal(deviceFromFilename('Northwind merged.pdf'), null);
  assert.equal(categoryFromFilename('Self4000CL2_EmvL1Cless.pdf'), 'EMV L1 Contactless');
  assert.equal(categoryFromFilename('Move5000_L2_CTLS.pdf'), 'EMV L2 Contactless');
  assert.equal(categoryFromFilename('Self4000CL2_Disc.pdf'), '');
  const { schemeFromFilename } = require('../src/core/devices');
  assert.equal(schemeFromFilename('Self4000CL2_MC_100100_0501.pdf'), 'Mastercard');
  assert.equal(schemeFromFilename('Lane3000CL1_Disc_040602.pdf'), 'Discover');
  assert.equal(schemeFromFilename('Self4000CL2_EmvL1Cless.pdf'), '');

  const { api } = await fresh();
  api.loadSampleData();
  const blindText = L.discover.replace('Product: Flex/3XXX CL1 ', '');
  api.ingestDocument({ filename: 'P400CL1_Discover_L2.pdf', bytes: Buffer.from('a'), pages: [blindText] });
  const it = api.listInbox('pending').find((i) => i.filename === 'P400CL1_Discover_L2.pdf');
  assert.equal(it.parsed.products[0].value, 'P400-CL1');
  assert.ok(it.parsed.warnings.some((w) => /file name/.test(w)));
  assert.ok(it.proposals.some((p) => p.record_id && p.device === 'P400-CL1'), 'matched the existing record');

  // Letters read by an older version get the fallback on re-match.
  const parsed = { ...it.parsed, products: [] };
  api.store.setInbox(it.id, { parsed, proposals: [] });
  api.rematch();
  const again = api.listInbox('pending').find((i) => i.id === it.id);
  assert.equal(again.parsed.products[0].value, 'P400-CL1');
  assert.ok(again.proposals.length > 0);

  // Letterhead text read as the device loses to the file name.
  api.ingestDocument({ filename: 'T100CL1_Discover.pdf', bytes: Buffer.from('b'), pages: [blindText.replace('Discover', 'Discover Global Network')] });
  const junk = api.listInbox('pending').find((i) => i.filename === 'T100CL1_Discover.pdf');
  assert.equal(junk.parsed.products[0].value, 'T100-CL1');
  assert.ok(junk.parsed.warnings.some((w) => /file name/.test(w)));

  const known = api.knownDevices();
  assert.ok(known.some((d) => d.device === 'P400-CL1' && d.records >= 2 && d.schemes.includes('Discover')));
});

test('inbox letters can be given a platform, approved and rejected in bulk', async () => {
  const { api } = await fresh();
  await api.importTracker({ filename: 'tracker.csv', bytes: Buffer.from(CSV) });
  api.ingestDocument({ filename: 'merged.pdf', bytes: Buffer.from('m'), pages: [L.amex, L.emvco, L.mastercard] });
  api.ingestDocument({ filename: 'family.pdf', bytes: Buffer.from('f'), pages: [L.discover.replace('Flex/3XXX', 'Zeta/7XXX')] });
  const pending = api.listInbox('pending');
  const ids = pending.map((i) => i.id);
  assert.equal(api.setInboxDefaults(ids, { platform: 'UPP' }), ids.length);
  assert.ok(api.listInbox('pending').every((i) => i.parsed.recordDefaults.platform === 'UPP'));

  const r = api.approveInboxMany(ids);
  assert.equal(r.applied, ids.length - 1, 'every letter but the family one');
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /choose the records/);
  const recs = api.listRecords();
  for (const id of r.recordIds) {
    const rec = recs.find((x) => x.id === id);
    assert.equal(rec.platform, rec.device === 'NX100' ? 'Alpha' : rec.platform, 'a matched record keeps its own platform');
  }
  const created = recs.filter((x) => x.source === 'loa' && !CSV.includes(x.device));
  assert.ok(created.every((x) => x.platform === 'UPP'), 'records created by the letters get the bulk platform');

  assert.equal(api.rejectInboxMany(r.skipped.map((x) => x.id)), 1);
  assert.equal(api.listInbox('pending').length, 0);
});

test('a new record takes its platform from the same device or its family in the register', async () => {
  const { api } = await fresh();
  const mk = (device, scheme, platform, bundle) => api.saveRecord(null, { device, category: 'EMV L2 Contactless', scheme, platform, bundle, expiry_date: '2027-01-01' });
  mk('Self/4000-CL2', 'Visa', 'UPP', 'Bundle 6');
  mk('Self/5000-CL2', 'Visa', 'UPP', '');
  mk('DX8000', 'Visa', 'ARC', '');
  api.ingestDocument({ filename: 'a.pdf', bytes: Buffer.from('a'), pages: [L.mastercard.replace(/NX\d00/g, 'Self/4000-CL2')] });
  api.ingestDocument({ filename: 'b.pdf', bytes: Buffer.from('b'), pages: [L.mastercard.replace(/NX\d00/g, 'Self/8000-CL1')] });
  const props = api.listInbox('pending').flatMap((i) => i.proposals).filter((p) => p.action === 'create');
  const s4 = props.find((p) => p.device === 'Self/4000-CL2');
  const s8 = props.find((p) => p.device === 'Self/8000-CL1');
  assert.equal(s4.record.platform, 'UPP');
  assert.equal(s4.record.bundle, 'Bundle 6');
  assert.equal(s8.record.platform, 'UPP', 'family Self/... is all UPP');
});

test('a file dropped again before approval is read again, replacing its review cards', async () => {
  const { api } = await fresh();
  const first = api.ingestDocument({ filename: 'Self4000CL2_MC.pdf', bytes: Buffer.from('same'), pages: ['Masterc ard garbled text without much in it at all, really nothing'] });
  assert.equal(first.status, 'ok');
  const again = api.ingestDocument({ filename: 'Self4000CL2_MC.pdf', bytes: Buffer.from('same'), pages: [L.mastercard] });
  assert.equal(again.status, 'ok');
  assert.equal(again.reread, true);
  assert.equal(again.documentId, first.documentId);
  const items = api.listInbox('pending').filter((i) => i.document_id === first.documentId);
  assert.equal(items.length, again.pending, 'old cards replaced');
  assert.ok(items.every((i) => i.parsed.scheme === 'Mastercard'));
  assert.equal(api.listDocuments().length, 1);
});

test('website change request lists what the website gets wrong and numbers the requests', async () => {
  const { api } = await fresh();
  const today = todayIso();
  const mk = (o) => api.saveRecord(null, { platform: 'UPP', category: 'EMV L2 Contactless', scheme: 'Visa', ...o });
  const upd = mk({ device: 'DX4000', expiry_date: addDays(today, 900), portal_date: addDays(today, 100) });
  const exp = mk({ device: 'Lane/7000-CL1', category: 'EMV L1 Contactless', scheme: 'EMVCo', expiry_date: addDays(today, -30), portal_date: addDays(today, -30) });
  const pci = mk({ device: 'Lane/3000', category: 'PCI PTS', scheme: 'PCI SSC', kernel_version: 'PCI v5', expiry_date: addDays(today, -5), portal_date: addDays(today, -5) });
  mk({ device: 'Self/3000', expiry_date: addDays(today, 400), portal_date: addDays(today, 400) });
  const rows = api.portalChanges();
  assert.equal(rows.length, 3, 'the row in sync is left out');
  const by = Object.fromEntries(rows.map((r) => [r.device, r]));
  assert.equal(by.DX4000.action, 'Update date');
  assert.equal(by.DX4000.section, 'EMV Contactless L2');
  assert.equal(by.DX4000.brand, 'Visa');
  assert.equal(by['Lane/7000-CL1'].action, 'Replace expired date');
  assert.equal(by['Lane/7000-CL1'].brand, 'EMV Contactless');
  assert.equal(by['Lane/7000-CL1'].level, 'Level 1');
  assert.equal(by['Lane/3000'].action, 'Remove row');
  assert.equal(by['Lane/3000'].level, 'PCI v5');
  assert.match(by['Lane/3000'].comment, /Lane\/3000 PCI v5$/);

  const book = await api.exportChangeRequest({ markRequested: true });
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(book);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Master Change Request (All)', 'UPP']);
  assert.equal(wb.worksheets[0].getRow(1).getCell(7).value, 'Action');
  const ids = api.listRecords().map((r) => r.change_ticket).filter(Boolean).sort();
  assert.deepEqual(ids, ['CR-001', 'CR-002', 'CR-003']);
  assert.equal(api.getRecord(upd.record.id).record.portal_status, 'Change Requested');
  // A later request continues the numbering.
  mk({ device: 'EX4000', expiry_date: addDays(today, 700), portal_date: addDays(today, 10) });
  await api.exportChangeRequest({ markRequested: true });
  assert.ok(api.listRecords().some((r) => r.device === 'EX4000' && r.change_ticket === 'CR-004'));
  void exp; void pci;
});

test('a cert database export is mapped by its own columns and joins tracker records', async () => {
  const { api } = await fresh();
  await api.importTracker({ filename: 'tracker.csv', bytes: Buffer.from(CSV) });
  const db = [
    'No.,Product family,Technology,Contact and Contactless configuration,Product Ref.,Category,Certification Type,Approval Category,Certification body,Spec Version,LoA Reference,LoA Status,Software ID,Expiration date',
    '1,NX200,T3,,TRK7,L2,L2 Cless,L2 Contactless American Express,American Express,v4,42.NEW,Valid,SW1,2029-01-31',
    '2,Flex/3500,T3,CL1,TRK8,L2,L2 Cless,L2 Contactless Discover,Discover,v1,D-77,Valid,SW2,2028-05-05',
    '3,ZX900,Android,,,L1,L1 Contact,L1 Contact EMVCo,EMVCo,4.3,1234 5678,Valid,SW3,2030-02-02',
    '4,ZX100,Android,,,L1,L1 Contact,L1 Contact EMVCo,EMVCo,4.3,999,Expired,SW4,2020-02-02',
  ].join('\n');
  const r = await api.importTracker({ filename: 'CertDB.csv', bytes: Buffer.from(db) });
  assert.equal(r.sheets[0].mapping.device, 'Product family');
  assert.equal(r.updated, 2, 'NX200 and Flex/3500-CL1 are the tracker records');
  assert.equal(r.added, 1, 'ZX900 is new; the expired ZX100 is skipped');
  const recs = api.listRecords();
  const nx = recs.find((x) => x.device === 'NX200');
  assert.equal(nx.expiry_date, '2029-01-31');
  assert.equal(nx.approval_number, '42.NEW');
  assert.equal(nx.platform, 'Alpha', 'platform is not taken from "Software ID"');
  assert.equal(recs.find((x) => x.device === 'Flex/3500-CL1').approval_number, 'D-77');
  assert.equal(recs.find((x) => x.device === 'ZX900').category, 'EMV L1 Contact');
});

const JCB = `JCB CO., LTD.
5-1 Example Street, Tokyo
Northwind Terminals ("Vendor")
August 10, 2023
To whom it may concern
RE: Letter of Approval – JCB Contactless IC Terminal
JCB Reference Number   23XX00-001
1. Information of the Approved Product
◆ Product Marketing Name   Flex/5000-CL3 & Flex/3500-CL3
◆ JCB Contactless L2 Application (kernel) Version   04.04.00
◆ Renewal Date   10-Aug-2027
Yours Sincerely,`;

test('letters waiting from an older version are read again after an update', async () => {
  const { api } = await fresh();
  const r = api.ingestDocument({ filename: 'Flex5000CL3_JCB_040400.pdf', bytes: Buffer.from('jcb'), pages: [JCB] });
  assert.equal(r.letters, 1);
  const good = api.listInbox('pending')[0];
  assert.equal(good.parsed.approvalNumber.value, '23XX00-001');
  assert.equal(good.parsed.expiryDate.value, '2027-08-10', 'a renewal date is the expiry');
  assert.deepEqual(good.parsed.products.map((p) => p.value), ['Flex/5000-CL3', 'Flex/3500-CL3']);
  // Approve the real letter, then plant the empty letterhead page an older reader split off.
  api.applyInbox(good.id, [{ create: ['Flex/5000-CL3'] }]);
  const junk = { ...good.parsed, type: 'unknown', index: 0, products: [], approvalNumber: null, expiryDate: null, category: 'Other', confidence: 15 };
  api.store.addInbox({ document_id: good.document_id, letter_index: 0, parsed: junk, proposals: [], status: 'pending' });
  assert.equal(api.listInbox('pending').length, 1);
  api.store.setSettings({ appVersion: '0.0.1' });
  api.upgradeBackup(null);
  assert.equal(api.listInbox('pending').length, 0, 'the leftover page is gone and the approved letter is not offered again');

  // A waiting letter is replaced by a fresh reading, keeping the platform chosen for it.
  api.ingestDocument({ filename: 'Flex7000_JCB.pdf', bytes: Buffer.from('jcb2'), pages: [JCB.replace(/Flex\/5000-CL3 & Flex\/3500-CL3/, 'Flex/7000')] });
  const w = api.listInbox('pending')[0];
  api.setInboxDefaults([w.id], { platform: 'Beta' });
  api.store.setInbox(w.id, { parsed: { ...api.listInbox('pending')[0].parsed, products: [], expiryDate: null } });
  const rr = api.rereadInbox([w.id]);
  assert.equal(rr.letters, 1);
  const w2 = api.listInbox('pending')[0];
  assert.equal(w2.parsed.expiryDate.value, '2027-08-10');
  assert.equal(w2.parsed.products[0].value, 'Flex/7000');
  assert.equal(w2.parsed.recordDefaults.platform, 'Beta');
});

test('one statement saved under several device file names is read for each device', async () => {
  const { api } = await fresh();
  const same = Buffer.from('same-statement');
  const a = api.ingestDocument({ filename: 'Flex3000CL1_TqmContactless.pdf', bytes: same, pages: [JCB] });
  const b = api.ingestDocument({ filename: 'Flex2500CL2_TqmContactless.pdf', bytes: same, pages: [JCB] });
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok', 'a different device in the file name is not a duplicate');
  assert.notEqual(a.documentId, b.documentId);
  const c = api.ingestDocument({ filename: 'Flex3000CL1_TqmContactless (1).pdf', bytes: same, pages: [JCB] });
  assert.equal(c.status, 'ok', 'still waiting, so read again');
  assert.equal(c.documentId, a.documentId, 'same device: same document');
});

test('dashes, spaces and quotes printed differently still read', async () => {
  const { parseDocument } = require('../src/core/loa-parser');
  for (const dash of ['-', '‐', '−', '—']) {
    const [r] = parseDocument([JCB.replace('–', dash).replace(/ {3}/g, '  ')]);
    assert.equal(r.type, 'jcb', `dash ${dash.charCodeAt(0).toString(16)}`);
    assert.equal(r.expiryDate.value, '2027-08-10');
  }
});

test('records carry their hardware version (CL1, CL2...) as a tag', async () => {
  const { api } = await fresh();
  const a = api.store.createRecord({ device: 'Self/4000-CL2', category: 'EMV L2 Contactless', scheme: 'Amex' });
  assert.equal(a.tags, 'CL2');
  const b = api.store.createRecord({ device: 'Lane/3000', category: 'EMV L1 Contact', scheme: 'EMVCo', tags: 'Retail' });
  assert.equal(b.tags, 'Retail');
  api.store.updateRecord(a.id, { device: 'Self/4000-CL3' });
  assert.equal(api.store.getRecord(a.id).tags, 'CL3', 'renaming the reader swaps the tag');
  api.store.db.run("UPDATE records SET tags='' WHERE id=?", [a.id]);
  assert.equal(api.store.tagReaders(), 1, 'older records get the tag on update');
  assert.equal(api.store.getRecord(a.id).tags, 'CL3');
  const r = api.bulkUpdate([b.id], {}, { remove: ['CL1', 'CL2', 'CL3'], add: ['CL1'] });
  assert.equal(r.changed, 1);
  assert.equal(api.store.getRecord(b.id).tags, 'Retail, CL1');
});

test('several records can be deleted at once', async () => {
  const { api } = await fresh();
  const a = api.store.createRecord({ device: 'NX1', category: 'EMV L1 Contact', scheme: 'EMVCo' });
  const b = api.store.createRecord({ device: 'NX2', category: 'EMV L1 Contact', scheme: 'EMVCo' });
  api.store.createRecord({ device: 'NX3', category: 'EMV L1 Contact', scheme: 'EMVCo' });
  assert.equal(api.deleteRecords([a.id, b.id, 'missing']), 2);
  assert.deepEqual(api.listRecords().map((r) => r.device), ['NX3']);
});

test('platform and bundle aliases rename existing records and apply to new ones', async () => {
  const { api } = await fresh();
  const a = api.store.createRecord({ device: 'NX1', category: 'EMV L1 Contact', scheme: 'EMVCo', platform: 'upp v6', bundle: 'Bundle6' });
  const b = api.store.createRecord({ device: 'NX2', category: 'EMV L1 Contact', scheme: 'EMVCo', platform: 'UPP V6 ' });
  api.store.createRecord({ device: 'NX3', category: 'EMV L1 Contact', scheme: 'EMVCo', platform: 'ARC' });
  assert.equal(api.previewAlias('platform', 'UPP v6', 'UPP').count, 2);
  const r = api.setFieldAlias('platform', 'UPP v6', 'UPP', { apply: true });
  assert.equal(r.changed, 2);
  assert.equal(api.store.getRecord(a.id).platform, 'UPP');
  assert.equal(api.store.getRecord(b.id).platform, 'UPP');
  assert.ok(api.getRecord(a.id).audit.some((x) => x.field === 'platform' && x.source === 'alias'), 'the rename is in the history');
  // Saved without applying, then applied later in one go.
  api.setFieldAlias('bundle', 'bundle6', 'UPP Bundle 6');
  assert.equal(api.store.getRecord(a.id).bundle, 'Bundle6');
  assert.equal(api.applyAllAliases('bundle').changed, 1);
  assert.equal(api.store.getRecord(a.id).bundle, 'UPP Bundle 6');
  // New and imported records use the main name.
  const c = api.store.createRecord({ device: 'NX4', category: 'EMV L1 Contact', scheme: 'EMVCo', platform: 'upp v6' });
  assert.equal(c.platform, 'UPP');
  assert.deepEqual(api.listFieldAliases().platform, { 'upp v6': 'UPP' });
  api.setFieldAlias('platform', 'UPP v6', '');
  assert.deepEqual(api.listFieldAliases().platform, {});
  // Device aliases can rename records too.
  const d = api.setAlias('NX-1', 'NX1A', { apply: false });
  assert.equal(d.changed, undefined);
  api.store.createRecord({ device: 'NX-1', category: 'EMV L2 Contactless', scheme: 'Amex' });
  const e = api.setAlias('NX-1', 'NX1A', { apply: true });
  assert.ok(e.changed >= 1);
  assert.ok(api.listRecords().some((x) => x.device === 'NX1A' && x.scheme === 'Amex'));
});

test('deleting moves records to the Archive; only the Archive deletes permanently', async () => {
  const { api } = await fresh();
  const old = addDays(todayIso(), -10);
  const a = api.store.createRecord({ device: 'Move5000-CL3', category: 'EMV L2 Contactless', scheme: 'JCB', platform: 'UPP', approval_number: 'JCB-123', expiry_date: old, notes: 'renewal pending lab' });
  const b = api.store.createRecord({ device: 'NX2', category: 'EMV L1 Contact', scheme: 'EMVCo', expiry_date: addDays(todayIso(), 200) });
  const c = api.store.createRecord({ device: 'NX3', category: 'EMV L1 Contact', scheme: 'EMVCo', expiry_date: addDays(todayIso(), -1) });
  assert.equal(api.deleteRecord(b.id), true);
  assert.deepEqual(api.listRecords().map((r) => r.device).sort(), ['Move5000-CL3', 'NX3']);
  assert.equal(api.archiveCount(), 1);
  // Search matches any field, every word.
  assert.equal(api.listArchive('nx2 emvco').length, 1);
  assert.equal(api.listArchive('nx2 jcb').length, 0);
  // Expired records move in one step.
  assert.deepEqual(api.expiredRecords().map((r) => r.device).sort(), ['Move5000-CL3', 'NX3']);
  assert.equal(api.archiveExpired(), 2);
  assert.equal(api.listRecords().length, 0);
  const hit = api.listArchive('lab pending');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].device, 'Move5000-CL3');
  assert.equal(hit[0].reason, 'Expired');
  assert.equal(hit[0].approvals[0].approval_number, 'JCB-123');
  assert.equal(api.listArchive('JCB-123').length, 1);
  assert.ok(api.knownDevices().some((d) => d.device === 'Move5000-CL3' && d.archived === 1), 'archived device names are still suggested');
  // Restore puts the record back with its approvals and history.
  const r = api.restoreArchived([a.id]);
  assert.equal(r.restored, 1);
  const back = api.getRecord(a.id);
  assert.equal(back.record.approval_number, 'JCB-123');
  assert.equal(back.approvals[0].approval_number, 'JCB-123');
  assert.ok(back.audit.some((x) => x.action === 'restore'));
  assert.equal(api.store.listRecords()[0].tags, 'CL3');
  // A clash with a current record keeps the archived one where it is.
  api.store.createRecord({ device: 'NX3', category: 'EMV L1 Contact', scheme: 'EMVCo' });
  assert.equal(api.restoreArchived([c.id]).skipped.length, 1);
  // Permanent delete.
  assert.equal(api.purgeArchived([c.id, b.id]), 2);
  assert.equal(api.archiveCount(), 0);
});

test('records hidden with the old Archived flag move to the Archive on upgrade', async () => {
  const { api } = await fresh();
  const a = api.store.createRecord({ device: 'NX1', category: 'EMV L1 Contact', scheme: 'EMVCo', archived: true });
  api.store.createRecord({ device: 'NX2', category: 'EMV L1 Contact', scheme: 'EMVCo' });
  api.store.setSettings({ appVersion: '0.0.1' });
  api.upgradeBackup(null);
  assert.deepEqual(api.listRecords().map((r) => r.device), ['NX2']);
  assert.equal(api.listArchive('nx1')[0].id, a.id);
  assert.equal(api.bulkUpdate([api.listRecords()[0].id], { archived: true }).changed, 1);
  assert.equal(api.archiveCount(), 2);
});

test('an LOA already in the app can be linked to a variant record from its LOA tab', async () => {
  const { api } = await fresh();
  const a = api.store.createRecord({ device: 'Lane3000', category: 'EMV L1 Contactless', scheme: 'Mastercard' });
  const b = api.store.createRecord({ device: 'Lane3000 CL1', category: 'EMV L1 Contactless', scheme: 'Mastercard' });
  const bytes = Buffer.from('%PDF fake letter bytes');
  const pages = ['Mastercard Letter of Approval\nProduct Name: Lane3000\nApproval Number: MC-777\nExpiry Date: 11 March 2028\n' + 'x'.repeat(60)];
  const first = api.attachNewDocument(a.id, { filename: 'Lane3000_MC.pdf', bytes, pages });
  assert.ok(first.documentId);
  api.linkDocumentToRecord(a.id, first.documentId, { useValues: true, values: { approval_number: 'MC-777', expiry_date: '2028-03-11' } });
  // Same file on the variant record: reported as a duplicate, not stored twice.
  const dup = api.attachNewDocument(b.id, { filename: 'copy.pdf', bytes, pages });
  assert.ok(dup.duplicate);
  assert.equal(dup.duplicate.linkedTo[0].device, 'Lane3000');
  assert.equal(dup.duplicate.values.approval_number, 'MC-777');
  const r = api.linkDocumentToRecord(b.id, dup.duplicate.document.id, { useValues: true });
  assert.equal(r.record.expiry_date, '2028-03-11');
  assert.equal(r.documents.length, 1);
  assert.equal(api.checkAttach(b.id, { bytes }).linkedHere, true);
  assert.equal(api.listDocuments().length, 1);
});

test('device coverage lists the required certifications per device', async () => {
  const { api } = await fresh();
  const d = addDays(todayIso(), 300);
  const mk = (device, category, scheme, extra = {}) => api.store.createRecord({ device, category, scheme, platform: 'UPP', bundle: 'Bundle 6', expiry_date: d, ...extra });
  mk('Lane/3000', 'PCI PTS', 'PCI SSC', { kernel_version: 'v6' });
  mk('Lane/3000', 'EMV L1 Contact', 'EMVCo');
  mk('Lane/3000-CL1', 'EMV L1 Contactless', 'EMVCo');
  mk('Lane/3000-CL1', 'EMV L2 Contactless', 'Visa');
  mk('Lane/3000-CL1', 'EMV L2 Contactless', 'Mastercard');
  const cov = api.deviceCoverage();
  const lane = cov.rows.find((r) => r.device === 'Lane/3000');
  const cl1 = cov.rows.find((r) => r.device === 'Lane/3000-CL1');
  assert.equal(lane.cells.pci.status, 'ok');
  assert.equal(lane.cells.tqm.status, 'none', 'with a contactless side, TQM is held per hardware version');
  assert.equal(lane.cells['l2:Visa'].status, 'none', 'the shared part needs no L2 contactless');
  assert.equal(lane.missing, 0, 'L2 Contact is one kernel for the bundle, not a per-device gap');
  assert.equal(cl1.cells['l2:Visa'].status, 'ok');
  assert.equal(cl1.cells['l2:Amex'].status, 'missing');
  assert.equal(cl1.missing, 6); // TQM + Amex, Discover, UnionPay, JCB, Interac
  api.setCoverageNA(cl1.key, 'tqmcl', true);
  assert.equal(api.deviceCoverage().rows.find((r) => r.device === 'Lane/3000-CL1').cells.tqmcl.status, 'na');
  assert.equal(api.createMissing([{ device: 'Lane/3000-CL1', platform: 'UPP', bundle: 'Bundle 6', slot: 'l2:Amex' }]), 1);
  assert.equal(api.deviceCoverage().rows.find((r) => r.device === 'Lane/3000-CL1').cells['l2:Amex'].status, 'nodate');
});

test('one device keeps one spelling; reader variants stay separate devices', async () => {
  const { api } = await fresh();
  api.store.createRecord({ device: 'Lane/3000-CL1', category: 'EMV L1 Contactless', scheme: 'EMVCo' });
  const b = api.store.createRecord({ device: 'Lane/3000 CL1', category: 'EMV L2 Contactless', scheme: 'Visa' });
  assert.equal(b.device, 'Lane/3000-CL1');
  const c = api.store.createRecord({ device: 'Lane/3000 CL2', category: 'EMV L2 Contactless', scheme: 'Visa' });
  assert.equal(c.device, 'Lane/3000 CL2', 'CL2 is a different reader');
  // Older spelling variants are merged on upgrade, and records filed as Other
  // with an "L2 Contact" tag (1.0.10-1.0.13) return to EMV L2 Contact.
  api.store.db.run("UPDATE records SET device='LANE3000CL1' WHERE id=?", [b.id]);
  api.store.db.run("INSERT INTO records(id, rkey, device, category, scheme, tags, created_at, updated_at) VALUES('x1','k-x1','NX9','Other','EMVCo','L2 Contact, Retail','2026-01-01','2026-01-01')");
  api.store.setSettings({ appVersion: '0.0.1' });
  api.upgradeBackup(null);
  assert.equal(api.store.getRecord(b.id).device, 'Lane/3000-CL1');
  const x = api.store.getRecord('x1');
  assert.equal(x.category, 'EMV L2 Contact');
  assert.equal(x.tags, 'Retail');
  assert.ok(api.info().taxonomy.categories.includes('EMV L2 Contact'));
});

test('a record shows every certification of its physical device', async () => {
  const { api } = await fresh();
  const mk = (device, category, scheme, extra = {}) => api.store.createRecord({ device, category, scheme, platform: 'UPP', bundle: 'Bundle 6', expiry_date: '2028-01-01', ...extra });
  mk('Lane/5000', 'PCI PTS', 'PCI SSC', { kernel_version: 'v6' });
  mk('Lane/5000', 'EMV L1 Contact', 'EMVCo');
  const cl3 = mk('Lane/5000-CL3', 'EMV L1 Contactless', 'EMVCo');
  mk('Lane/5000-CL3', 'EMV L2 Contactless', 'JCB', { approval_number: 'JCB-9' });
  mk('Lane/5000-CL2', 'EMV L2 Contactless', 'Visa');
  mk('Lane/7000-CL3', 'EMV L2 Contactless', 'Visa');
  api.store.createRecord({ device: 'Lane/5000-CL3', category: 'EMV L2 Contactless', scheme: 'Amex', platform: 'UPP', bundle: 'Bundle 5' });
  const p = api.deviceProfile(cl3.id);
  assert.deepEqual(p.sections.map((s) => s.device), ['Lane/5000', 'Lane/5000-CL2', 'Lane/5000-CL3']);
  assert.equal(p.sections[1].replacedBy, 'Lane/5000-CL3', 'CL2 is replaced by the newer CL3');
  const r3 = p.sections[2].rows;
  assert.equal(r3.find((r) => r.slot === 'l2:JCB').record.approval_number, 'JCB-9');
  assert.equal(r3.find((r) => r.slot === 'l2:Amex').status, 'missing', 'other bundles are not mixed in');
  assert.ok(!p.sections[0].rows.some((r) => r.slot === 'tqm'), 'TQM is per hardware version');
  assert.equal(r3.find((r) => r.slot === 'tqmcl').status, 'missing');
  const rid = api.createSlot({ device: 'Lane/5000-CL3', platform: 'UPP', bundle: 'Bundle 6', slot: 'tqmcl' });
  assert.equal(api.store.getRecord(rid).category, 'TQM');
  assert.equal(api.deviceProfile(cl3.id).sections[2].rows.find((r) => r.slot === 'tqmcl').record.id, rid);
});

test('one LOA can certify a series of devices that share a reader', async () => {
  const { api } = await fresh();
  const base = { platform: 'UPP', bundle: 'Bundle 6', category: 'EMV L1 Contact', scheme: 'EMVCo' };
  api.store.createRecord({ ...base, device: 'Lane/3600', category: 'PCI PTS', scheme: 'PCI SSC', expiry_date: '2031-04-30' });
  const a = api.store.createRecord({ ...base, device: 'Lane/5000', expiry_date: '2028-07-12', covers: 'Lane 3600, Desk/1700, lane/5000' });
  assert.equal(api.store.getRecord(a.id).covers, 'Lane/3600, Desk/1700', 'own device dropped, known spelling used');
  const cov = api.deviceCoverage();
  const l3600 = cov.rows.find((r) => r.device === 'Lane/3600');
  assert.equal(l3600.cells.l1c.status, 'ok');
  assert.equal(l3600.cells.l1c.record.sharedFrom, 'Lane/5000');
  const desk = cov.rows.find((r) => r.device === 'Desk/1700');
  assert.ok(desk, 'a covered device with no records of its own still appears');
  assert.equal(desk.cells.l1c.record.id, a.id);
  const p3600 = api.deviceProfile(api.listRecords().find((r) => r.device === 'Lane/3600').id);
  assert.equal(p3600.sections[0].rows.find((r) => r.slot === 'l1c').record.sharedFrom, 'Lane/5000');
  api.setReaderGroup('Contact reader A', ['Lane/5000', 'Lane/3600', 'Desk/1700']);
  assert.deepEqual(api.listReaderGroups()['Contact reader A'], ['Lane/5000', 'Lane/3600', 'Desk/1700']);
  api.setReaderGroup('Contact reader A', []);
  assert.deepEqual(api.listReaderGroups(), {});
});

test('records with no bundle join their device\'s bundle on the Devices page', async () => {
  const { api } = await fresh();
  api.store.createRecord({ device: 'Lane/3000', category: 'PCI PTS', scheme: 'PCI SSC', platform: 'UPP', bundle: 'Bundle 6', expiry_date: '2031-04-30' });
  api.store.createRecord({ device: 'Lane/3000', category: 'EMV L1 Contact', scheme: 'EMVCo', expiry_date: '2028-07-12' });
  const cov = api.deviceCoverage();
  assert.equal(cov.rows.length, 1, 'no separate Unassigned row');
  assert.equal(cov.rows[0].cells.l1c.status, 'ok');
  assert.equal(cov.rows[0].missing, 1); // TQM
  api.store.createRecord({ device: 'Desk/1700', category: 'EMV L1 Contact', scheme: 'EMVCo' });
  assert.equal(api.deviceCoverage().rows.find((r) => r.device === 'Desk/1700').grp, 'Unassigned', 'a device with no bundle anywhere stays Unassigned');
});

test('an accepted expiration (end of life) raises no actions and is not a gap', async () => {
  const { api } = await fresh();
  const base = { platform: 'UPP', bundle: 'Bundle 6' };
  const l1 = api.store.createRecord({ ...base, device: 'Lane/3000-CL1', category: 'EMV L1 Contactless', scheme: 'EMVCo', expiry_date: addDays(todayIso(), -10) });
  const visa = api.store.createRecord({ ...base, device: 'Lane/3000-CL1', category: 'EMV L2 Contactless', scheme: 'Visa', expiry_date: addDays(todayIso(), 40) });
  const keys = () => api.analysis().actions.map((a) => a.key);
  assert.ok(keys().some((k) => k.startsWith(`expired:${l1.id}`)));
  assert.ok(keys().some((k) => k.startsWith('depends:')), 'the Visa L2 rests on an expired L1');
  assert.equal(api.setEol([l1.id, visa.id], 'Replaced by the CL2 reader'), 2);
  const a = api.analysis();
  assert.ok(!a.actions.some((x) => x.recordIds.includes(l1.id) && !x.key.startsWith('depends:')), 'no action for an end-of-life record');
  assert.ok(!a.actions.some((x) => x.key.startsWith('depends:')), 'both ends of life: no dependency warning');
  assert.equal(a.summary.eol, 2);
  assert.equal(a.summary.due90, 0);
  const r = api.listRecords().find((x) => x.id === l1.id);
  assert.equal(r.health, 'retired');
  assert.equal(r.stageNow, 'Retired');
  const row = api.deviceCoverage().rows.find((x) => x.device === 'Lane/3000-CL1');
  assert.equal(row.cells.l1cl.status, 'eol');
  assert.ok(row.retired, 'every certification of the reader is end of life');
  assert.equal(row.missing, 0, 'a retired reader has no gaps');
  api.setEol([l1.id], '');
  assert.equal(api.listRecords().find((x) => x.id === l1.id).health, 'expired');
});

test('dependency warnings: L1 before L2, TQM for Mastercard, PCI for production', async () => {
  const { api } = await fresh();
  const mk = (device, category, scheme, days) => api.store.createRecord({ device, category, scheme, expiry_date: addDays(todayIso(), days) });
  mk('Move/5000-CL2', 'EMV L1 Contactless', 'EMVCo', 200);
  mk('Move/5000-CL2', 'EMV L2 Contactless', 'Visa', 700);
  mk('Move/5000-CL2', 'EMV L2 Contactless', 'Mastercard', 700);
  mk('Move/5000-CL2', 'TQM', 'Mastercard TQM', -5);
  mk('Move/5000', 'PCI PTS', 'PCI SSC', -1);
  const acts = api.analysis().actions;
  const l1 = acts.find((a) => a.kind === 'dependency' && /L1 Contactless/.test(a.title));
  assert.ok(l1, 'L1 expiring before the L2 approvals that rest on it');
  assert.match(l1.title, /2 approvals at risk/);
  assert.equal(l1.priority, 3);
  const tqm = acts.find((a) => a.kind === 'dependency' && /^TQM/.test(a.title));
  assert.match(tqm.title, /has expired: 1 approval at risk/);
  assert.equal(tqm.priority, 2);
  assert.ok(acts.some((a) => a.key.startsWith('pci-production:')));
});

test('escalation radar groups approvals 18, 12, 6 and 3 months out', async () => {
  const { api } = await fresh();
  const mk = (device, days, extra = {}) => api.store.createRecord({ device, category: 'EMV L2 Contactless', scheme: 'Amex', expiry_date: addDays(todayIso(), days), ...extra });
  mk('A1', 400); mk('A2', 500); mk('A3', 450, { renewal_path: 'Delta testing' });
  mk('B1', 250); mk('C1', 120); mk('D1', 45); mk('D2', 50, { stage: 'Replacement Received' });
  const radar = Object.fromEntries(api.analysis().actions.filter((a) => a.kind === 'radar').map((a) => [a.key.split(':')[1], a]));
  assert.equal(radar.t18.recordIds.length, 2, 'a decided renewal path leaves the 18-month radar');
  assert.equal(radar.t12.recordIds.length, 1);
  assert.equal(radar.t6.recordIds.length, 1);
  assert.equal(radar.t3.recordIds.length, 1, 'a received replacement needs no escalation');
  assert.equal(api.listRecords().find((r) => r.device === 'A1').window, 'd545');
});

test('a reader version tag added by hand renames the device, and back', async () => {
  const { api } = await fresh();
  api.store.createRecord({ device: 'Lane/3000-CL2', category: 'EMV L1 Contactless', scheme: 'EMVCo' });
  const r = api.store.createRecord({ device: 'Lane/3000', category: 'EMV L2 Contactless', scheme: 'Visa', tags: 'Retail' });
  api.saveRecord(r.id, { tags: 'Retail, CL2' });
  assert.equal(api.store.getRecord(r.id).device, 'Lane/3000-CL2');
  api.bulkUpdate([r.id], {}, { remove: ['CL1', 'CL2', 'CL3'], add: ['CL3'] });
  assert.equal(api.store.getRecord(r.id).device, 'Lane/3000-CL3');
  api.saveRecord(r.id, { tags: 'Retail' });
  assert.equal(api.store.getRecord(r.id).device, 'Lane/3000', 'removing the tag removes the suffix');
  const n = api.store.createRecord({ device: 'Desk/1700 CL1', category: 'EMV L1 Contactless', scheme: 'EMVCo' });
  assert.match(n.tags, /CL1/, 'the device name still tags the reader version');
});

test('a duplicate LOA dropped in the inbox can be mapped to another reader version', async () => {
  const { api } = await fresh();
  const a = api.store.createRecord({ device: 'Lane/5000-CL2', category: 'EMV L2 Contactless', scheme: 'Mastercard', platform: 'UPP', bundle: 'Bundle 6' });
  const b = api.store.createRecord({ device: 'Lane/5000-CL3', category: 'EMV L2 Contactless', scheme: 'Mastercard', platform: 'UPP', bundle: 'Bundle 6' });
  const bytes = Buffer.from('%PDF-1.4 mastercard letter');
  const pages = ['Mastercard Letter of Approval\nProduct Name: Lane/5000-CL2\nApproval Number: MC-555\nExpiry Date: 11 March 2028\n' + 'x'.repeat(60)];
  const first = api.attachNewDocument(a.id, { filename: 'Lane5000_MC.pdf', bytes, pages });
  api.linkDocumentToRecord(a.id, first.documentId, { useValues: true, values: { approval_number: 'MC-555', expiry_date: '2028-03-11' } });
  const res = api.ingestDocument({ filename: 'Lane5000_MC.pdf', bytes, pages });
  assert.equal(res.status, 'duplicate');
  assert.equal(res.linkedTo[0].device, 'Lane/5000-CL2');
  const info = api.duplicateInfo(res.documentId);
  assert.deepEqual(info.suggestions.map((s) => s.id), [b.id], 'the CL3 record of the same brand is suggested');
  const m = api.mapDuplicate(res.documentId, { recordIds: [b.id], create: ['Lane/7000-CL2'] });
  assert.equal(m.linked, 2);
  assert.equal(api.store.getRecord(b.id).expiry_date, '2028-03-11');
  const created = api.listRecords().find((r) => r.device === 'Lane/7000-CL2');
  assert.equal(created.category, 'EMV L2 Contactless');
  assert.equal(created.scheme, 'Mastercard');
  assert.equal(created.approval_number, 'MC-555');
});

test('data checks flag conflicts and likely mistakes', async () => {
  const { api } = await fresh();
  api.store.createRecord({ device: 'Lane/3000', category: 'EMV L1 Contact', scheme: 'EMVCo', approval_number: 'L1C-1', issue_date: '2027-01-01', expiry_date: '2026-01-01' });
  api.store.createRecord({ device: 'Lane/3000-CL1', category: 'EMV L2 Contactless', scheme: 'Mastercard', approval_number: 'MC-9', expiry_date: '2028-01-01' });
  api.store.createRecord({ device: 'Lane/3600-CL1', category: 'EMV L2 Contactless', scheme: 'Mastercard', approval_number: 'MC-9', expiry_date: '2029-01-01' });
  api.store.createRecord({ device: 'Lnae/3000', category: 'PCI PTS', scheme: 'PCI SSC', expiry_date: '2029-01-01', approval_number: '4-1234' });
  const keys = api.dataChecks().map((i) => i.key);
  for (const k of ['dates-order', 'number-dates', 'device-typo', 'l2-no-l1', 'mc-no-tqm']) assert.ok(keys.includes(k), k);
  const review = await api.aiDataReview();
  assert.equal(review.ai, false);
  assert.match(review.text, /Data checks found/);
});

test('briefing export lists what is due, and the L3 sheet lists approval numbers', async () => {
  const { api } = await fresh();
  api.store.createRecord({ device: 'Lane/3000', category: 'EMV L1 Contact', scheme: 'EMVCo', approval_number: 'L1C-7', expiry_date: addDays(todayIso(), 60), platform: 'UPP', bundle: 'B6' });
  const gone = api.store.createRecord({ device: 'Lane/3000-CL1', category: 'EMV L1 Contactless', scheme: 'EMVCo', expiry_date: addDays(todayIso(), 30), eol: 'Replaced by CL2' });
  api.store.createRecord({ device: 'Lane/3000', category: 'PCI PTS', scheme: 'PCI SSC', expiry_date: addDays(todayIso(), 900), platform: 'UPP', bundle: 'B6' });
  const rep = api.briefingReport({ briefing: 'Do the thing' });
  assert.equal(rep.count, 1, 'end of life and far-off records are left out');
  assert.ok(!rep.ids.includes(gone.id));
  assert.match(rep.html, /Renewing\?/);
  assert.match(rep.html, /L1C-7/);
  assert.match(rep.text, /Lane\/3000\tUPP · B6\tL1 Contact/);
  assert.equal(api.briefingReport({ months: 36 }).count, 2);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await api.exportL3Sheet({ platform: 'UPP' }));
  const ws = wb.getWorksheet('L3 approval numbers');
  const header = ws.getRow(1).values.filter(Boolean);
  assert.ok(header.includes('L2 Contact approval'));
  const vals = ws.getRow(2).values.filter(Boolean);
  assert.ok(vals.includes('Lane/3000') && vals.includes('L1C-7'));
});

test('the assistant reads the industry background and the user rules file', async () => {
  const { systemPrompt } = require('../src/core/ai');
  const p = systemPrompt('- CL1 readers are end of life.');
  assert.match(p, /L2 rests on L1/);
  assert.match(p, /TQM/);
  assert.match(p, /CL1 readers are end of life/);
  assert.ok(!/organisation's own rules/.test(systemPrompt('')));
});

test('a device name without a CL suffix is its first hardware version (CL1)', async () => {
  const { api } = await fresh();
  const mk = (device, category, scheme, days = 400) => api.store.createRecord({ device, category, scheme, platform: 'UPP', bundle: 'B6', expiry_date: addDays(todayIso(), days) });
  mk('Lane/3000', 'PCI PTS', 'PCI SSC');
  mk('Lane/3000', 'EMV L1 Contactless', 'EMVCo', 100);
  const visa1 = mk('Lane/3000-CL1', 'EMV L2 Contactless', 'Visa', 200);
  mk('Lane/3000-CL2', 'EMV L1 Contactless', 'EMVCo', 900);
  mk('Lane/3000-CL2', 'PCI PTS', 'PCI SSC', 1200);
  const rows = api.deviceCoverage().rows;
  assert.deepEqual(rows.map((r) => r.label), ['Lane/3000', 'Lane/3000-CL1', 'Lane/3000-CL2']);
  const cl1 = rows[1];
  assert.equal(cl1.cells.l1cl.status, 'ok', 'the L1 Contactless filed under the bare name belongs to CL1');
  assert.equal(cl1.cells['l2:Visa'].record.id, visa1.id);
  assert.equal(cl1.replacedBy, 'Lane/3000-CL2');
  assert.equal(rows[0].cells.pci.record.expiry_date, addDays(todayIso(), 1200), 'PCI is shared by every version; the latest wins');
  // Only a bare name: its version row is labelled CL1 and new records use the bare name.
  const { api: b } = await fresh();
  b.store.createRecord({ device: 'Desk/1700', category: 'EMV L1 Contactless', scheme: 'EMVCo' });
  const r = b.deviceCoverage().rows.find((x) => x.version === 'CL1');
  assert.equal(r.label, 'Desk/1700 (CL1)');
  assert.equal(r.device, 'Desk/1700');
  // The plan warns about an old version expiring when a newer one exists.
  const acts = api.analysis().actions.filter((a) => a.kind === 'version');
  assert.equal(acts.length, 1);
  assert.match(acts[0].title, /Lane\/3000-CL1 is replaced by CL2/);
  assert.ok(acts[0].recordIds.includes(visa1.id));
  // L2 on CL1 rests on the L1 Contactless filed under the bare name.
  assert.ok(!api.dataChecks().some((i) => i.key === 'l2-no-l1'));
});

test('an L2 letter for a different kernel is flagged, not quietly applied', async () => {
  const { api } = await fresh();
  await api.importTracker({ filename: 'tracker.csv', bytes: Buffer.from(CSV) });
  const rec = api.listRecords().find((r) => r.device === 'Flex/3500-CL1');
  api.saveRecord(rec.id, { kernel_version: '123 v0405' });
  api.ingestDocument({ filename: 'disc.pdf', bytes: Buffer.from('k1'), pages: [L.discover] });
  const p = api.listInbox('pending').find((i) => i.parsed.scheme === 'Discover').proposals[0];
  assert.deepEqual(p.changes.kernel_version, { from: '123 v0405', to: '123 v0406' });
  assert.match(p.warnings.join(' '), /Different kernel/);
  assert.ok(api.dataChecks().every((c) => c.key !== 'l2-no-kernel' || !c.recordIds.includes(rec.id)));
});

test('corrections on review cards are learned and applied to later letters', async () => {
  const { api } = await fresh();
  await api.importTracker({ filename: 'tracker.csv', bytes: Buffer.from(CSV) });
  // A device name the reader got wrong: fixed once, remembered after.
  const odd = L.discover.replace('Flex/3XXX CL1', 'FlexiPad 97');
  api.ingestDocument({ filename: 'a.pdf', bytes: Buffer.from('la'), pages: [odd] });
  let it = api.listInbox('pending').find((i) => i.filename === 'a.pdf');
  assert.equal(it.proposals[0].action, 'create');
  api.applyInbox(it.id, [{ index: 0, edits: { device: 'Pad/900' } }]);
  assert.deepEqual(api.listLearned().map((x) => [x.kind, x.said, x.to[0]]), [['device', 'FlexiPad 97', 'Pad/900']]);
  api.ingestDocument({ filename: 'b.pdf', bytes: Buffer.from('lb'), pages: [odd.replace('January 5, 2029', 'January 5, 2030')] });
  it = api.listInbox('pending').find((i) => i.filename === 'b.pdf');
  assert.equal(it.proposals[0].device, 'Pad/900');
  assert.equal(it.proposals[0].action, 'update');
  api.rejectInbox(it.id, '');

  // Adding only a hardware version is about that letter, not a rule.
  const nx = L.discover.replace('Flex/3XXX CL1', 'NX777');
  api.ingestDocument({ filename: 'c.pdf', bytes: Buffer.from('lc'), pages: [nx] });
  it = api.listInbox('pending').find((i) => i.filename === 'c.pdf');
  api.applyInbox(it.id, [{ index: 0, edits: { device: 'NX777-CL2' } }]);
  assert.equal(api.listLearned().length, 1);

  // Records picked for a family name are ticked again next time.
  const fam = L.discover.replace('Flex/3XXX CL1', 'Zeta/7XXX');
  api.ingestDocument({ filename: 'd.pdf', bytes: Buffer.from('ld'), pages: [fam] });
  it = api.listInbox('pending').find((i) => i.filename === 'd.pdf');
  assert.equal(it.proposals[0].action, 'unmatched');
  const pad = api.listRecords().find((r) => r.device === 'Pad/900');
  api.applyInbox(it.id, [{ index: 0, recordIds: [pad.id] }]);
  api.ingestDocument({ filename: 'e.pdf', bytes: Buffer.from('le'), pages: [fam.replace('January 5, 2029', 'January 5, 2031')] });
  it = api.listInbox('pending').find((i) => i.filename === 'e.pdf');
  assert.deepEqual(it.proposals[0].suggest, [pad.id]);

  // Forgetting a device rule removes its alias.
  api.forgetLearned('device', api.listLearned().find((x) => x.kind === 'device').from);
  assert.ok(!Object.values(api.listAliases()).includes('Pad/900'));
  assert.equal(api.listLearned().length, 1);
});

test('a bundle page: every date becomes one record, and the register is checked against it', async () => {
  const { api } = await fresh();
  const page = [
    'Kernel Bundle 9',
    'This kernel bundle for NWP uses the EMV Contact kernel v4.10, which expires on 01/01/28 located here.',
    'Specification   Card Version   Kernel Version',
    'Visa Paywave   2.2   070803',
    'Mastercard Paypass   4.0   100100',
    'PCI',
    'Terminal   Version   Exp Date',
    'NX100   v6   04/30/31',
    'EMV Contact',
    'Terminal   Bulletin   L1 Contact   TQM',
    'NX100   -   07/12/28   02/01/27',
    'EMV Contactless',
    'Terminal   Bulletin   L1 Contactless   TQM',
    'NX100-CL1   -   12/31/27   02/01/27',
    'EMV Contactless',
    'Terminal   Visa   Mastercard',
    'NX100-CL1   12/03/28   03/11/28',
  ].join('\n');
  // The register: an older L1 date, a placeholder with no date, a twin record, and a bundle name spelled differently.
  const mk = (x) => api.store.createRecord({ platform: 'NWP', bundle: 'NWP Bundle 9', ...x });
  mk({ device: 'NX100', category: 'EMV L1 Contact', scheme: 'EMVCo', expiry_date: '2026-07-12' });
  mk({ device: 'NX100-CL1', category: 'EMV L2 Contactless', scheme: 'Visa', expiry_date: '2028-12-03' });
  mk({ device: 'NX100', category: 'EMV L2 Contactless', scheme: 'Visa', expiry_date: '2028-12-03' });
  mk({ device: 'NX100-CL1', category: 'EMV L2 Contactless', scheme: 'Amex', notes: 'Waiver required' });
  const r = api.readBundlePage({ filename: 'bundle9.txt', text: page });
  assert.equal(r.key, 'NWP|9', 'Kernel Bundle 9 and NWP Bundle 9 are one bundle');
  assert.equal(r.pageDates, 8, 'PCI, L1 contact + TQM, L1 contactless + TQM, two brands, the L2 contact kernel');
  assert.deepEqual([r.missing, r.pageNewer, r.duplicates, r.undated, r.same], [6, 1, 1, 1, 1]);
  const done = api.cleanBundle(r.key, { missing: true, pageNewer: true, duplicates: true, undated: true });
  assert.equal(done.after.ok, true);
  assert.equal(done.after.recordDates, 8, 'one record per date on the page');
  const v = api.bundleView(r.key);
  assert.equal(v.l2contactKernel, '4.10');
  assert.equal(v.sections.l2contactless[0].cells.visa.kernel_version, '070803', 'brand kernel taken from the page');
  assert.equal(v.sections.contact[0].cells.l1.expiry_date, '2028-07-12');
  assert.match(api.bundleReport(r.key).html, /12\/03\/28/);
  // L2 Contact is one kernel for the bundle: a second one is a duplicate.
  const issues = api.checkRecord(null, { device: 'NX100', category: 'EMV L2 Contact', scheme: 'EMVCo', platform: 'NWP', bundle: 'NWP Bundle 9', expiry_date: '2028-01-01' });
  assert.equal(issues[0].level, 'stop');
  assert.match(issues[0].title, /Duplicate/);
  // A date that disagrees with the page is flagged while editing.
  const l1 = api.listRecords().find((x) => x.category === 'EMV L1 Contact');
  const w = api.checkRecord(l1.id, { expiry_date: '2027-01-01' });
  assert.ok(w.some((i) => /earlier/.test(i.title)) && w.some((i) => /website shows/.test(i.title)));
  assert.deepEqual(api.checkRecord(l1.id, { notes: 'hello' }), [], 'an unrelated edit is not blocked');
});
