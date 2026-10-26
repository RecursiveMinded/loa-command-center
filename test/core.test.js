'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDate, addYears, daysBetween } = require('../src/core/dates');
const { makeNormalizer, deviceScore, splitProducts, wildcardRegex, splitVariant } = require('../src/core/devices');
const { parseDocument, segmentLetters } = require('../src/core/loa-parser');
const { isDue, nextSlot } = require('../src/core/schedule');
const { coverage, windowFor } = require('../src/core/lifecycle');
const { isLocalUrl } = require('../src/core/ai');
const L = require('./fixtures/letters');

test('dates: the formats found in LOAs', () => {
  assert.equal(parseDate('May 22, 2024'), '2024-05-22');
  assert.equal(parseDate('August 20th, 2027'), '2027-08-20');
  assert.equal(parseDate('5 June 2024'), '2024-06-05');
  assert.equal(parseDate('27-Apr-2027'), '2027-04-27');
  assert.equal(parseDate('1st February 2027'), '2027-02-01');
  assert.equal(parseDate('2024.12.23'), '2024-12-23');
  assert.equal(parseDate('2024-07-31'), '2024-07-31');
  assert.equal(parseDate('04/30/26'), '2026-04-30');
  assert.equal(parseDate('not a date'), null);
  assert.equal(addYears('2024-02-29', 3), '2027-02-28');
  assert.equal(daysBetween('2026-01-01', '2026-01-31'), 30);
});

test('devices: names match across spellings, readers and families', () => {
  const norm = makeNormalizer(['ACME']);
  assert.equal(deviceScore('ACME NX200', 'NX200', norm), 100);
  assert.equal(deviceScore('nx-200', 'NX200', norm), 100);
  assert.equal(deviceScore('NX200 CL1', 'NX200-CL1', norm), 100);
  assert.equal(deviceScore('NX200 CL1', 'NX200-CL2', norm), 0, 'different reader versions never match');
  assert.equal(deviceScore('NX200', 'NX200-CL1', norm), 80, 'no reader version in the letter: likely, needs a look');
  assert.ok(deviceScore('Flex/3XXX CL1', 'Flex/3500-CL1', norm) >= 60, 'wildcard family');
  assert.equal(deviceScore('Flex/3XXX CL1', 'Flex/4500-CL1', norm), 0);
  assert.ok(wildcardRegex(splitVariant(norm('Flex/3XXX')).base));
  assert.deepEqual(splitProducts('ACME NX200 & NX300 version MCL4.0'), ['ACME NX200', 'ACME NX300']);
  assert.deepEqual(splitProducts('Flex/SXXX CL1'), ['Flex/5XXX CL1'], 'OCR letter/digit confusion is corrected');
});

test('parser: each issuer layout yields the key facts', () => {
  const one = (t) => parseDocument([t])[0];
  const v = (f) => f && f.value;

  const amex = one(L.amex);
  assert.equal(amex.scheme, 'Amex');
  assert.equal(v(amex.issueDate), '2024-05-22');
  assert.equal(v(amex.expiryDate), '2027-05-22', 'three years from issue');
  assert.match(amex.expiryBasis, /^Calculated/);
  assert.deepEqual(amex.products.map((p) => p.value), ['NX200']);

  const disc = one(L.discover);
  assert.equal(disc.scheme, 'Discover');
  assert.equal(disc.category, 'EMV L2 Contactless');
  assert.equal(v(disc.expiryDate), '2029-01-05');
  assert.equal(disc.products[0].value, 'Flex/3XXX CL1');

  const emv = one(L.emvco);
  assert.equal(emv.category, 'EMV L1 Contact');
  assert.equal(v(emv.approvalNumber), '12345 0124 430 43a 43a LABX');
  assert.equal(v(emv.expiryDate), '2028-06-30');

  const mc = one(L.mastercard);
  assert.equal(v(mc.approvalNumber), 'TLOA-NW250415(a)');
  assert.equal(v(mc.expiryDate), '2028-09-05');
  assert.deepEqual(mc.products.map((p) => p.value), ['NX200', 'NX300']);

  const pci = one(L.pci);
  assert.equal(pci.category, 'PCI PTS');
  assert.equal(v(pci.approvalNumber), '4-12345');
  assert.equal(v(pci.expiryDate), '2031-04-30');
  assert.equal(v(pci.kernelVersion), 'v6.1');

  const b = one(L.bulletin);
  assert.equal(b.informational, true);
});

test('parser: labels and values split across printed lines', () => {
  const wrapped = L.discover.replace('Product: Flex/3XXX CL1 Product Reference', 'Product:\nFlex/3XXX CL1\nProduct Reference')
    .replace('Approval Expiration Date: January 5, 2029', 'Approval Expiration\nDate: January 5, 2029')
    .replace('this approval will expire on January 5, 2029', 'this approval lasts');
  const d = parseDocument([wrapped])[0];
  assert.equal(d.products[0].value, 'Flex/3XXX CL1');
  assert.equal(d.expiryDate.value, '2029-01-05');
});

test('parser: a merged PDF splits into letters with page numbers', () => {
  const segs = segmentLetters([L.amex, L.discover, `${L.emvco}\n\n${L.mastercard}`]);
  assert.deepEqual(segs.map((s) => [s.type, s.pageStart]), [['amex', 1], ['discover', 2], ['emvco', 3], ['mastercard', 3]]);
  const letters = parseDocument([L.amex, L.discover]);
  assert.equal(letters[1].issueDate.value, '2026-01-05', 'each letter keeps its own date');
});

test('schedule: daily, weekly and monthly digests', () => {
  const at = (s) => new Date(s);
  const weekly = { enabled: true, frequency: 'weekly', weekday: 1, time: '08:30', lastSent: null };
  assert.equal(isDue(weekly, at('2026-10-26T09:00:00')), true, 'Monday after 08:30');
  assert.equal(isDue({ ...weekly, lastSent: '2026-10-26T08:31:00' }, at('2026-10-27T09:00:00')), false);
  assert.equal(isDue({ ...weekly, lastSent: '2026-10-19T08:31:00' }, at('2026-10-27T09:00:00')), true, 'missed slot fires once');
  const daily = { enabled: true, frequency: 'daily', time: '07:00', lastSent: '2026-10-26T07:00:00' };
  assert.equal(nextSlot(daily, at('2026-10-26T10:00:00')).getDate(), 27);
  assert.equal(isDue({ ...daily, enabled: false }, at('2026-10-27T10:00:00')), false);
  const monthly = { enabled: true, frequency: 'monthly', monthday: 1, time: '08:00', lastSent: '2026-10-01T08:00:00' };
  assert.equal(isDue(monthly, at('2026-10-31T10:00:00')), false);
  assert.equal(isDue(monthly, at('2026-11-01T08:01:00')), true);
});

test('lifecycle: windows and replacement coverage', () => {
  assert.equal(windowFor(-1).key, 'expired');
  assert.equal(windowFor(25).key, 'd30');
  assert.equal(windowFor(400).key, 'later');
  assert.deepEqual(coverage('2026-12-31', '2026-12-01'), { kind: 'overlap', days: 31 });
  assert.equal(coverage('2026-12-31', '2027-01-10').kind, 'gap');
});

test('ai: only local or private network servers are allowed', () => {
  assert.equal(isLocalUrl('http://127.0.0.1:11434'), true);
  assert.equal(isLocalUrl('http://localhost:1234'), true);
  assert.equal(isLocalUrl('http://192.168.1.20:11434'), true);
  assert.equal(isLocalUrl('https://api.example.com'), false);
});
