'use strict';
// Data integrity checks: deterministic spot checks the Ask AI drawer shows as
// clean-up recommendations. Each finding names the records it is about, so
// the user can open them and fix or confirm them.

const { daysBetween } = require('./dates');
const { isEol } = require('./lifecycle');
const { certHome } = require('./devices');

const defaultNorm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const coversOf = (r) => String(r.covers || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const label = (r) => `${r.device} · ${r.scheme} ${r.category}`;
// Placeholders such as "See LOA archive" or "TBD" are not approval numbers.
const realNumber = (v) => String(v || '').replace(/\s+/g, '').length >= 4 && /\d/.test(String(v));

/** Edit distance counting a swap of two neighbouring letters as one edit (Lnae -> Lane). */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * Returns [{ key, severity: 'high'|'medium'|'low', title, detail, fix, recordIds }].
 * `records` are live (not archived) records.
 */
function dataChecks(records, { norm = defaultNorm } = {}) {
  const live = records.filter((r) => !r.archived);
  const out = [];
  const add = (key, severity, title, detail, fix, list) => {
    if (list.length) out.push({ key, severity, title: title(list.length), detail, fix, recordIds: [...new Set(list.map((r) => r.id))], examples: list.slice(0, 5).map(label) });
  };

  // Dates that cannot be right.
  add('dates-order', 'high', (n) => `${n} record${n === 1 ? ' expires' : 's expire'} before ${n === 1 ? 'it was' : 'they were'} issued`,
    'The expiry date is earlier than the issue date, usually a misread or swapped date.', 'Open the LOA and correct the dates.',
    live.filter((r) => r.issue_date && r.expiry_date && r.expiry_date < r.issue_date));
  add('dates-span', 'medium', (n) => `${n} approval${n === 1 ? ' has' : 's have'} an unusual validity period`,
    'EMV and PCI approvals normally run 2 to 6 years. Less than 6 months or more than 7 years points to a wrong date.', 'Check the dates against the LOA.',
    live.filter((r) => r.issue_date && r.expiry_date && r.expiry_date >= r.issue_date && r.category !== 'Letter of Equivalency'
      && (daysBetween(r.issue_date, r.expiry_date) < 180 || daysBetween(r.issue_date, r.expiry_date) > 7 * 366)));

  // One approval number should mean one expiry date.
  const byNumber = new Map();
  for (const r of live) {
    const n = String(r.approval_number || '').toUpperCase().replace(/\s+/g, '');
    if (!realNumber(n) || !r.expiry_date) continue;
    const k = `${n}|${r.category}|${String(r.scheme).toLowerCase()}`;
    if (!byNumber.has(k)) byNumber.set(k, []);
    byNumber.get(k).push(r);
  }
  const clash = [...byNumber.values()].filter((list) => new Set(list.map((r) => r.expiry_date)).size > 1).flat();
  add('number-dates', 'high', (n) => `${n} records share an approval number but disagree on its expiry`,
    'The same approval number carries different expiry dates on different records. One of them is out of date.', 'Open them together and apply the latest LOA to all.',
    clash);

  // Device names that look like typos of each other (same model number).
  const names = new Map();
  for (const r of live) { const k = norm(r.device); if (!names.has(k)) names.set(k, []); names.get(k).push(r); }
  const keys = [...names.keys()].filter((k) => k.length >= 5);
  const typo = [];
  const stripCl = (k) => k.replace(/CL\d$/, '');
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i], b = keys[j];
      if (stripCl(a) === stripCl(b)) continue; // reader versions are different devices
      const num = (k) => (k.match(/\d{3,5}/) || [''])[0];
      if (!num(a) || num(a) !== num(b) || Math.abs(a.length - b.length) > 1) continue;
      if ((a.match(/CL\d$/) || [''])[0] !== (b.match(/CL\d$/) || [''])[0]) continue;
      // Short letter prefixes are model ranges, not words (DX4000 and EX4000 are two devices).
      if ((a.match(/^[A-Z]*/) || [''])[0].length < 3) continue;
      if (distance(a, b) === 1) typo.push(...names.get(a), ...names.get(b));
    }
  }
  add('device-typo', 'medium', (n) => `${n} records use device names that look like typos of each other`,
    'Names one letter apart with the same model number are usually the same device spelled two ways.', 'Rename one spelling, or add a device alias in Settings > Matching.',
    typo);

  // Reader version tag and device name disagree.
  add('cl-mismatch', 'low', (n) => `${n} record${n === 1 ? '' : 's'} with a reader version tag that does not match the device name`,
    'A CLn tag says one reader version while the device name says another (or none).', 'Fix the tag or the device name so they agree.',
    live.filter((r) => {
      const tag = String(r.tags || '').split(',').map((t) => t.trim().toUpperCase()).find((t) => /^CL\d$/.test(t)) || '';
      const name = (norm(r.device).match(/CL\d$/) || [''])[0];
      return tag && tag !== name;
    }));

  // Approval recorded without its number.
  add('no-number', 'low', (n) => `${n} dated approval${n === 1 ? ' has' : 's have'} no approval number`,
    'The approval number is empty or a placeholder (such as "See LOA archive"). Acquirers need the exact number for their Level 3 work.', 'Drop the LOAs in the inbox, or add the numbers from them.',
    live.filter((r) => r.expiry_date && !realNumber(r.approval_number) && !isEol(r) && r.category !== 'Letter of Equivalency'));

  // An L2 approval is for one kernel build; Level 3 partners need to know which.
  add('l2-no-kernel', 'low', (n) => `${n} L2 approval${n === 1 ? ' has' : 's have'} no kernel version`,
    'An L2 letter approves one kernel build (name and version). Without it, acquirers cannot match the approval to the software in the field, and a kernel upgrade cannot be planned.', 'Drop the L2 LOAs in the inbox to read the kernel version, or type it in.',
    live.filter((r) => /^EMV L2/.test(r.category) && !isEol(r) && !String(r.kernel_version || '').trim()));

  // Foundations: L2 without L1, Mastercard L2 without TQM.
  // Where each approval lives: the device (PCI, contact) or the hardware version (contactless, TQM; no suffix = CL1).
  const has = new Map();
  const at = (d, category) => certHome(norm(d), category).key;
  for (const r of live) for (const d of [r.device, ...coversOf(r)]) { const k = at(d, r.category); if (!has.has(k)) has.set(k, new Set()); has.get(k).add(r.category); }
  const holds = (r, category) => (has.get(at(r.device, category)) || new Set()).has(category);
  add('l2-no-l1', 'medium', (n) => `${n} L2 approval${n === 1 ? ' has' : 's have'} no L1 approval on file for the same device`,
    'An L2 kernel approval rests on the L1 approval of the same interface (contact or contactless).', 'Add the L1 LOA, or link the device to the LOA that covers it.',
    // The EMV L2 contact kernel is one approval for the whole bundle, not tied to one device's L1.
    live.filter((r) => !isEol(r) && r.category === 'EMV L2 Contactless' && !holds(r, 'EMV L1 Contactless')));
  add('mc-no-tqm', 'medium', (n) => `${n} Mastercard L2 approval${n === 1 ? ' has' : 's have'} no TQM on file for the device`,
    'A valid TQM statement is required to obtain and keep Mastercard L2 approvals.', 'Add the TQM statement for the device.',
    live.filter((r) => !isEol(r) && r.category === 'EMV L2 Contactless' && r.scheme === 'Mastercard' && !holds(r, 'TQM')));

  // End of life that still has live approvals resting on it.
  const eolL1 = new Set(live.filter((r) => isEol(r) && /^EMV L1/.test(r.category)).map((r) => `${at(r.device, r.category)}|${r.category.replace('L1', 'L2')}`));
  add('eol-l1-live-l2', 'low', (n) => `${n} L2 approval${n === 1 ? ' rests' : 's rest'} on an L1 approval marked end of life`,
    'The L1 approval will not be renewed, but the L2 approvals that depend on it are still tracked as live.', 'Mark them end of life too, or renew the L1.',
    live.filter((r) => !isEol(r) && eolL1.has(`${at(r.device, r.category)}|${r.category}`)));

  // Placed nowhere although the device is placed elsewhere.
  const placed = new Set(live.filter((r) => r.platform || r.bundle).map((r) => norm(r.device)));
  add('no-bundle', 'low', (n) => `${n} record${n === 1 ? ' has' : 's have'} no platform or bundle, but the device has one elsewhere`,
    'Records created from an LOA often miss their platform and bundle.', 'Select them on the Certifications page and set the platform and bundle in one go.',
    live.filter((r) => !r.platform && !r.bundle && placed.has(norm(r.device))));

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.recordIds.length - a.recordIds.length);
}

module.exports = { dataChecks };
