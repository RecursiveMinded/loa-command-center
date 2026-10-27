import { useState, useEffect } from 'preact/hooks';
import { html, Icon, fmtDate, fmtWhen, plural, useLoad, Spinner, toast, toastError, Modal } from '../lib.js';
import { call, native, saveAs, isDesktop, printHtml } from '../api.js';

function stamp() { return new Date().toISOString().slice(0, 10); }

export function ReportPreview({ opts = {} }) {
  const [rep, setRep] = useState(null);
  useEffect(() => { call('summaryReport', opts).then(setRep).catch(toastError); }, [JSON.stringify(opts)]);
  const pdf = async () => {
    try {
      if (isDesktop) { const p = await native('savePdf', { html: rep, name: `Certification Summary ${stamp()}.pdf` }); if (p) toast('PDF saved', 'ok'); }
      else printHtml(rep);
    } catch (e) { toastError(e); }
  };
  const saveHtml = async () => { try { await saveAs(`Certification Summary ${stamp()}.html`, rep, [{ name: 'Web page', extensions: ['html'] }]); } catch (e) { toastError(e); } };
  return html`<div>
    <div class="row" style="margin-bottom:10px">${opts.filterLabel ? html`<span class="tag">Scope: ${opts.filterLabel}</span>` : html`<span class="tag">Whole portfolio</span>`}<span class="grow"></span>
      <button class="btn" disabled=${!rep} onClick=${() => printHtml(rep)}><${Icon} name="print" /> Print</button>
      <button class="btn" disabled=${!rep} onClick=${saveHtml}>Save HTML</button>
      <button class="btn primary" disabled=${!rep} onClick=${pdf}><${Icon} name="download" /> Save PDF</button></div>
    ${rep ? html`<iframe class="report" title="Summary report" sandbox="allow-same-origin allow-modals" srcdoc=${rep}></iframe>` : html`<div class="row"><${Spinner} /> Building report…</div>`}
  </div>`;
}

export function ReportModal({ opts, onClose }) {
  return html`<${Modal} title="Summary report" wide onClose=${onClose}><${ReportPreview} opts=${opts} /><//>`;
}

export function Reports({ app, params }) {
  const [tab, setTab] = useState((params && params.tab) || 'summary');
  useEffect(() => { if (params && params.tab) setTab(params.tab); }, [params]);
  const tabs = [['summary', 'Summary report'], ['portal', 'Website change request'], ['digest', 'Digest'], ['exports', 'Exports'], ['audit', 'Audit log'], ['imports', 'Imports']];
  return html`
    <div class="page-head"><div><h1>Reports</h1><p>Share status with your team, keep the published portal in sync, and see every change.</p></div></div>
    <div class="tabs">${tabs.map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div>
    ${tab === 'summary' ? html`<${ReportPreview} opts=${{}} />` : null}
    ${tab === 'portal' ? html`<${PortalChanges} app=${app} />` : null}
    ${tab === 'digest' ? html`<${Digest} app=${app} />` : null}
    ${tab === 'exports' ? html`<${Exports} />` : null}
    ${tab === 'audit' ? html`<${Audit} app=${app} />` : null}
    ${tab === 'imports' ? html`<${Imports} app=${app} />` : null}`;
}

function PortalChanges({ app }) {
  const [rows, reload] = useLoad(() => call('portalChanges'), [app.version]);
  const [busy, setBusy] = useState(false);
  if (!rows) return html`<${Spinner} />`;
  const cols = ['Change ID', 'Platform', 'Website Section', 'Device / Model', 'Level', 'Card Brand / Type', 'Action', 'Current Website Value', 'Requested New Value', 'Restricted?', 'Web Status', 'Additional Comment'];
  const text = () => [cols.join('\t'), ...rows.map((r) => [r.ticket, r.platform, r.section, r.device, r.level, r.brand, r.action, r.published, r.requested, r.restricted, r.status, r.comment].join('\t'))].join('\n');
  const copy = async () => { try { await navigator.clipboard.writeText(text()); toast('Copied. Paste into your change request or spreadsheet.', 'ok'); } catch (e) { toastError(e); } };
  const download = async (markRequested) => {
    setBusy(true);
    try {
      const b = await call('exportChangeRequest', { markRequested });
      await saveAs(`Website_Change_Request_${todayStamp()}.xlsx`, b, [{ name: 'Excel', extensions: ['xlsx'] }]);
      if (markRequested) { toast(`Change IDs assigned; ${plural(rows.length, 'row')} marked as requested`, 'ok'); reload(); app.refresh(); }
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const published = async () => {
    try {
      const ids = rows.filter((r) => r.portalStatus === 'Change Requested' && r.action !== 'Review').map((r) => r.id);
      if (!ids.length) return toast('Nothing is marked as requested yet');
      const recs = await call('listRecords');
      for (const id of ids) {
        const rec = recs.find((x) => x.id === id);
        const row = rows.find((x) => x.id === id);
        await call('saveRecord', id, { portal_status: 'Published', portal_date: row.action === 'Update date' || row.action === 'Add date' ? rec.expiry_date : rec.portal_date });
      }
      toast(`Marked ${plural(ids.length, 'row')} as published`, 'ok');
      reload(); app.refresh();
    } catch (e) { toastError(e); }
  };
  return html`<div>
    <p class="muted">What your website shows versus your verified LOAs, in the format engineering gets. Expired dates, changed dates, and rows flagged "Change Needed" are listed. Import the portal page in compare mode (Settings → Data) to refresh what the website shows.</p>
    ${!rows.length ? html`<div class="card"><div class="empty"><${Icon} name="check" /><h3>Website is in sync</h3><div>No published dates differ from your verified dates.</div></div></div>` : html`
    <div class="row wrap" style="margin-bottom:10px"><b>${plural(rows.length, 'change')}</b><span class="grow"></span>
      <button class="btn primary" disabled=${busy} onClick=${() => download(true)} title="Assign change IDs (CR-001…) and mark the rows as requested"><${Icon} name="download" /> Create change request</button>
      <button class="btn" disabled=${busy} onClick=${() => download(false)}>Preview in Excel</button>
      <button class="btn" onClick=${copy}>Copy as table</button>
      <button class="btn ghost" onClick=${published} title="After engineering updates the website">Mark requested rows published</button></div>
    <div class="table-wrap"><table class="t"><thead><tr><th>ID</th><th>Platform</th><th>Section</th><th>Device</th><th>Brand / type</th><th>Action</th><th>Website now</th><th>Requested</th><th>Status</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr><td class="small nowrap">${r.ticket || '—'}</td><td class="small">${r.platform}</td><td class="small">${r.section}</td><td class="dev"><a onClick=${() => app.openRecord(r.id)}>${r.device}</a></td><td>${r.brand}</td>
        <td class="small nowrap"><span class=${`pill ${r.action === 'Update date' ? 'info' : r.action === 'Add date' ? 'good' : 'warning'}`}>${r.action}</span></td>
        <td class="nowrap"><s class="faint">${/^\d{4}-/.test(r.published) ? fmtDate(r.published) : r.published}</s></td><td class="nowrap"><b>${/^\d{4}-/.test(r.requested) ? fmtDate(r.requested) : r.requested}</b></td><td class="small">${r.status}</td></tr>`)}</tbody></table></div>`}
  </div>`;
}

function todayStamp() { return new Date().toISOString().slice(0, 10); }

function Digest({ app }) {
  const [dg] = useLoad(() => call('digest'), [app.version]);
  const [hist] = useLoad(() => call('notificationHistory'), [app.version]);
  if (!dg) return html`<${Spinner} />`;
  const copy = async () => { try { await navigator.clipboard.writeText(dg.email); toast('Copied', 'ok'); } catch (e) { toastError(e); } };
  return html`<div class="dash">
    <div class="card"><div class="hd"><div><h3>${dg.title}</h3><div class="muted small">${dg.headline}</div></div>
      <div class="row"><button class="btn" onClick=${() => native('testNotification').then(() => toast('Notification sent')).catch(toastError)}><${Icon} name="bell" /> Send now</button>
      <button class="btn" onClick=${copy}><${Icon} name="mail" /> Copy as email</button></div></div>
      <div class="bd"><textarea class="mono" style="width:100%;height:380px" value=${dg.email}></textarea></div></div>
    <div class="card"><div class="hd"><h3>Sent notifications</h3><a onClick=${() => app.go('settings', { tab: 'notify' })}>Schedule</a></div>
      <div class="bd">${hist && hist.length ? hist.map((n) => html`<div class="action"><div class="grow"><div class="t small">${n.title}</div><div class="faint small">${fmtWhen(n.ts)} · ${n.kind}</div></div></div>`)
        : html`<p class="muted small">None yet. The ${app.settings.notify.frequency} digest appears here once sent.</p>`}</div></div>
  </div>`;
}

function Exports() {
  const x = async () => { try { await saveAs(`Certifications ${stamp()}.xlsx`, await call('exportExcel', {}), [{ name: 'Excel', extensions: ['xlsx'] }]); } catch (e) { toastError(e); } };
  const c = async () => { try { await saveAs(`Certifications ${stamp()}.csv`, await call('exportCsv', {}), [{ name: 'CSV', extensions: ['csv'] }]); } catch (e) { toastError(e); } };
  return html`<div class="grid2" style="max-width:820px">
    <div class="card pad"><h3>Excel workbook</h3><p class="muted small mt">Four sheets: certifications, the action plan, a summary by brand and platform, and portal changes. Expired and due rows are colour-coded.</p><button class="btn primary mt" onClick=${x}><${Icon} name="download" /> Export Excel</button></div>
    <div class="card pad"><h3>CSV</h3><p class="muted small mt">All records in one flat file for other tools. To export a filtered list, use the Excel or CSV button on the Certifications screen.</p><button class="btn mt" onClick=${c}><${Icon} name="download" /> Export CSV</button></div>
  </div>`;
}

function Audit({ app }) {
  const [rows] = useLoad(() => call('auditLog', 1000), [app.version]);
  const [q, setQ] = useState('');
  if (!rows) return html`<${Spinner} />`;
  const list = rows.filter((a) => !q || `${a.device} ${a.scheme} ${a.field} ${a.new_value} ${a.old_value} ${a.source} ${a.actor}`.toLowerCase().includes(q.toLowerCase()));
  return html`<div><div class="filters"><input type="search" placeholder="Filter changes" value=${q} onInput=${(e) => setQ(e.target.value)} /><span class="muted small">Latest ${rows.length} changes. Every field change is recorded with who made it and where it came from.</span></div>
    <div class="table-wrap" style="max-height:calc(100vh - 290px)"><table class="t compact"><thead><tr><th>When</th><th>Record</th><th>Change</th><th>By</th><th>Source</th></tr></thead>
    <tbody>${list.slice(0, 600).map((a) => html`<tr class=${a.record_id ? 'click' : ''} onClick=${() => a.record_id && a.device && app.openRecord(a.record_id)}><td class="small nowrap">${fmtWhen(a.ts)}</td>
      <td class="small">${a.device ? html`<b>${a.device}</b> <span class="muted">${a.scheme} ${a.category}</span>` : html`<span class="faint">(deleted)</span>`}</td>
      <td class="small">${a.action === 'create' ? 'Created' : a.action === 'delete' ? 'Deleted' : html`<b>${a.field}</b>: ${a.old_value ? html`<s class="faint">${a.old_value}</s> → ` : ''}${a.new_value || '—'}`}</td>
      <td class="small">${a.actor}</td><td class="small muted ellipsis" style="max-width:260px" title=${a.source}>${a.source}</td></tr>`)}</tbody></table></div></div>`;
}

function Imports({ app }) {
  const [rows] = useLoad(() => call('listImports'), [app.version]);
  if (!rows) return html`<${Spinner} />`;
  return html`<div class="table-wrap" style="max-width:900px"><table class="t"><thead><tr><th>When</th><th>File</th><th>Kind</th><th class="num">Added</th><th class="num">Updated</th><th class="num">Unchanged</th><th class="num">Skipped</th></tr></thead>
    <tbody>${rows.length ? rows.map((i) => html`<tr><td class="small nowrap">${fmtWhen(i.ts)}</td><td class="dev">${i.filename}</td><td>${i.kind}</td><td class="num">${i.added}</td><td class="num">${i.updated}</td><td class="num">${i.unchanged}</td><td class="num">${i.skipped}</td></tr>`)
      : html`<tr><td colspan="7" class="muted">No imports yet.</td></tr>`}</tbody></table></div>`;
}
