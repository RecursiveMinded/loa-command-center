// The Archive: records deleted or expired out of the register. They stay
// searchable by any field and can be restored; permanent deletion only happens here.
import { useState, useEffect } from 'preact/hooks';
import { html, Icon, fmtDate, plural, useLoad, Spinner, toast, toastError } from '../lib.js';
import { call } from '../api.js';
import { openDoc } from '../docs.js';

export function Archive({ app }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [sel, setSel] = useState(new Set());
  const [open, setOpen] = useState(null);
  useEffect(() => { const t = setTimeout(() => setTerm(q), 200); return () => clearTimeout(t); }, [q]);
  const [rows, reload] = useLoad(() => call('listArchive', term), [term]);
  const [expired, reloadExpired] = useLoad(() => call('expiredRecords'), []);

  if (!rows) return html`<div class="row"><${Spinner} /> Loading…</div>`;
  const done = () => { setSel(new Set()); reload(); reloadExpired(); app.refresh(); };
  const toggle = (id) => { const s = new Set(sel); if (s.has(id)) s.delete(id); else s.add(id); setSel(s); };
  const allOn = rows.length && rows.every((r) => sel.has(r.id));
  const ids = [...sel].filter((id) => rows.some((r) => r.id === id));

  const moveExpired = async () => {
    if (!expired || !expired.length) return toast('No records in the register have passed their expiry date');
    if (!confirm(`Move ${plural(expired.length, 'expired record')} to the Archive? They leave the register, dashboard and reports but stay searchable here.`)) return;
    try { toast(`Moved ${plural(await call('archiveExpired'), 'record')} to the Archive`, 'ok'); done(); } catch (e) { toastError(e); }
  };
  const restore = async () => {
    try {
      const r = await call('restoreArchived', ids);
      toast(`Restored ${plural(r.restored, 'record')} to the register`, 'ok');
      if (r.skipped.length) toast(`Kept ${plural(r.skipped.length, 'record')} in the Archive: ${r.skipped.slice(0, 3).map((x) => `${x.label} (${x.reason})`).join('; ')}`, 'err');
      done();
    } catch (e) { toastError(e); }
  };
  const purge = async () => {
    if (!confirm(`Delete ${plural(ids.length, 'archived record')} permanently? This cannot be undone from the app (the daily backup still has them). The LOA files stay in the LOA inbox library.`)) return;
    try { toast(`Deleted ${plural(await call('purgeArchived', ids), 'record')} permanently`, 'ok'); done(); } catch (e) { toastError(e); }
  };

  return html`
    <div class="page-head"><div><h1>Archive</h1><p>${plural(rows.length, 'archived record')}${term ? ` matching “${term}”` : ''}. Deleted and expired records live here, out of the register, dashboard and reports.</p></div>
      <div class="row"><button class="btn" onClick=${moveExpired} title="Move every record whose expiry date has passed">
        <${Icon} name="clock" /> Move expired records here${expired && expired.length ? ` (${expired.length})` : ''}</button></div></div>

    <div class="filters"><input id="archive-search" type="search" style="flex:1;max-width:560px" aria-label="Search the Archive"
      placeholder="Search everything: device, brand, approval no., platform, dates, LOA file, notes…" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>

    ${!rows.length ? html`<div class="card"><div class="empty"><${Icon} name="box" /><h3>${term ? 'Nothing in the Archive matches' : 'The Archive is empty'}</h3>
      <div>${term ? 'Try fewer words.' : 'Deleting a record moves it here. Expired records can be moved here with the button above.'}</div></div></div>` : html`
    <div class="table-wrap" style="max-height:calc(100vh - 260px)"><table class="t">
      <thead><tr><th class="chk"><input type="checkbox" aria-label="Select all" checked=${allOn} onChange=${() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
        <th>Device</th><th>Brand</th><th>Type</th><th>Approval no.</th><th>Expired / expires</th><th>LOAs</th><th>Archived</th><th>Reason</th></tr></thead>
      <tbody>${rows.flatMap((r) => [html`
        <tr key=${r.id} class=${`click ${sel.has(r.id) ? 'sel' : ''}`} onClick=${() => setOpen(open === r.id ? null : r.id)}>
          <td class="chk" onClick=${(e) => e.stopPropagation()}><input type="checkbox" aria-label="Select" checked=${sel.has(r.id)} onChange=${() => toggle(r.id)} /></td>
          <td><div class="dev">${r.device}</div><div class="faint small">${[r.platform, r.bundle, r.kernel_version].filter(Boolean).join(' · ')}</div></td>
          <td>${r.scheme}</td><td class="nowrap">${r.category}</td>
          <td class="small ellipsis" style="max-width:170px" title=${r.approval_number}>${r.approval_number}</td>
          <td class="nowrap">${fmtDate(r.expiry_date) || html`<span class="faint">—</span>`}</td>
          <td class="num">${r.documents.length || html`<span class="faint">—</span>`}</td>
          <td class="small nowrap">${fmtDate(r.archived_at.slice(0, 10))}${r.archived_by ? html`<div class="faint">${r.archived_by}</div>` : null}</td>
          <td class="small">${r.reason}</td></tr>`,
        open === r.id ? html`<tr key=${`${r.id}-d`} class="detail"><td></td><td colspan="8"><${Detail} r=${r} /></td></tr>` : null])}</tbody></table></div>`}

    ${ids.length ? html`<div class="bulkbar"><b>${ids.length} selected</b><span class="grow"></span>
      <button class="btn primary" onClick=${restore}><${Icon} name="refresh" /> Restore to register</button>
      <button class="btn danger" onClick=${purge}><${Icon} name="trash" /> Delete permanently</button>
      <button class="btn" onClick=${() => setSel(new Set())}>Clear selection</button></div>` : null}`;
}

function Detail({ r }) {
  const F = (l, v) => (v ? html`<div><span class="faint">${l}</span> ${v}</div>` : null);
  return html`<div class="archive-detail">
    <div class="grid3 small">${F('Vendor', r.vendor)}${F('Issued', fmtDate(r.issue_date))}${F('Owner', r.owner)}${F('Tags', r.tags)}</div>
    ${r.approvals.length ? html`<div class="section-title">Approvals</div><table class="t small"><tbody>${r.approvals.map((a) => html`<tr>
      <td>${a.role}</td><td>${a.approval_number}</td><td>${fmtDate(a.issue_date)}</td><td>${fmtDate(a.expiry_date)}</td><td class="faint">${a.note}</td></tr>`)}</tbody></table>` : null}
    ${r.documents.length ? html`<div class="section-title">LOAs</div>${r.documents.map((d) => html`<div class="row"><${Icon} name="file" /> ${d.filename}
      <button class="btn sm ghost" onClick=${() => openDoc(d)}><${Icon} name="eye" /> Open</button></div>`)}` : null}
    ${r.history.length ? html`<div class="section-title">History</div><div class="small" style="max-height:180px;overflow:auto">${r.history.slice().reverse().map((h) => html`<div>
      <span class="faint">${fmtDate(h.ts.slice(0, 10))} ${h.actor}</span> ${h.action}${h.field ? ` ${h.field}` : ''}${h.old_value || h.new_value ? `: ${[h.old_value, h.new_value].filter(Boolean).join(' → ')}` : ''}</div>`)}</div>` : null}
  </div>`;
}
