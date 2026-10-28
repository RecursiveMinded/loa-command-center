import { useState, useMemo } from 'preact/hooks';
import { html, Icon, fmtDate, plural, useLoad, Spinner, toast, toastError, Modal, usePersist } from '../lib.js';
import { call } from '../api.js';

const PRI = { 1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low' };
const KINDS = {
  expired: 'Expired', renewal: 'Renewal', wave: 'Renewal wave', restricted: 'Final / restricted', chase: 'Chase LOA',
  followup: 'Overdue next step', portal: 'Portal update', replacement: 'Replacement', data: 'Data quality', evidence: 'Missing LOA', inbox: 'Inbox',
  dependency: 'Dependency', radar: 'Escalation radar',
};

export function ActionItem({ a, app, onChange, compact }) {
  const [busy, setBusy] = useState(false);
  const set = async (status, opts) => {
    setBusy(true);
    try {
      await call('setTask', a.key, status, opts);
      toast(status === 'done' ? 'Marked done' : status === 'snoozed' ? `Snoozed for ${opts.snoozeDays} days` : status === 'dismissed' ? 'Dismissed' : 'Reopened');
      onChange && onChange();
      app.refreshCounts();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const ids = a.recordIds || [];
  const open = () => {
    if (a.kind === 'inbox') return app.go('inbox');
    if (a.kind === 'portal') return app.go('reports', { tab: 'portal' });
    if (ids.length === 1) return app.openRecord(ids[0]);
    if (ids.length) return app.go('register', { filter: { ids } });
    return null;
  };
  return html`<div class=${`action ${a.status !== 'open' ? 'done' : ''}`}>
    <div class=${`pri p${a.priority}`}></div>
    <div class="grow">
      <div class="t"><a style="color:inherit" onClick=${open}>${a.title}</a></div>
      ${compact ? null : html`<div class="why">${a.why}</div>`}
      <div class="meta">
        <span class=${`pill ${a.priority === 1 ? 'expired' : a.priority === 2 ? 'critical' : a.priority === 3 ? 'warning' : ''}`}>${a.priorityLabel || PRI[a.priority]}</span>
        <span class="tag">${KINDS[a.kind] || a.kind}</span>
        ${a.due ? html`<span class="tag">Do by ${fmtDate(a.due)}</span>` : null}
        ${ids.length > 1 ? html`<span class="tag link" onClick=${open}>${plural(ids.length, 'record')}</span>` : null}
        ${a.status === 'snoozed' && a.snoozeUntil ? html`<span class="tag">Snoozed until ${fmtDate(a.snoozeUntil)}</span>` : null}
      </div>
    </div>
    <div class="btns">${a.status === 'open' ? html`
      <button class="btn sm" disabled=${busy} title="Mark done" onClick=${() => set('done')}><${Icon} name="check" /> Done</button>
      <button class="btn sm ghost icon" disabled=${busy} title="Snooze 7 days" onClick=${() => set('snoozed', { snoozeDays: 7 })}><${Icon} name="snooze" /></button>
      ${compact ? null : html`<button class="btn sm ghost icon" disabled=${busy} title="Dismiss" onClick=${() => set('dismissed')}><${Icon} name="x" /></button>`}`
    : html`<button class="btn sm" disabled=${busy} onClick=${() => set('open')}>Reopen</button>`}</div>
  </div>`;
}

export function Plan({ app }) {
  const [actions, reload] = useLoad(() => call('getActions'), [app.version]);
  const [f, setF] = usePersist('plan', { show: 'open', kind: '' });
  const [email, setEmail] = useState(null);
  const list = useMemo(() => (actions || []).filter((a) => (f.show === 'all' || a.status === f.show) && (!f.kind || a.kind === f.kind)), [actions, f]);
  if (!actions) return html`<div class="row"><${Spinner} /> Building your plan…</div>`;
  const counts = { open: 0, snoozed: 0, done: 0, dismissed: 0 };
  for (const a of actions) counts[a.status] = (counts[a.status] || 0) + 1;
  const kinds = [...new Set(actions.filter((a) => f.show === 'all' || a.status === f.show).map((a) => a.kind))];
  const draft = async () => {
    const ids = [...new Set(list.filter((a) => a.priority <= 2).flatMap((a) => a.recordIds || []))].slice(0, 60);
    if (!ids.length) return toast('No critical or high actions with records to include');
    try { setEmail(await call('aiDraftEmail', ids, { purpose: 'renewal status' })); } catch (e) { toastError(e); }
  };
  const groups = [1, 2, 3, 4].map((p) => [p, list.filter((a) => a.priority === p)]).filter(([, l]) => l.length);
  return html`
    <div class="page-head"><div><h1>Action plan</h1><p>Built by the rules engine from your expiry dates, lead times, stages and evidence. Every action says why.</p></div>
      <div class="row"><button class="btn" onClick=${draft}><${Icon} name="mail" /> Draft status email</button>
      <button class="btn primary" onClick=${app.openReport}><${Icon} name="report" /> Summary report</button></div></div>
    <div class="filters">
      <div class="seg">${['open', 'snoozed', 'done', 'dismissed', 'all'].map((s) => html`<button class=${f.show === s ? 'on' : ''} onClick=${() => setF({ ...f, show: s, kind: '' })}>${s[0].toUpperCase() + s.slice(1)}${s !== 'all' ? ` (${counts[s] || 0})` : ''}</button>`)}</div>
      <select value=${f.kind} onChange=${(e) => setF({ ...f, kind: e.target.value })} aria-label="Type"><option value="">All types</option>${kinds.map((k) => html`<option value=${k}>${KINDS[k] || k}</option>`)}</select>
    </div>
    ${!list.length ? html`<div class="card"><div class="empty"><${Icon} name="check" /><h3>${f.show === 'open' ? 'All clear' : 'Nothing here'}</h3><div>${f.show === 'open' ? 'No open actions. New ones appear as dates approach.' : ''}</div></div></div>`
      : groups.map(([p, l]) => html`<div><div class="prihead"><span class=${`pri p${p}`} style="width:10px;height:10px;border-radius:3px;display:inline-block"></span>${PRI[p]} <span class="muted small">${l.length}</span></div>
        <div class="card"><div class="bd" style="padding-top:4px;padding-bottom:4px">${l.map((a) => html`<${ActionItem} key=${a.key} a=${a} app=${app} onChange=${reload} />`)}</div></div></div>`)}
    ${email ? html`<${EmailModal} email=${email} onClose=${() => setEmail(null)} />` : null}`;
}

export function EmailModal({ email, onClose }) {
  const copy = async () => { try { await navigator.clipboard.writeText(email.text); toast('Copied to clipboard', 'ok'); } catch (e) { toastError(e); } };
  return html`<${Modal} title="Draft email" wide onClose=${onClose}>
    <p class="muted small">${email.ai ? 'Written by your local AI. Review before sending.' : 'Template draft. Turn on the local AI in Settings for a tailored version.'}</p>
    <textarea style="width:100%;height:340px" class="mono" value=${email.text}></textarea>
    <div class="row mt" style="justify-content:flex-end"><button class="btn" onClick=${onClose}>Close</button><button class="btn primary" onClick=${copy}><${Icon} name="mail" /> Copy</button></div>
  <//>`;
}
