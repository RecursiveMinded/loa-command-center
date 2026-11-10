'use strict';
// Questions for the certification team. The website pages are only as current as their
// last update, so whenever the app cannot decide which kernel bundle an LOA belongs to,
// or a renewal's kernel is unknown, it writes the question down. The list becomes an
// email to copy and send. Every question names the kernel version, because the
// certification team needs it to answer.

const { formatDate, daysBetween, todayIso, findDates } = require('./dates');
const { kernelFit, bundleKernel, bundleNo, kernelIds } = require('./bundles');
const { isEol, restrictionOf } = require('./lifecycle');

const val = (f) => (f && typeof f === 'object' ? f.value : f) || '';
const devices = (list) => [...new Set(list.map((x) => x.device))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(', ');
const kindOf = (r) => (r.category === 'EMV L2 Contactless' ? `${r.scheme} L2 Contactless` : r.category === 'PCI PTS' ? `PCI PTS ${r.kernel_version || ''}`.trim()
  : r.category === 'TQM' ? `TQM ${/pcd|contactless/i.test(r.kernel_version || '') ? 'contactless' : 'contact'}` : r.category.replace(/^EMV /, 'EMV '));
const IN_PROGRESS = new Set(['Renewal Requested', 'Pending New LOA', 'Replacement Received']);

/**
 * records: the register; inbox: pending review items; pages: kernelPages(); bundles: allBundles();
 * brands: the card brands tracked. Expired items are asked about once a day until each one has a decision.
 * Returns { sections: [{ key, title, intro, items: [{ text, ids?, inboxId? }] }], count, subject, text, html }.
 */
function certQuestions({ records = [], inbox = [], pages = {}, bundles = [], brands = [], platformDevices = {}, asOf = todayIso(), months = 12, userName = '' } = {}) {
  const sections = [];
  const sec = (key, title, intro) => { const s = { key, title, intro, items: [] }; sections.push(s); return s; };

  // 1. LOAs waiting in the inbox that cannot be placed.
  const unread = sec('nokernel', 'LOAs where the kernel version is not stated', 'Which kernel version does each of these LOAs approve? The kernel decides which kernel bundle the LOA applies to.');
  const nobundle = sec('nobundle', 'LOAs for a kernel no bundle runs', 'These LOAs approve a kernel that none of our published kernel bundles runs. Which bundle is each one for (a new bundle, or a bundle page that needs updating)?');
  for (const it of inbox) {
    const L = it.parsed || {};
    if (L.informational || !/^EMV L2/.test(L.category || '')) continue;
    const dev = (L.products || []).map((p) => p.value).join(', ') || 'device not read';
    const what = `${dev}, ${L.scheme || 'brand?'} ${L.category === 'EMV L2 Contact' ? 'L2 Contact' : 'L2 Contactless'}${val(L.approvalNumber) ? `, approval ${val(L.approvalNumber)}` : ''}${val(L.expiryDate) ? `, expires ${formatDate(val(L.expiryDate))}` : ''} (${it.filename})`;
    const k = val(L.kernelVersion);
    if (!k) { unread.items.push({ text: what, inboxId: it.id }); continue; }
    const fit = kernelFit(pages, { category: L.category, scheme: L.scheme, kernel: k }, bundles);
    if (fit && fit.platforms.length && !fit.platforms.some((p) => p.fits.length)) {
      const runs = fit.platforms.map((p) => `${p.platform} runs ${[...new Set(p.others.map((o) => o.kernel))].join(' / ')}`).join('; ');
      nobundle.items.push({ text: `${what}: kernel ${k}. Our bundles: ${runs}.`, inboxId: it.id });
    }
  }

  // 2. Bundle kernels the app does not know yet, where records depend on them.
  const gaps = sec('bundlekernel', 'Kernel versions missing from our bundle list', 'Which kernel version does each of these bundles run for the card brand named?');
  const live = records.filter((r) => !r.archived && !isEol(r));
  const seen = new Set();
  for (const r of live) {
    if (r.category !== 'EMV L2 Contactless' || !r.platform || !r.bundle) continue;
    const key = `${r.platform}|${r.bundle}|${r.scheme}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!bundleKernel(pages, r)) gaps.items.push({ text: `${r.platform} ${r.bundle}: ${r.scheme} contactless kernel` });
  }

  // 3. Expired with no decision: renewing, waiver, or end of life?
  const RESOLVED = new Set(['Market Approved Expiration', 'No Action Required']);
  const expired = sec('expired', 'Expired approvals with no decision yet', 'Is a renewal coming for each of these, should customers request a waiver, or is it end of life?');
  const eg = new Map();
  for (const r of live) {
    if (restrictionOf(r) || IN_PROGRESS.has(r.stage) || !r.expiry_date || RESOLVED.has(r.disposition)) continue;
    const d = daysBetween(asOf, r.expiry_date);
    if (d >= 0 || d < -365) continue;
    const k = /^EMV L2/.test(r.category) ? r.kernel_version || (bundleKernel(pages, r) || {}).kernel || 'not recorded' : '';
    const g = `${r.platform}|${r.bundle}|${r.category}|${r.scheme}|${k}|${r.expiry_date}`;
    if (!eg.has(g)) eg.set(g, { r, k, list: [] });
    eg.get(g).list.push(r);
  }
  for (const { r, k, list } of [...eg.values()].sort((a, b) => b.r.expiry_date.localeCompare(a.r.expiry_date))) {
    expired.items.push({ text: `${[r.platform, r.bundle].filter(Boolean).join(' ')}: ${kindOf(r)}${k ? `, kernel ${k}` : ''}, expired ${formatDate(r.expiry_date)}: ${devices(list)}`, ids: list.map((x) => x.id) });
  }

  // 4. Renewal status for approvals expiring soon, grouped by bundle, type, kernel and date.
  const renew = sec('renewal', `Renewal status for approvals expiring in the next ${months} months`, 'Are these on your radar for renewal? If a renewal is not possible for this kernel, which kernel replaces it and when?');
  const horizon = Math.round(months * 30.5);
  const groups = new Map();
  for (const r of live) {
    if (restrictionOf(r) || IN_PROGRESS.has(r.stage) || !r.expiry_date || r.category === 'Letter of Equivalency' || RESOLVED.has(r.disposition)) continue;
    const d = daysBetween(asOf, r.expiry_date);
    if (d < 0 || d > horizon) continue;
    const k = /^EMV L2/.test(r.category) ? r.kernel_version || (bundleKernel(pages, r) || {}).kernel || 'NOT RECORDED (please confirm)' : '';
    const g = `${r.platform}|${r.bundle}|${r.category}|${r.scheme}|${k}|${r.expiry_date}`;
    if (!groups.has(g)) groups.set(g, { r, k, list: [] });
    groups.get(g).list.push(r);
  }
  const order = [...groups.values()].sort((a, b) => a.r.expiry_date.localeCompare(b.r.expiry_date) || String(a.r.platform).localeCompare(String(b.r.platform)) || bundleNo(a.r.bundle) - bundleNo(b.r.bundle));
  for (const { r, k, list } of order) {
    renew.items.push({ text: `${[r.platform, r.bundle].filter(Boolean).join(' ')}: ${kindOf(r)}${k ? `, kernel ${k}` : ''}, expires ${formatDate(r.expiry_date)}: ${devices(list)}`, ids: list.map((x) => x.id) });
  }

  // 5. Kernels a scheme mandate stops renewing: ask for the roadmap.
  const road = sec('mandate', 'Kernels that cannot be renewed (scheme mandate)', 'What is the replacement kernel for each of these, and the certification timeline?');
  const mg = new Map();
  for (const r of live) {
    if (restrictionOf(r) !== 'mandate') continue;
    const g = `${r.platform}|${r.scheme}|${r.kernel_version}`;
    if (!mg.has(g)) mg.set(g, []);
    mg.get(g).push(r);
  }
  for (const list of mg.values()) {
    const r = list[0];
    road.items.push({ text: `${r.platform || ''} ${r.scheme} kernel ${r.kernel_version || '(not recorded)'}: ${[...new Set(list.map((x) => `${x.device}${x.bundle ? ` (${x.bundle})` : ''}`))].join(', ')}`.trim(), ids: list.map((x) => x.id) });
  }

  // 6. Devices listed under a platform with no LOA yet: new devices in certification.
  const fresh = sec('newdevices', 'New devices in certification (no LOA received yet)', 'Which kernel bundle and which kernel version per card brand are these being certified on, and when do you expect each LOA?');
  for (const { platform, devices: list } of inCertification(records, platformDevices)) {
    fresh.items.push({ text: `${platform}: ${list.join(', ')}` });
  }

  const used = sections.filter((s) => s.items.length);
  const count = used.reduce((n, s) => n + s.items.length, 0);
  const subject = `Certification questions: ${count} item${count === 1 ? '' : 's'} (${formatDate(asOf)})`;
  const text = [
    'Hi team,', '',
    'I hope you are well. A few questions so we can keep our kernel bundle pages and LOA records correct. Kernel versions are included for each item.', '',
    ...used.flatMap((s, i) => [`${i + 1}. ${s.title}`, `   ${s.intro}`, ...s.items.map((x) => `   - ${x.text}`), '']),
    'Any roadmap information you can share would help too.', '', 'Thank you,', userName || '',
  ].join('\n').trim();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#101828">
<p>Hi team,</p><p>I hope you are well. A few questions so we can keep our kernel bundle pages and LOA records correct. Kernel versions are included for each item.</p>
${used.map((s, i) => `<p style="margin:12px 0 4px"><b>${i + 1}. ${esc(s.title)}</b><br><span style="color:#475467">${esc(s.intro)}</span></p><ul style="margin:0 0 8px 18px;padding:0">${s.items.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul>`).join('\n')}
<p>Any roadmap information you can share would help too.</p><p>Thank you,<br>${esc(userName)}</p></div>`;
  return { sections: used, count, subject, text, html };
}

/** Devices named under a platform (Settings > Matching) that have no LOA on any record yet. */
function inCertification(records, platformDevices = {}) {
  const key = (d) => String(d || '').toUpperCase().replace(/[\s_-]+/g, '');
  const certified = new Set(records.filter((r) => !r.archived && (r.doc_count || r.expiry_date || r.approval_number)).map((r) => key(r.device)));
  return Object.entries(platformDevices || {}).map(([platform, list]) => ({ platform, devices: (list || []).filter((d) => !certified.has(key(d))) }))
    .filter((x) => x.devices.length);
}

// ---------------------------------------------------------------- status by kernel

const STATUS = {
  incert: 'In certification: no LOA yet',
  mandate: 'Blocked by scheme mandate',
  eol: 'End of life',
  letexpire: 'Letting expire (cert team)',
  waiver: 'Expired: customer waiver',
  renewing: 'Renewal in progress',
  expired: 'Expired: no decision',
  expiring: 'Expiring within a year',
  certified: 'Certified',
  nodate: 'No expiry date',
};
const L2 = (r) => /^EMV L2/.test(r.category || '');
const kernelOf = (pages, r) => (L2(r) ? r.kernel_version || (bundleKernel(pages, r) || {}).kernel || '' : r.category === 'PCI PTS' ? r.kernel_version || '' : '');

function statusOf(r, asOf) {
  if (isEol(r)) return 'eol';
  if (!r.doc_count && !r.expiry_date && !r.approval_number) return 'incert';
  const rs = restrictionOf(r);
  if (rs === 'mandate') return 'mandate';
  if (r.disposition === 'Market Approved Expiration' || r.disposition === 'No Action Required') return 'letexpire';
  if (rs === 'waiver') return 'waiver';
  if (IN_PROGRESS.has(r.stage)) return 'renewing';
  if (!r.expiry_date) return 'nodate';
  const d = daysBetween(asOf, r.expiry_date);
  if (d < 0) return 'expired';
  return d <= 365 ? 'expiring' : 'certified';
}

/**
 * Every live approval's certification status, grouped by platform, bundle, type, brand,
 * kernel and expiry, so the kernel version leads. Returns { statuses, rows, counts }.
 */
function certStatus({ records = [], pages = {}, platformDevices = {}, asOf = todayIso() } = {}) {
  const groups = new Map();
  for (const r of records) {
    if (r.archived) continue;
    const k = kernelOf(pages, r);
    const st = statusOf(r, asOf);
    const g = `${r.platform}|${r.bundle}|${r.category}|${r.scheme}|${k}|${r.expiry_date}|${st}`;
    if (!groups.has(g)) groups.set(g, { platform: r.platform || '', bundle: r.bundle || '', category: r.category, scheme: r.scheme || '', kind: kindOf(r), kernel: k, kernelRecorded: !!r.kernel_version || !L2(r), expiry: r.expiry_date || '', days: r.expiry_date ? daysBetween(asOf, r.expiry_date) : null, status: st, statusText: STATUS[st], list: [] });
    groups.get(g).list.push(r);
  }
  const rank = Object.keys(STATUS);
  const rows = [...groups.values()].map(({ list, ...g }) => ({ ...g, devices: devices(list), ids: list.map((x) => x.id), note: list.map((x) => x.notes).find((n) => /cert team/i.test(n || '')) || '' }))
    .sort((a, b) => rank.indexOf(a.status) - rank.indexOf(b.status) || String(a.expiry).localeCompare(String(b.expiry)) || String(a.platform).localeCompare(String(b.platform)) || bundleNo(a.bundle) - bundleNo(b.bundle));
  const has = new Set(records.filter((r) => !r.archived).map((r) => String(r.device).toUpperCase()));
  for (const { platform, devices: all } of inCertification(records, platformDevices)) {
    const list = all.filter((d) => !has.has(String(d).toUpperCase()));
    if (list.length) rows.unshift({ platform, bundle: '', category: '', scheme: '', kind: 'All approvals', kernel: '', kernelRecorded: true, expiry: '', days: null, status: 'incert', statusText: STATUS.incert, devices: list.join(', '), ids: [], count: list.length, note: '' });
  }
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + (r.count || r.ids.length);
  return { statuses: STATUS, rows, counts };
}

// ---------------------------------------------------------------- the cert team's reply

const DECISIONS = {
  mandate: { label: 'Cannot be renewed (scheme mandate)', patch: { restriction: 'mandate' } },
  eol: { label: 'End of life: no longer certified', patch: { disposition: 'Market Approved Expiration' }, eol: true },
  letexpire: { label: 'Letting it expire', patch: { disposition: 'Market Approved Expiration' } },
  waiver: { label: 'Customers request a waiver', patch: { restriction: 'waiver' } },
  renew: { label: 'Renewal coming', patch: { disposition: 'Renew', stage: 'Renewal Requested' } },
};
// Checked in this order: the first that matches wins ("not renewing" before "renewing").
const RULES = [
  ['mandate', /\bmandate|cannot be renewed|can(?:'|no)t be renewed|not (?:able|eligible) to (?:be )?renew|new kernel (?:and|\+) (?:new )?certification/i],
  ['eol', /\bend[ -]of[ -]life\b|\bEOL\b|no longer (?:be(?:ing)? )?certif|discontinu|not (?:be(?:ing)? )?(?:re)?certif|retir(?:ed|ing)\b/i],
  ['letexpire', /let(?:ting)? (?:it |them |this |these )?expire|allow(?:ed|ing)? (?:it |them )?to expire|(?:not|won'?t|will not|no plans? to|don'?t plan to) (?:be )?renew|no renewal|not (?:be(?:ing)? )?renewed/i],
  ['waiver', /\bwaiver|restricted (?:renewal|extension)|request (?:an |their own )?extension/i],
  ['renew', /\brenew(?:al|ing|ed)?\b|on (?:our|the) radar|\bin progress\b|submitted|\bscheduled\b|\bplanned\b|\byes\b/i],
];
const BRAND_WORDS = { Visa: /\bvisa\b/i, Mastercard: /\bmaster ?card|\bMC\b/i, Amex: /\bamex|american express/i, Discover: /\bdiscover|\bDPAS\b/i, UnionPay: /\bunion ?pay|\bUPI\b/i, JCB: /\bJCB\b/i, Interac: /\binterac\b/i };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A function that matches one line of text to the approvals it talks about, by kernel
 * version, device names, platform, bundle and brand. Returns { list, kernel, devices } or null.
 */
function matcher(records = [], pages = {}) {
  const live = records.filter((r) => !r.archived);
  const names = [...new Set(live.map((r) => r.device).filter((d) => d && d.length >= 3))].sort((a, b) => b.length - a.length);
  const platforms = [...new Set(live.map((r) => r.platform).filter(Boolean))];
  return (line) => {
    const found = names.filter((n) => new RegExp(`(^|[^A-Za-z0-9])${esc(n)}(?![A-Za-z0-9]|-CL)`, 'i').test(line));
    const nums = kernelIds(line);
    const brands = Object.keys(BRAND_WORDS).filter((b) => BRAND_WORDS[b].test(line));
    const plats = platforms.filter((p) => new RegExp(`\\b${esc(p)}\\b`, 'i').test(line));
    const bundles = (line.match(/bundle\s*(\d+)/gi) || []).map((b) => b.replace(/\D/g, ''));
    let list = live.filter((r) => {
      if (plats.length && r.platform && !plats.includes(r.platform)) return false;
      if (bundles.length && !bundles.includes(String(bundleNo(r.bundle)))) return false;
      if (brands.length && !brands.includes(r.scheme)) return false;
      if (found.length && !found.includes(r.device)) return false;
      return true;
    });
    const byKernel = list.filter((r) => { const k = kernelIds(kernelOf(pages, r)); return k.length && k.some((x) => nums.includes(x)); });
    if (byKernel.length) list = byKernel;
    else if (!found.length && !(plats.length && bundles.length && brands.length)) return null; // too little to go on
    if (/\bL2\b|contactless|kernel/i.test(line) && list.some(L2)) list = list.filter(L2);
    return list.length ? { list, kernel: byKernel.length ? kernelOf(pages, byKernel[0]) : '', devices: found } : null;
  };
}

/**
 * Read the certifications team's reply. Each line (or each quoted item followed by their
 * answer) is matched to records by kernel version, device names, platform, bundle and brand,
 * and turned into a decision to review. Nothing is changed here.
 * Returns { items: [{ line, decision, label, ids, devices, summary, replacement, date }], unread: [line] }.
 */
function readCertReply({ text = '', records = [], pages = {}, asOf = todayIso() } = {}) {
  const match = matcher(records, pages);
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/^[\s>*\-•\d.)]+/, '').trim()).filter((l) => l.length > 2);
  const items = [];
  const unread = [];
  let last = null; // a quoted item waiting for its answer on the next line
  for (const line of lines) {
    if (/^(hi|hello|thanks|thank you|regards|best|cheers|from:|sent:|to:|subject:|cc:)\b/i.test(line)) continue;
    const rule = RULES.find(([, re]) => re.test(line));
    const m = match(line);
    if (m && !rule) { last = m; continue; }
    const hit = m || last;
    last = null;
    if (!rule) continue;
    if (!hit) { unread.push(line); continue; }
    const key = rule[0];
    const repl = (line.match(/(?:replace(?:d|ment)?|new|successor|migrat\w*|move\w*)\s+(?:kernel\s+)?(?:is\s+|by\s+|with\s+|to\s+)?(?:kernel\s+)?v?(\d+(?:\.\d+)+|\d{4,})/i) || [])[1] || '';
    const dates = findDates(line);
    const r = hit.list[0];
    items.push({
      line, decision: key, label: DECISIONS[key].label, ids: hit.list.map((x) => x.id), devices: devices(hit.list),
      summary: `${[r.platform, r.bundle].filter(Boolean).join(' ')}: ${kindOf(r)}${hit.kernel ? `, kernel ${hit.kernel}` : ''}`.trim(),
      replacement: repl, date: dates.length ? dates[dates.length - 1].iso : '',
    });
  }
  return { items, unread, decisions: Object.fromEntries(Object.entries(DECISIONS).map(([k, v]) => [k, v.label])) };
}

/** The record changes for one decision, with a dated note quoting the team. */
function decisionPatch(item, record, asOf = todayIso(), who = 'cert team') {
  const d = DECISIONS[item.decision];
  if (!d) return null;
  const extra = [item.replacement && `replacement kernel ${item.replacement}`, item.date && `date ${formatDate(item.date)}`].filter(Boolean).join(', ');
  const note = `${formatDate(asOf)} ${who}: ${d.label}${extra ? ` (${extra})` : ''}. "${String(item.line).slice(0, 200)}"`;
  const p = { ...d.patch, notes: [note, record.notes].filter(Boolean).join('\n') };
  if (d.eol && !record.eol) p.eol = `${who.charAt(0).toUpperCase()}${who.slice(1)} ${formatDate(asOf)}: no longer certified`;
  if (item.decision !== 'renew' && IN_PROGRESS.has(record.stage)) p.stage = '';
  return p;
}

module.exports = { inCertification, certQuestions, certStatus, readCertReply, decisionPatch, matcher, statusOf, kindOf, kernelOf, RULES, BRAND_WORDS, STATUS, DECISIONS };
