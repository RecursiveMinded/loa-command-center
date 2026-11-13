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
  const tabs = [['summary', 'Summary report'], ['eol', 'End of life'], ['portal', 'Website change request'], ['digest', 'Digest'], ['exports', 'Exports'], ['audit', 'Audit log'], ['imports', 'Imports']];
  return html`
    <div class="page-head"><div><h1>Reports</h1><p>Share status with your team, keep the published portal in sync, and see every change.</p></div></div>
    <div class="tabs">${tabs.map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div>
    ${tab === 'summary' ? html`<${ReportPreview} opts=${{}} />` : null}
    ${tab === 'eol' ? html`<${EolReport} app=${app} />` : null}
    ${tab === 'portal' ? html`<${PortalChanges} app=${app} />` : null}
    ${tab === 'digest' ? html`<${Digest} app=${app} />` : null}
    ${tab === 'exports' ? html`<${Exports} />` : null}
    ${tab === 'audit' ? html`<${Audit} app=${app} />` : null}
    ${tab === 'imports' ? html`<${Imports} app=${app} />` : null}`;
}

/**
 * Certifications expired for a year or more: most likely devices no longer
 * supported. Review the list, mark them end of life (a backup is taken
 * first, and it can be undone), and export the report.
 */
function EolReport({ app }) {
  const [days, setDays] = useState((app.settings && app.settings.eolAfterDays) || 365);
  const [rep, reload] = useLoad(() => call('eolCandidates', { days }), [app.version, days]);
  const [off, setOff] = useState(new Set());
  const [busy, setBusy] = useState(false);
  if (!rep) return html`<${Spinner} />`;
  const open = rep.groups.flatMap((g) => g.records.filter((r) => !r.assumed && !off.has(g.device + g.platform + g.bundle)).map((r) => r.id));
  const toggle = (g) => { const k = g.device + g.platform + g.bundle; const n = new Set(off); if (n.has(k)) n.delete(k); else n.add(k); setOff(n); };
  const pickDays = async (v) => { setDays(v); try { const ns = await call('setSettings', { eolAfterDays: v }); app.setSettings && app.setSettings(ns); } catch (e) { toastError(e); } };
  const mark = async () => {
    setBusy(true);
    try { const n = await call('markAssumedEol', open, days); toast(`Marked ${plural(n, 'certification')} end of life. A backup was taken first.`, 'ok'); reload(); app.refresh(); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const undo = async () => {
    setBusy(true);
    try { const n = await call('undoAssumedEol'); toast(`Tracking ${plural(n, 'certification')} again`, 'ok'); reload(); app.refresh(); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const xl = async () => { try { await saveAs(`End of life report ${stamp()}.xlsx`, await call('exportEolReport', days), [{ name: 'Excel', extensions: ['xlsx'] }]); } catch (e) { toastError(e); } };
  const span = days >= 365 ? plural(Math.round(days / 365), 'year') : `${Math.round(days / 30.4)} months`;
  return html`<div class="card pad eol-report">
    <div class="row between wrap"><div><h3>Likely end of life</h3>
      <p class="muted small mt">Certifications expired ${span} or more ago usually belong to devices that are no longer supported. Marking them end of life stops them showing as gaps and actions; their dates are kept, and you can track them again at any time.</p></div>
      <label class="field" style="min-width:160px">Expired at least<select value=${days} onChange=${(e) => pickDays(Number(e.target.value))}>
        ${[[365, '1 year'], [548, '18 months'], [730, '2 years'], [1095, '3 years']].map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></label></div>
    <div class="row wrap mt">
      <span class="pill expired">${plural(rep.devices, 'device')} with every certification lapsed</span>
      <span class="pill warning">${plural(rep.partial, 'device')} with some still valid</span>
      <span class="pill info">${plural(rep.toMark, 'certification')} to mark</span>
      ${rep.marked ? html`<span class="pill">${plural(rep.marked, 'certification')} marked already</span>` : null}</div>
    <div class="row mt">
      <button class="btn primary" disabled=${busy || !open.length} onClick=${mark}>${busy ? html`<${Spinner} />` : html`<${Icon} name="check" />`} Mark ${plural(open.length, 'certification')} end of life</button>
      <button class="btn" onClick=${xl}><${Icon} name="download" /> Export report</button>
      ${rep.marked ? html`<button class="btn ghost" disabled=${busy} onClick=${undo} title="Track every certification this report marked again">Undo marking (${rep.marked})</button>` : null}</div>
    ${!rep.groups.length ? html`<div class="empty mt"><${Icon} name="check" /><h3>Nothing expired ${span} or more</h3></div>` : html`
    <table class="mt"><thead><tr><th></th><th>Device</th><th>Platform · bundle</th><th>Assessment</th><th>Expired certifications</th><th>Newest expiry</th></tr></thead><tbody>
      ${rep.groups.map((g) => { const k = g.device + g.platform + g.bundle; return html`<tr class=${g.marked ? 'faint' : ''}>
        <td>${g.marked ? html`<span class="tag">Marked</span>` : html`<input type="checkbox" aria-label=${`Mark ${g.device}`} checked=${!off.has(k)} onChange=${() => toggle(g)} />`}</td>
        <td><b>${g.device}</b></td><td class="small">${[g.platform, g.bundle].filter(Boolean).join(' · ') || '—'}</td>
        <td class="small">${g.kind === 'device' ? html`<span class="bad-text">Every certification lapsed: end of life likely</span>` : html`<span class="warn-text">Still valid: ${g.stillValid.map((v) => (v.scheme && v.scheme !== 'EMVCo' ? v.scheme : v.category)).join(', ')}</span>`}</td>
        <td class="small">${g.records.map((r) => html`<div><a href="#" onClick=${(e) => { e.preventDefault(); app.openRecord(r.id); }}>${r.scheme && r.scheme !== 'EMVCo' ? `${r.scheme} ` : ''}${r.category}${r.kernel_version ? ` ${r.kernel_version}` : ''}</a> <span class="faint">expired ${fmtDate(r.expiry_date)} (${Math.round(r.daysExpired / 36.5) / 10} y)</span>${r.assumed ? html` <span class="tag">EOL</span>` : null}</div>`)}</td>
        <td class="small nowrap">${fmtDate(g.newestExpiry)}</td></tr>`; })}
    </tbody></table>`}
  </div>`;
}

function PortalChanges({ app }) {
  const [rows, reload] = useLoad(() => call('portalChanges'), [app.version]);
  const [held] = useLoad(() => call('heldChanges'), [app.version]);
  const [busy, setBusy] = useState(false);
  if (!rows) return html`<${Spinner} />`;
  const cols = ['Change ID', 'Platform', 'Website Section', 'Device / Model', 'Level', 'Card Brand / Type', 'Action', 'Current Website Value', 'Requested New Value', 'Restricted?', 'Web Status', 'Additional Comment', 'LOA Kernel', 'Bundle Kernel', 'LOA on file'];
  const text = () => [cols.join('\t'), ...rows.map((r) => [r.ticket, r.platform, r.section, r.device, r.level, r.brand, r.action, r.published, r.requested, r.restricted, r.status, r.comment, r.loaKernel, r.bundleKernel, r.evidence].join('\t'))].join('\n');
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
    ${held && held.length ? html`<div class="callout bad held"><div><b>${plural(held.length, 'change')} held back: the website would reject ${held.length === 1 ? 'it' : 'them'}</b>
      <div class="small muted">An LOA only renews a website date when it covers the device and the kernel the bundle runs. Fix these before they go in a request.</div>
      <ul class="small">${held.map((r) => html`<li><a onClick=${() => app.openRecord(r.id)}><b>${r.device}</b> ${r.brand} ${r.level}</a>: ${r.reason}</li>`)}</ul></div></div>` : null}
    ${!rows.length ? html`<div class="card"><div class="empty"><${Icon} name="check" /><h3>Website is in sync</h3><div>No published dates differ from your verified dates.</div></div></div>` : html`
    <div class="row wrap" style="margin-bottom:10px"><b>${plural(rows.length, 'change')}</b><span class="grow"></span>
      <button class="btn primary" disabled=${busy} onClick=${() => download(true)} title="Assign change IDs (CR-001…) and mark the rows as requested"><${Icon} name="download" /> Create change request</button>
      <button class="btn" disabled=${busy} onClick=${() => download(false)}>Preview in Excel</button>
      <button class="btn" onClick=${copy}>Copy as table</button>
      <button class="btn ghost" onClick=${published} title="After engineering updates the website">Mark requested rows published</button></div>
    <div class="table-wrap"><table class="t"><thead><tr><th>ID</th><th>Platform</th><th>Section</th><th>Device</th><th>Brand / type</th><th title="LOA kernel / kernel the bundle runs">Kernel</th><th>Action</th><th>Website now</th><th>Requested</th><th>Status</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr><td class="small nowrap">${r.ticket || '—'}</td><td class="small">${r.platform}</td><td class="small">${r.section}</td><td class="dev"><a onClick=${() => app.openRecord(r.id)}>${r.device}</a></td><td>${r.brand}</td>
        <td class="small nowrap">${r.loaKernel || r.bundleKernel ? html`${r.loaKernel || '—'}${r.bundleKernel ? html` <span class="faint">/ ${r.bundleKernel}</span>` : null}` : ''}</td>
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
