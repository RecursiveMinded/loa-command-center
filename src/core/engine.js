'use strict';
// The decision engine: a deterministic, explainable "project manager".
// It looks at every record and produces a prioritized action plan. Each
// action says why it exists, so a reviewer can trust (or challenge) it.
// The optional local LLM only rephrases and answers questions on top of this.

const { todayIso, daysBetween, addDays, formatDate } = require('./dates');
const { daysRemaining, effectiveStage, windowFor, health, WINDOWS } = require('./lifecycle');

const IN_PROGRESS = new Set(['Renewal Requested', 'Pending New LOA', 'Replacement Received']);
const RESOLVED_EXPIRY = new Set(['Market Approved Expiration', 'Retired']);
const PRIORITY_LABEL = { 1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low' };

function label(r) {
  return [r.platform, r.device, r.scheme && r.scheme !== 'Other' ? r.scheme : '', r.category].filter(Boolean).join(' · ');
}

function analyze(records, { settings = {}, asOf = todayIso(), tasks = {}, inboxPending = 0, replacements = [] } = {}) {
  const lead = settings.leadTimes || {};
  const live = records.filter((r) => !r.archived);
  const rows = live.map((r) => {
    const days = daysRemaining(r, asOf);
    return { r, days, stage: effectiveStage(r, asOf), win: windowFor(days), health: health(r, asOf) };
  });

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
      if (!r) continue;
      add({
        key: `activate:${rep.id}`, kind: 'replacement', priority: 2,
        title: `Activate replacement LOA: ${label(r)}`,
        why: `Replacement ${rep.approval_number || ''} became effective ${formatDate(rep.issue_date)} (valid to ${formatDate(rep.expiry_date)}). Make it the current approval.`,
        due: rep.issue_date, recordIds: [r.id], approvalId: rep.id,
      });
    }
  }

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

  return { asOf, actions, summary: summarize(rows, records, inboxPending) };
}

function pl(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

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
    if (x.days != null && x.days >= 0 && x.days <= 90) byScheme[s].due90++;
    if (x.days != null && x.days >= 0 && x.days <= 365) byScheme[s].due365++;
    const p = x.r.platform || 'Unassigned';
    byPlatform[p] = byPlatform[p] || { total: 0, expired: 0, due365: 0 };
    byPlatform[p].total++;
    if (x.health === 'expired') byPlatform[p].expired++;
    if (x.days != null && x.days >= 0 && x.days <= 365) byPlatform[p].due365++;
    byCategory[x.r.category] = (byCategory[x.r.category] || 0) + 1;
    if (x.r.owner) owned++;
    if (x.r.doc_count) withDoc++;
    if (x.days != null) dated++;
    if (x.days != null && x.days >= 0) active++;
    if (x.stage === 'Pending New LOA' || x.stage === 'Renewal Requested') pendingLoa++;
  }
  const total = rows.length;
  const expiredOpen = rows.filter((x) => x.health === 'expired').length;
  const due90 = rows.filter((x) => x.days != null && x.days >= 0 && x.days <= 90).length;
  // Health score: share of live records that are current, dated, owned and evidenced.
  const pct = (n) => (total ? Math.round((n / total) * 100) : 100);
  const score = total ? Math.round(
    pct(total - expiredOpen) * 0.4 + pct(dated) * 0.2 + pct(owned) * 0.15 + pct(withDoc) * 0.15 + pct(total - due90) * 0.1,
  ) : 100;
  return {
    total, active, expiredOpen, due90, dated, owned, withDoc, pendingLoa, inboxPending,
    archived: all.length - total,
    due365: rows.filter((x) => x.days != null && x.days >= 0 && x.days <= 365).length,
    due180: rows.filter((x) => x.days != null && x.days >= 0 && x.days <= 180).length,
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
