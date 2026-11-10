'use strict';
// Emails from team members, read the way a colleague would read them. Each statement is
// matched to the approvals it talks about (kernel version, device, platform, bundle, brand)
// and turned into a decision to confirm. What the app cannot settle becomes a question for
// the person, and what the sender left out becomes a follow-up reply to send back.
// Nothing changes until the person applies a decision.

const crypto = require('crypto');
const { formatDate, todayIso, findDates } = require('./dates');
const { kernelIds } = require('./bundles');
const { isEol } = require('./lifecycle');
const { matcher, statusOf, kindOf, kernelOf, RULES, DECISIONS, STATUS } = require('./questions');

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
const L2 = (r) => /^EMV L2/.test(r.category || '');
const sortNames = (list) => [...new Set(list)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const where = (r) => [r.platform, r.bundle].filter(Boolean).join(' ');
const firstName = (from) => {
  const s = String(from || '').replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  if (!s) return '';
  if (/@/.test(s)) return s.split('@')[0].split(/[._-]/)[0].replace(/^./, (c) => c.toUpperCase());
  const parts = s.includes(',') ? s.split(',').map((x) => x.trim()).reverse() : s.split(/\s+/);
  return parts[0] || '';
};

/** The new part of an email: earlier messages in the thread and the signature are cut off. */
function splitEmail(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^-{2,}\s*(original message|forwarded message)/i.test(l) || /^_{6,}$/.test(l) || /^On .{6,200}wrote:$/i.test(l)
      || (i > 0 && /^From:\s/i.test(l) && lines.slice(i + 1, i + 6).some((x) => /^(Sent|Date|To|Subject):/i.test(x.trim())))) { end = i; break; }
  }
  let body = lines.slice(0, end);
  const so = body.findIndex((l, i) => i > 0 && /^(thanks|thank you|many thanks|thx|regards|best regards|kind regards|warm regards|best|cheers|sincerely|br)[,.!]?\s*$/i.test(l.trim()));
  if (so > 0) body = body.slice(0, so);
  return { body: body.join('\n').trim(), history: lines.slice(end).join('\n').trim() };
}

/** Sentences of the new part, each marked as quoted (">" lines: the person's own words) or not. */
function sentences(body) {
  const out = [];
  for (const raw of body.split('\n')) {
    const quoted = /^\s*>/.test(raw);
    const line = raw.replace(/^[\s>]+/, '').replace(/^[*\-•]\s*|^\d+[.)]\s+/, '').trim();
    if (line.length < 3) continue;
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z(])/)) {
      const t = s.trim();
      if (t.length < 3) continue;
      if (/^(hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^.?!]{0,30}[,!.]?$/i.test(t)) continue;
      if (/^(from|sent|to|cc|subject|date):/i.test(t)) continue;
      out.push({ text: t, quoted, question: !quoted && /\?\s*$/.test(t) });
    }
  }
  return out;
}

// Device-like names: Lane/3000, Desk/5000-CL2, DX8000, RX5000. Words that look like that but are not devices are left out.
const DEVICE_RE = /\b(?:[A-Z][A-Za-z]{1,10}\/\d{3,5}[A-Za-z]?|[A-Z]{1,4}\d{3,5}[A-Z]?)(?:[- ]?CL\d)?\b/g;
const NOT_DEVICE = /^(ISO|EMV|PCI|PTS|TQM|ARC|UPP|DPAS|UPI|JCB|CL|CT|IFM|PCD|RFC|ID|PO|Q[1-4]|FY|V)\d/i;
// Team prose says "letting the Desk/3200 Discover expire": the device sits between the words.
const TEAM_RULES = RULES.map(([k, re]) => (k === 'letexpire' ? [k, new RegExp(`${re.source}|\\blet(?:ting|s)?\\b[^.]{0,60}\\bexpire`, 'i')] : [k, re]));
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** The last date a sentence names, including "March 2027" (read as the first of the month). */
function dateIn(text) {
  const d = findDates(text);
  if (d.length) return { iso: d[d.length - 1].iso, label: formatDate(d[d.length - 1].iso) };
  const m = [...String(text).matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(20\d\d)\b/gi)].pop();
  if (!m) return { iso: '', label: '' };
  const n = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  return { iso: `${m[2]}-${String(n + 1).padStart(2, '0')}-01`, label: `${new Date(Date.UTC(2000, n, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${m[2]}` };
}
/** Whether a sentence names a kernel version (device model numbers and years are not kernels). */
function kernelSaidIn(text) {
  let t = String(text).replace(DEVICE_RE, ' ').replace(/\b(19|20)\d\d\b/g, ' ');
  for (const d of findDates(t)) t = t.replace(d.raw, ' ');
  return kernelIds(t).length > 0;
}
const PRONOUN = /\b(it|its|them|this|these|that|those|they|both|all of them)\b/i;
const devKey = (s) => String(s || '').toUpperCase().replace(/[- ]?CL\d+$/, '').replace(/[^A-Z0-9]/g, '');

/**
 * Read one team email against the register.
 * mail: { id, from, subject, date, text, attachments: [names], answers: { key: value }, applied: [keys], ai }
 * Returns { summary, items, forYou, theyAsked, followUp, counts }.
 */
function readTeamEmail(mail, { records = [], pages = {}, aliases = {}, userName = '', asOf = todayIso() } = {}) {
  const answers = mail.answers || {};
  const applied = new Set(mail.applied || []);
  const live = records.filter((r) => !r.archived);
  const byId = new Map(live.map((r) => [r.id, r]));
  const known = new Map();
  for (const r of live) if (r.device) known.set(devKey(r.device), r.device);
  for (const [a, d] of Object.entries(aliases || {})) if (d) known.set(devKey(a), d);

  let { body } = splitEmail(mail.text);
  // Device names the register does not know: answered ones are read as the device the person picked.
  const unknown = [];
  for (const m of body.match(DEVICE_RE) || []) {
    if (NOT_DEVICE.test(m) || known.has(devKey(m)) || unknown.includes(m)) continue;
    if (live.some((r) => devKey(r.device).startsWith(devKey(m)) || devKey(m).startsWith(devKey(r.device)))) continue;
    unknown.push(m);
  }
  for (const u of unknown) {
    const a = answers[`device:${devKey(u)}`];
    if (a && a !== 'new' && known.has(devKey(a))) body = body.split(u).join(known.get(devKey(a)));
  }

  const match = matcher(records, pages);
  const items = [];
  const unread = [];
  const asked = [];
  let last = null;
  let lastQuoted = false;
  const add = (text, hit, rule, extra = {}) => {
    const key = `item:${hash(text)}`;
    const scope = answers[`scope:${hash(text)}`];
    let list = hit.list;
    const groups = new Map();
    for (const r of list) {
      const g = `${where(r) || 'No bundle'}${L2(r) ? ` · kernel ${kernelOf(pages, r) || 'not known'}` : ''}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r.id);
    }
    if (scope && scope !== 'all' && groups.has(scope)) list = list.filter((r) => groups.get(scope).includes(r.id));
    const r = list[0];
    const decision = rule[0];
    const conflict = decision === 'renew' && list.some((x) => isEol(x) || x.disposition === 'Market Approved Expiration') ? 'Some of these are marked end of life or letting expire.'
      : decision !== 'renew' && list.some((x) => x.stage === 'Renewal Requested') ? 'A renewal is recorded as requested for some of these.' : '';
    items.push({
      key, line: text, decision, label: DECISIONS[decision].label, ids: list.map((x) => x.id),
      devices: sortNames(list.map((x) => x.device)).join(', '),
      summary: `${list.some(where) ? `${sortNames(list.map(where).filter(Boolean)).join(', ')}: ` : ''}${kindOf(r)}${hit.kernel ? `, kernel ${hit.kernel}` : ''}`,
      kernels: sortNames(list.filter(L2).map((x) => kernelOf(pages, x)).filter(Boolean)),
      kernelSaid: kernelSaidIn(text),
      replacement: (text.match(/(?:replace(?:d|ment)?|new|successor|migrat\w*|move\w*)\s+(?:kernel\s+)?(?:is\s+|by\s+|with\s+|to\s+)?(?:kernel\s+)?v?(\d+(?:\.\d+)+|\d{4,})/i) || [])[1] || '',
      date: dateIn(text).iso, dateLabel: dateIn(text).label,
      groups: groups.size > 1 && !scope ? [...groups.entries()].map(([label, ids]) => ({ label, ids })) : [],
      conflict, applied: applied.has(key), ...extra,
    });
  };

  for (const s of sentences(body)) {
    if (s.question) { asked.push(s.text); continue; }
    const rule = s.quoted ? null : TEAM_RULES.find(([, re]) => re.test(s.text));
    const m = match(s.text);
    if (m && !rule) { last = m; lastQuoted = s.quoted; continue; }
    // A sentence without its own device only carries on from the one before when it points back ("it", "them") or is short.
    const carries = last && !unknown.some((u) => s.text.includes(u)) && (lastQuoted || PRONOUN.test(s.text) || s.text.split(/\s+/).length <= 6);
    const hit = m || (carries ? last : null);
    last = null;
    if (!rule) continue;
    if (!hit) { unread.push(s.text); continue; }
    add(s.text, hit, rule);
  }

  // Questions for the person: what only they can settle.
  const forYou = [];
  for (const u of unknown) {
    const key = `device:${devKey(u)}`;
    forYou.push({ key, kind: 'device', text: `"${u}" is not a device in your register. Is it another name for a device you track, or a new device?`,
      options: [{ value: 'new', label: 'A new device' }], placeholder: 'Device it means, e.g. Lane/3000', answer: answers[key] || '' });
  }
  for (const line of unread) {
    const key = `which:${hash(line)}`;
    const a = answers[key];
    if (a) {
      const m = match(`${a} ${line}`);
      const rule = TEAM_RULES.find(([, re]) => re.test(line));
      if (m && rule) { add(line, m, rule, { fromAnswer: a }); continue; }
    }
    forYou.push({ key, kind: 'which', text: `${firstName(mail.from) || 'They'} wrote: "${line}" Which approvals is this about?`, placeholder: 'e.g. Lane/3000 Visa, or ARC Bundle 5 Discover 0203',
      answer: a || '', unmatched: !!a, line });
  }
  for (const it of items) {
    if (it.groups.length) {
      forYou.push({ key: `scope:${hash(it.line)}`, kind: 'scope', text: `"${it.line}" matches ${it.ids.length} approvals in ${it.groups.length} bundles or kernels. Which does it apply to?`,
        options: [{ value: 'all', label: 'All of them' }, ...it.groups.map((g) => ({ value: g.label, label: `${g.label} (${g.ids.length})` }))], answer: '' });
    }
    if (it.conflict) forYou.push({ key: `conflict:${hash(it.line)}`, kind: 'conflict', text: `${it.summary}: "${it.line}" ${it.conflict} Left unticked until you tick it.`, info: true });
  }
  for (const q of ((mail.ai && mail.ai.questionsForYou) || [])) {
    const key = `ai:${hash(q)}`;
    forYou.push({ key, kind: 'ai', text: q, placeholder: 'Your answer (noted on the email)', answer: answers[key] || '' });
  }

  // What they asked: an answer suggested from the register, for the person to check.
  const theyAsked = asked.map((q) => {
    const key = `asked:${hash(q)}`;
    const m = match(q);
    let suggested = '';
    if (m) {
      const groups = new Map();
      for (const r of m.list) {
        const k = kernelOf(pages, r);
        const g = `${where(r) ? `${where(r)} ` : ''}${kindOf(r)}${k ? `, kernel ${k}` : ''}: ${r.expiry_date ? `expires ${formatDate(r.expiry_date)}` : 'no expiry date recorded'} (${STATUS[statusOf(r, asOf)] || 'status unknown'})`;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(r.device);
      }
      suggested = [...groups.entries()].slice(0, 6).map(([g, devs]) => `${sortNames(devs).join(', ')}: ${g}`).join('\n');
    }
    return { key, text: q, suggested, answer: answers[key] != null ? answers[key] : suggested };
  });

  // The follow-up reply: what the sender left out.
  const asks = [];
  for (const it of items) {
    if (it.decision === 'renew') {
      if (!it.date) asks.push(`${it.summary} (${it.devices}): when do you expect the renewed LOA?`);
      if (!it.kernelSaid && it.kernels.length === 1) {
        const at = it.summary.includes(':') ? it.summary.split(':')[0] : '';
        asks.push(`${it.summary}: can you confirm the renewal is on kernel ${it.kernels[0]}?${at ? ` ${at} ${at.includes(',') ? 'run' : 'runs'} that kernel, so an LOA for another kernel would not apply there.` : ''}`);
      }
      else if (!it.kernelSaid && it.kernels.length > 1) asks.push(`${it.summary} (${it.devices}): which kernel version is the renewal on? These approvals run ${it.kernels.join(' and ')}.`);
      else if (!it.kernels.length && it.ids.some((id) => byId.get(id) && L2(byId.get(id)))) asks.push(`${it.summary} (${it.devices}): which kernel version is the renewal on?`);
    }
    if ((it.decision === 'eol' || it.decision === 'letexpire') && !it.replacement) asks.push(`${it.summary} (${it.devices}): is there a newer device or hardware version customers should move to?`);
    if (it.decision === 'mandate' && !it.replacement) asks.push(`${it.summary}: which kernel replaces it, and when is it expected?`);
  }
  for (const f of forYou) {
    if (f.kind === 'which' && !f.answer) asks.push(`You wrote: "${f.line}" Which device, bundle and kernel version is that for?`);
    if (f.kind === 'device' && f.answer === 'new') {
      const name = f.text.match(/^"([^"]+)"/)[1];
      asks.push(`${name}: which platform and kernel bundle will it be in, and is its LOA ready?`);
    }
  }
  if (/\b(attached|enclosed|attaching)\b/i.test(body) && !(mail.attachments || []).length) asks.push('You mentioned an attachment, but nothing came through. Could you send it again?');
  for (const a of ((mail.ai && mail.ai.followUps) || [])) asks.push(a);
  const replies = theyAsked.filter((q) => String(q.answer || '').trim());
  const name = firstName(mail.from);
  const noted = items.filter((it) => it.ids.length);
  const lines = [`Hi${name ? ` ${name}` : ''},`, '', 'Thanks for the update.'];
  if (noted.length) lines.push('', 'I have noted:', ...noted.map((it) => `- ${it.summary} (${it.devices}): ${it.label.toLowerCase()}${it.dateLabel ? `, ${it.dateLabel}` : ''}`));
  if (replies.length) lines.push('', 'To your questions:', ...replies.map((q) => `- ${q.text}\n  ${String(q.answer).trim().replace(/\n/g, '\n  ')}`));
  if (asks.length) lines.push('', `A few follow-up question${asks.length === 1 ? '' : 's'}:`, ...[...new Set(asks)].map((a) => `- ${a}`));
  lines.push('', 'Thanks,', userName || '');
  const followUp = {
    to: String(mail.fromAddress || ''),
    subject: /^re:/i.test(mail.subject || '') ? mail.subject : `RE: ${mail.subject || 'Certification update'}`,
    text: lines.join('\n').trim(), count: new Set(asks).size,
  };

  const open = forYou.filter((f) => !f.info && !f.answer).length;
  const byDecision = {};
  for (const it of items) byDecision[it.label] = (byDecision[it.label] || 0) + 1;
  const summary = (mail.ai && mail.ai.summary) || [
    items.length ? `${items.length} update${items.length === 1 ? '' : 's'} matched to approvals (${Object.entries(byDecision).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(', ')})` : 'No updates matched to approvals',
    asked.length ? `${asked.length} question${asked.length === 1 ? '' : 's'} for you to answer` : '',
    open ? `${open} thing${open === 1 ? '' : 's'} I need you to settle` : '',
    (mail.attachments || []).length ? `${mail.attachments.length} attachment${mail.attachments.length === 1 ? '' : 's'} read in the inbox` : '',
  ].filter(Boolean).join('. ') + '.';
  return { summary, items, forYou, theyAsked, followUp, counts: { items: items.length, open, asked: asked.length, followUps: followUp.count } };
}

/** The stored copy of a dropped or pasted email. */
function teamMailEntry({ from = '', fromAddress = '', subject = '', date = '', text = '', attachments = [], filename = '' } = {}) {
  const addr = fromAddress || (String(from).match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [''])[0];
  return {
    id: hash(`${from}|${subject}|${date}|${String(text).slice(0, 2000)}`),
    from: String(from).replace(/<[^>]*>/g, '').trim() || addr, fromAddress: addr, subject: String(subject), date: date ? String(date) : '',
    text: String(text).slice(0, 60000), attachments: (attachments || []).map(String), filename: String(filename || ''),
    addedAt: new Date().toISOString(), status: 'open', answers: {}, applied: [],
  };
}

/** Whether pasted or dropped text reads like a message from a person (not a letter or notice). */
function looksLikeMessage(text) {
  const t = String(text || '');
  return /^\s*(hi|hello|hey|dear|good (?:morning|afternoon))\b/im.test(t) || /^(from|sent|subject):/im.test(t) || /\b(regards|thanks|thank you|cheers)\b[,.!]?\s*$/im.test(t);
}

module.exports = { readTeamEmail, teamMailEntry, splitEmail, sentences, looksLikeMessage, firstName };
