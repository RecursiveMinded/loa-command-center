'use strict';
// The decision engine: a deterministic, explainable "project manager".
// It looks at every record and produces a prioritized action plan. Each
// action says why it exists, so a reviewer can trust (or challenge) it.
// The optional local LLM only rephrases and answers questions on top of this.

const { todayIso, daysBetween, addDays, formatDate } = require('./dates');
const { daysRemaining, effectiveStage, windowFor, health, isEol, WINDOWS } = require('./lifecycle');

const IN_PROGRESS = new Set(['Renewal Requested', 'Pending New LOA', 'Replacement Received']);
const RESOLVED_EXPIRY = new Set(['Market Approved Expiration', 'Retired']);
const PRIORITY_LABEL = { 1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low' };

function label(r) {
  return [r.platform, r.device, r.scheme && r.scheme !== 'Other' ? r.scheme : '', r.category].filter(Boolean).join(' · ');
}

function analyze(records, { settings = {}, asOf = todayIso(), tasks = {}, inboxPending = 0, replacements = [], norm } = {}) {
  const lead = settings.leadTimes || {};
  const live = records.filter((r) => !r.archived);
  const all = live.map((r) => {
    const days = daysRemaining(r, asOf);
    return { r, days, stage: effectiveStage(r, asOf), win: windowFor(days), health: health(r, asOf), eol: isEol(r) };
  });
  // Accepted expirations / end of life raise no actions.
  const rows = all.filter((x) => !x.eol);

  const actions = [];
  const add = (a) => actions.push({ status: 'open', recordIds: [], ...a, priorityLabel: PRIORITY_LABEL[a.priority] });

  // ---- Waves: several records of one brand expiring together.
  const waveMembers = new Set();
  const waveGroups = {};
  for (const x of rows) {
    if (x.days == null || x.days < 0 || x.days > 365) continue;
    if (IN_PROGRESS.has(x.stage) || RESOLVED_EXPIRY.has(x.stage) || x.r.disposition === 'Market Approved Expiration') continue;
    const k = `${x.r.scheme}|${x.r.category}|${x.r.expiry_date}`;
    (waveGroups[k] = waveGroups[k] || []).push(x);
  }
  for (const [k, list] of Object.entries(waveGroups)) {
    if (list.length < 3) continue;
    const [scheme, category, date] = k.split('|');
    const days = list[0].days;
    const leadDays = lead[category] ?? 90;
    const due = days <= leadDays ? asOf : addDays(date, -leadDays);
    list.forEach((x) => waveMembers.add(x.r.id));
    add({
      key: `wave:${k}`,
      kind: 'wave',
      priority: days <= 60 ? 1 : days <= leadDays ? 2 : 3,
      title: `${scheme} renewal wave: ${list.length} devices expire ${formatDate(date)}`,
      why: `${list.length} ${category} approvals share one expiry date. One batch renewal request to ${scheme} covers them all. Renewal work should start ${leadDays} days ahead.`,
      due,
      days,
      recordIds: list.map((x) => x.r.id),
      devices: list.map((x) => x.r.device),
    });
  }

  const undecidedExpired = (x) => x.days != null && x.days < 0 && !RESOLVED_EXPIRY.has(x.stage)
    && !['Market Approved Expiration', 'No Action Required'].includes(x.r.disposition);
  // Long-expired approvals are usually legacy entries: one grouped clean-up action.
  const legacy = rows.filter((x) => undecidedExpired(x) && x.days < -365);
  if (legacy.length) {
    add({
      key: `legacy:${legacy.length}`, kind: 'expired', priority: 2,
      title: `Clean up ${pl(legacy.length, 'approval')} expired more than a year ago`,
      why: 'They still count as open risks. Mark each as Retired or Market Approved Expiration if it is no longer needed, or renew it.',
      due: asOf, recordIds: legacy.map((x) => x.r.id), filter: { window: 'expired' },
    });
  }

  // Several approvals of one brand that lapsed on the same day: one decision.
  const expiredGroups = {};
  for (const x of rows) {
    if (!undecidedExpired(x) || x.days < -365) continue;
    const k = `${x.r.scheme}|${x.r.category}|${x.r.expiry_date}`;
    (expiredGroups[k] = expiredGroups[k] || []).push(x);
  }
  const groupedExpired = new Set();
  for (const [k, list] of Object.entries(expiredGroups)) {
    if (list.length < 3) continue;
    const [scheme, category, date] = k.split('|');
    list.forEach((x) => groupedExpired.add(x.r.id));
    add({
      key: `expiredgroup:${k}`, kind: 'expired', priority: 1,
      title: `${list.length} ${scheme} ${category} approvals expired ${formatDate(date)}`,
      why: `They lapsed together ${Math.abs(list[0].days)} days ago and still count as open risks. Decide for the group: request one batch renewal from ${scheme}, or mark the ones no longer sold as Retired or Market Approved Expiration.`,
      due: asOf, days: list[0].days, recordIds: list.map((x) => x.r.id),
    });
  }

  for (const x of rows) {
    const { r, days, stage } = x;
    const name = label(r);
    const leadDays = lead[r.category] ?? 90;

    if (undecidedExpired(x) && (days < -365 || groupedExpired.has(r.id))) continue;
    // Expired and nobody has decided what to do.
    if (undecidedExpired(x)) {
      add({
        key: `expired:${r.id}:${r.expiry_date}`, kind: 'expired', priority: 1,
        title: `Expired ${Math.abs(days)} days ago: ${name}`,
        why: `The approval lapsed on ${formatDate(r.expiry_date)}. Decide: renew, replace, or record a market-approved expiration so it stops counting as a risk.`,
        due: asOf, days, recordIds: [r.id],
      });
      continue;
    }
    if (days == null) continue;

    // Renewal should be underway.
    if (days >= 0 && days <= leadDays && !IN_PROGRESS.has(stage) && !RESOLVED_EXPIRY.has(stage)
      && stage !== 'Restricted Extension' && r.disposition !== 'Market Approved Expiration' && r.disposition !== 'No Action Required') {
      if (!waveMembers.has(r.id)) {
        add({
          key: `renew:${r.id}:${r.expiry_date}`, kind: 'renewal',
          priority: days <= 30 ? 1 : days <= 90 ? 2 : 3,
          title: `Start renewal: ${name} expires in ${days} days`,
          why: `${r.category} renewals need about ${leadDays} days. Expiry is ${formatDate(r.expiry_date)} and no renewal has been requested yet.`,
          due: asOf, days, recordIds: [r.id],
        });
      }
    }

    // Restricted / one-time extension already used: this is the final date.
    if ((r.restricted || r.extension_used) && days >= 0 && days <= 365 && r.disposition !== 'Market Approved Expiration') {
      add({
        key: `final:${r.id}:${r.expiry_date}`, kind: 'restricted', priority: days <= 180 ? 2 : 3,
        title: `Final expiry, no further extension: ${name}`,
        why: `This approval is a restricted renewal or its one-time extension is used. On ${formatDate(r.expiry_date)} it ends for good, so plan a replacement product/kernel or approve a market sunset.`,
        due: addDays(r.expiry_date, -180) < asOf ? asOf : addDays(r.expiry_date, -180), days, recordIds: [r.id],
      });
    }

    // Renewal requested but the clock is running out.
    if (IN_PROGRESS.has(stage) && stage !== 'Replacement Received' && days >= 0 && days <= 60) {
      add({
        key: `chase:${r.id}:${r.expiry_date}`, kind: 'chase', priority: days <= 30 ? 1 : 2,
        title: `Chase renewal: ${name} (${stage}), ${days} days left`,
        why: 'A renewal is in progress but no new LOA has arrived. Follow up with the lab or brand so coverage does not lapse.',
        due: asOf, days, recordIds: [r.id],
      });
    }

    // Overdue next action set by a person.
    if (r.next_action && r.next_action_date && r.next_action_date < asOf) {
      add({
        key: `next:${r.id}:${r.next_action_date}`, kind: 'followup', priority: 2,
        title: `Overdue: ${r.next_action} (${name})`,
        why: `Planned for ${formatDate(r.next_action_date)}${r.owner ? `, owner ${r.owner}` : ''}.`,
        due: r.next_action_date, days, recordIds: [r.id],
      });
    }

    // Published (portal) value out of date.
    if (r.portal_status === 'Change Needed' || (r.portal_date && r.expiry_date && r.portal_date !== r.expiry_date && !['Change Requested'].includes(r.portal_status))) {
      add({
        key: `portal:${r.id}:${r.expiry_date}`, kind: 'portal', priority: 3,
        title: `Update published date: ${name}`,
        why: `The published value${r.portal_date ? ` (${formatDate(r.portal_date)})` : ''} does not match the verified expiry ${formatDate(r.expiry_date)}.`,
        due: asOf, days, recordIds: [r.id], group: 'portal',
      });
    }
  }

  // Replacement approvals now in force.
  for (const rep of replacements) {
    if (rep.issue_date && rep.issue_date <= asOf) {
      const r = live.find((x) => x.id === rep.record_id);
      if (!r || isEol(r)) continue;
      add({
        key: `activate:${rep.id}`, kind: 'replacement', priority: 2,
        title: `Activate replacement LOA: ${label(r)}`,
        why: `Replacement ${rep.approval_number || ''} became effective ${formatDate(rep.issue_date)} (valid to ${formatDate(rep.expiry_date)}). Make it the current approval.`,
        due: rep.issue_date, recordIds: [r.id], approvalId: rep.id,
      });
    }
  }

  dependencyActions(all, { add, asOf, norm: norm || defaultNorm });
  radarActions(rows, { add, asOf });

  // Grouped data-quality actions.
  const within = rows.filter((x) => x.days != null && x.days >= -365 && x.days <= 365);
  const noOwner = within.filter((x) => !x.r.owner);
  if (noOwner.length) {
    add({ key: `owners:${noOwner.length}`, kind: 'data', priority: 2, title: `Assign owners to ${pl(noOwner.length, 'record')} due or expired within a year`, why: 'Every approval near expiry needs one accountable person.', due: asOf, recordIds: noOwner.map((x) => x.r.id), filter: { ownership: 'unassigned', window: 'year' } });
  }
  const noDisp = within.filter((x) => !x.r.disposition || x.r.disposition === 'Decision Required');
  if (noDisp.length) {
    add({ key: `dispositions:${noDisp.length}`, kind: 'data', priority: 3, title: `Record a decision for ${pl(noDisp.length, 'record')} due or expired within a year`, why: 'Renew, replace, restricted extension, or market-approved expiration. Without a decision the item stays open.', due: asOf, recordIds: noDisp.map((x) => x.r.id) });
  }
  const noDate = rows.filter((x) => x.days == null && x.r.category !== 'Letter of Equivalency');
  if (noDate.length) {
    add({ key: `dates:${noDate.length}`, kind: 'data', priority: 3, title: `Add expiry dates to ${pl(noDate.length, 'record')}`, why: 'Records without a date cannot be tracked or alerted on. Drop their LOAs in, or enter the date.', due: asOf, recordIds: noDate.map((x) => x.r.id), filter: { window: 'missing' } });
  }
  const noDoc = rows.filter((x) => x.days != null && x.days >= 0 && !x.r.doc_count);
  if (noDoc.length) {
    add({ key: `evidence:${noDoc.length}`, kind: 'evidence', priority: 4, title: `Attach LOA evidence to ${pl(noDoc.length, 'active record')}`, why: 'An approval without its signed LOA on file cannot be proven in an audit.', due: addDays(asOf, 30), recordIds: noDoc.map((x) => x.r.id), filter: { evidence: 'none' } });
  }
  if (inboxPending) {
    add({ key: `inbox:${inboxPending}`, kind: 'inbox', priority: 2, title: `Review ${inboxPending} LOA letter${inboxPending === 1 ? '' : 's'} waiting in the inbox`, why: 'Extracted LOA data is waiting for approval before it updates records.', due: asOf, recordIds: [] });
  }

  // Apply the user's done / snoozed / dismissed state.
  for (const a of actions) {
    const t = tasks[a.key];
    if (!t) continue;
    if (t.status === 'snoozed' && t.snooze_until && t.snooze_until > asOf) a.status = 'snoozed';
    else if (t.status === 'done' || t.status === 'dismissed') a.status = t.status;
    a.snoozeUntil = t.snooze_until;
    a.note = t.note;
  }

  actions.sort((a, b) => a.priority - b.priority || String(a.due || '').localeCompare(String(b.due || '')) || (a.days ?? 9999) - (b.days ?? 9999));

  return { asOf, actions, summary: summarize(all, records, inboxPending) };
}

function pl(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

const defaultNorm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const coversOf = (r) => String(r.covers || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

// What each approval rests on. An L2 kernel approval is anchored to the L1
// approval of the same interface; Mastercard L2 also needs a valid TQM; and
// without PCI PTS no new units can be built or injected with keys.
const DEPENDS = [
  { needs: 'EMV L1 Contactless', of: (r) => r.category === 'EMV L2 Contactless', what: 'L1 Contactless' },
  { needs: 'EMV L1 Contact', of: (r) => r.category === 'EMV L2 Contact', what: 'L1 Contact' },
  { needs: 'TQM', of: (r) => r.category === 'EMV L2 Contactless' && r.scheme === 'Mastercard', what: 'TQM' },
];

/**
 * Dependency warnings: an approval whose foundation has expired, expires
 * within a year, or was accepted as end of life is at risk even though its own
 * date is fine. One action per foundation approval.
 */
function dependencyActions(all, { add, asOf, norm }) {
  const byDevice = new Map();
  const put = (k, x) => { if (!byDevice.has(k)) byDevice.set(k, []); byDevice.get(k).push(x); };
  for (const x of all) {
    put(norm(x.r.device), x);
    for (const d of coversOf(x.r)) if (norm(d) !== norm(x.r.device)) put(norm(d), x);
  }
  const best = (list) => list.reduce((b, x) => (!b || (x.days ?? -1e9) > (b.days ?? -1e9) ? x : b), null);
  const groups = new Map();
  for (const x of all) {
    if (x.eol || x.days == null || x.days < 0) continue;
    for (const dep of DEPENDS) {
      if (!dep.of(x.r)) continue;
      const base = best((byDevice.get(norm(x.r.device)) || []).filter((y) => y.r.category === dep.needs));
      if (!base || base.days == null) continue;
      const lapsed = base.eol || base.days < 0;
      const before = base.days <= 365 && base.days < x.days;
      if (!lapsed && !before) continue;
      const k = `${base.r.id}|${dep.what}`;
      if (!groups.has(k)) groups.set(k, { base, dep, lapsed, list: [] });
      groups.get(k).list.push(x);
    }
  }
  for (const [k, g] of groups) {
    const { base, dep, lapsed, list } = g;
    const dev = base.r.device;
    const kinds = list.map((x) => `${x.r.scheme} ${x.r.category.replace('EMV ', '')}`);
    const state = base.eol ? 'was accepted as end of life' : lapsed ? `expired ${formatDate(base.r.expiry_date)}` : `expires ${formatDate(base.r.expiry_date)}, before the approvals that rest on it`;
    add({
      key: `depends:${k}:${base.r.expiry_date}:${base.eol ? 'eol' : ''}:${list.length}`, kind: 'dependency',
      // The expired foundation already has its own critical action; this one explains the knock-on risk.
      priority: base.eol ? 3 : lapsed || base.days <= 180 ? 2 : 3,
      title: `${dep.what} for ${dev} ${base.eol ? 'is end of life' : lapsed ? 'has expired' : `expires in ${base.days} days`}: ${pl(list.length, 'approval')} at risk`,
      why: `${kinds.slice(0, 8).join(', ')}${kinds.length > 8 ? '…' : ''} ${list.length === 1 ? 'depends' : 'depend'} on the ${dep.what} approval, which ${state}. ${dep.what === 'TQM' ? 'A valid TQM is required to keep Mastercard L2 approvals.' : 'An L2 approval is anchored to its L1 approval; renew the L1 first.'}${base.eol ? ' If these are end of life too, mark them so they stop counting.' : ''}`,
      due: asOf, days: base.days, recordIds: [base.r.id, ...list.map((x) => x.r.id)],
    });
  }
  // PCI PTS lapsed: units already in the field keep working, but no new ones can be built.
  for (const x of all) {
    if (x.eol || x.r.category !== 'PCI PTS' || x.days == null || x.days >= 0) continue;
    if (x.stage === 'Market Approved Expiration') continue;
    add({
      key: `pci-production:${x.r.id}:${x.r.expiry_date}`, kind: 'dependency', priority: 1,
      title: `No new production: PCI PTS for ${x.r.device} expired ${formatDate(x.r.expiry_date)}`,
      why: 'Without a current PCI PTS approval no new units can be manufactured or injected with production keys, even while the EMV approvals are valid. Renew, or mark it end of life if the device is no longer built.',
      due: asOf, days: x.days, recordIds: [x.r.id],
    });
  }
}

// Escalation points before expiry (months -> who to involve).
const RADAR = [
  { from: 366, to: 545, key: 't18', priority: 4, title: (n) => `18-month radar: ${pl(n, 'approval')} expire in 12 to 18 months`,
    why: 'Recertification needs lab booking, a frozen kernel build and brand review. Decide now for each: administrative renewal, derivative, delta, full recertification, or end of life.' },
  { from: 181, to: 365, key: 't12', priority: 3, title: (n) => `12 months out: confirm renewal budget for ${pl(n, 'approval')}`,
    why: 'Escalate to Product Management for any without an agreed renewal path or budget, and book lab slots.' },
  { from: 91, to: 180, key: 't6', priority: 2, title: (n) => `6 months out: tell Client Solutions about ${pl(n, 'approval')} with no new LOA yet`,
    why: 'Give account teams and key customers time to plan deployments if a renewal slips.' },
  { from: 0, to: 90, key: 't3', priority: 1, title: (n) => `3 months out: executive escalation for ${pl(n, 'approval')} with no new LOA`,
    why: 'Decide on field continuation plans or sales restrictions in case the new LOA does not arrive before expiry.' },
];
const DONE_STAGES = new Set(['Replacement Received', 'Certified']);

/** One grouped action per escalation point, so the 18-month horizon is visible without one action per record. */
function radarActions(rows, { add, asOf }) {
  for (const p of RADAR) {
    const list = rows.filter((x) => x.days != null && x.days >= p.from && x.days <= p.to && !DONE_STAGES.has(x.stage)
      && !RESOLVED_EXPIRY.has(x.stage) && x.r.disposition !== 'Market Approved Expiration'
      && (p.key !== 't18' || !x.r.renewal_path) && (p.key !== 't12' || !x.r.renewal_path));
    if (!list.length) continue;
    add({ key: `radar:${p.key}:${list.length}`, kind: 'radar', priority: p.priority, title: p.title(list.length), why: p.why, due: asOf, recordIds: list.map((x) => x.r.id) });
  }
}

function summarize(rows, all, inboxPending) {
  const byWindow = Object.fromEntries([...WINDOWS.map((w) => [w.key, 0]), ['missing', 0]]);
  const byHealth = { good: 0, warning: 0, critical: 0, expired: 0, unknown: 0, retired: 0 };
  const byScheme = {}, byPlatform = {}, byCategory = {};
  let owned = 0, withDoc = 0, active = 0, dated = 0, pendingLoa = 0;
  for (const x of rows) {
    byWindow[x.win.key] = (byWindow[x.win.key] || 0) + 1;
    byHealth[x.health] = (byHealth[x.health] || 0) + 1;
    const s = x.r.scheme || 'Other';
    byScheme[s] = byScheme[s] || { total: 0, expired: 0, due90: 0, due365: 0 };
    byScheme[s].total++;
    if (x.health === 'expired') byScheme[s].expired++;
    if (!x.eol && x.days != null && x.days >= 0 && x.days <= 90) byScheme[s].due90++;
    if (!x.eol && x.days != null && x.days >= 0 && x.days <= 365) byScheme[s].due365++;
    const p = x.r.platform || 'Unassigned';
    byPlatform[p] = byPlatform[p] || { total: 0, expired: 0, due365: 0 };
    byPlatform[p].total++;
    if (x.health === 'expired') byPlatform[p].expired++;
    if (!x.eol && x.days != null && x.days >= 0 && x.days <= 365) byPlatform[p].due365++;
    byCategory[x.r.category] = (byCategory[x.r.category] || 0) + 1;
    if (x.r.owner) owned++;
    if (x.r.doc_count) withDoc++;
    if (x.days != null) dated++;
    if (x.days != null && x.days >= 0) active++;
    if (x.stage === 'Pending New LOA' || x.stage === 'Renewal Requested') pendingLoa++;
  }
  const total = rows.length;
  const expiredOpen = rows.filter((x) => x.health === 'expired').length;
  const open = rows.filter((x) => !x.eol);
  const due = (n) => open.filter((x) => x.days != null && x.days >= 0 && x.days <= n).length;
  const due90 = due(90);
  // Health score: share of live records that are current, dated, owned and evidenced.
  const pct = (n) => (total ? Math.round((n / total) * 100) : 100);
  const score = total ? Math.round(
    pct(total - expiredOpen) * 0.4 + pct(dated) * 0.2 + pct(owned) * 0.15 + pct(withDoc) * 0.15 + pct(total - due90) * 0.1,
  ) : 100;
  return {
    total, active, expiredOpen, due90, dated, owned, withDoc, pendingLoa, inboxPending,
    archived: all.length - total,
    due365: due(365), due180: due(180), due545: due(545),
    eol: rows.length - open.length,
    missing: byWindow.missing,
    byWindow, byHealth, byScheme, byPlatform, byCategory,
    compliancePct: pct(active), evidencePct: pct(withDoc), ownerPct: pct(owned),
    healthScore: score,
  };
}

/** Forward-looking calendar: count of expiries per month for the next N months. */
function timeline(records, { asOf = todayIso(), months = 18 } = {}) {
  const out = [];
  const [y, m] = asOf.split('-').map(Number);
  for (let i = 0; i < months; i++) {
    const yy = y + Math.floor((m - 1 + i) / 12), mm = ((m - 1 + i) % 12) + 1;
    out.push({ key: `${yy}-${String(mm).padStart(2, '0')}`, count: 0, bySchemes: {} });
  }
  const idx = Object.fromEntries(out.map((o, i) => [o.key, i]));
  for (const r of records) {
    if (r.archived || !r.expiry_date) continue;
    const k = r.expiry_date.slice(0, 7);
    if (idx[k] == null) continue;
    out[idx[k]].count++;
    out[idx[k]].bySchemes[r.scheme || 'Other'] = (out[idx[k]].bySchemes[r.scheme || 'Other'] || 0) + 1;
  }
  return out;
}

/** Short digest used for notifications and the email/report summary. */
function digest(analysis, { frequency = 'weekly' } = {}) {
  const open = analysis.actions.filter((a) => a.status === 'open');
  const horizon = frequency === 'daily' ? 7 : frequency === 'monthly' ? 45 : 21;
  const soon = open.filter((a) => a.priority <= 2 || (a.due && daysBetween(analysis.asOf, a.due) <= horizon));
  const s = analysis.summary;
  const crit = open.filter((a) => a.priority === 1).length;
  const title = crit
    ? `${crit} critical certification action${crit === 1 ? '' : 's'}`
    : soon.length ? `${soon.length} certification action${soon.length === 1 ? '' : 's'} this ${frequency === 'daily' ? 'day' : frequency === 'monthly' ? 'month' : 'week'}`
      : 'Certifications look good';
  const headline = `${s.expiredOpen} expired · ${s.due90} due in 90 days · ${s.due365} due in 12 months · health ${s.healthScore}/100`;
  const lines = soon.slice(0, 12).map((a) => `[${a.priorityLabel}] ${a.title}`);
  return { title, headline, lines, actions: soon.slice(0, 25), total: open.length, critical: crit };
}

module.exports = { analyze, summarize, timeline, digest, PRIORITY_LABEL };
