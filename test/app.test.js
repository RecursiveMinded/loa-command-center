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

  const again = api.ingestDocument({ filename: 'copy.pdf', bytes: Buffer.from('pdf-bytes-1'), pages: [L.amex] });
  assert.equal(again.status, 'duplicate');

  api.rejectInbox(mc.id, 'not now');
  assert.equal(api.listInbox('rejected').length, 1);
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
  for (const dev of ['A1', 'A2', 'A3']) api.saveRecord(null, { device: dev, scheme: 'Visa', category: 'EMV L2 Contact', expiry_date: d });
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
  const { Database } = require('../src/core/db');
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
  assert.equal(again.get("SELECT value FROM settings WHERE key='schema_version'").value, '2');
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
  assert.ok(junk.parsed.warnings.some((w) => /not a device you track/.test(w)));

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
