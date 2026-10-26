import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { html, Icon, fmtDate, fmtWhen, plural, useLoad, Spinner, toast, toastError, Modal, bytes, recLabel } from '../lib.js';
import { call, native, isDesktop } from '../api.js';
import { subscribe, addFiles, clearFinished, filesFromDrop } from '../queue.js';

const val = (f) => (f && typeof f === 'object' ? f.value : f) || '';
const ACTION = {
  update: { label: 'Renewal: update record', cls: 'good' },
  replacement: { label: 'Replacement (not yet effective)', cls: 'info' },
  attach: { label: 'Same approval: link LOA', cls: 'brand' },
  history: { label: 'Older letter: keep as history', cls: '' },
  create: { label: 'New record', cls: 'warning' },
  unmatched: { label: 'Choose the records it covers', cls: 'critical' },
};
const FIELD = { expiry_date: 'Expiry', issue_date: 'Issued', approval_number: 'Approval no.', expiry_basis: 'Expiry basis', kernel_version: 'Kernel / version', restricted: 'Restricted', stage: 'Stage', archived: 'Archived' };

function isSafe(p, letter, threshold) {
  return ['update', 'attach'].includes(p.action) && !(p.warnings || []).length && !(letter.warnings || []).length && p.score >= 80 && letter.confidence >= threshold;
}

export function FilePickers({ onFiles, compact }) {
  const files = useRef(), folder = useRef();
  const pick = (e) => { onFiles([...e.target.files]); e.target.value = ''; };
  return html`<span class="row">
    <input ref=${files} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp,.txt" class="hidden" onChange=${pick} />
    <input ref=${folder} type="file" webkitdirectory class="hidden" onChange=${pick} />
    <button class=${`btn ${compact ? '' : 'primary'}`} onClick=${() => files.current.click()}><${Icon} name="upload" /> Choose files</button>
    <button class="btn" onClick=${() => folder.current.click()}><${Icon} name="folder" /> Choose folder</button></span>`;
}

export function Inbox({ app, params }) {
  const [tab, setTab] = useState((params && params.tab) || 'pending');
  const [items, reload] = useLoad(() => call('listInbox', tab === 'documents' ? 'pending' : tab), [app.version, tab]);
  const [docs, reloadDocs] = useLoad(() => (tab === 'documents' ? call('listDocuments') : Promise.resolve(null)), [app.version, tab]);
  const [q, setQ] = useState({ items: [], running: false });
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => subscribe(setQ), []);
  const threshold = app.settings.autoApproveConfidence || 90;
  const pendingList = tab === 'pending' ? items || [] : [];
  const safeCount = pendingList.filter((it) => it.proposals.length && it.proposals.every((p) => isSafe(p, it.parsed, threshold))).length;

  const onFiles = (files) => {
    const n = addFiles(files);
    if (!n) toast('No PDF or image files found');
  };
  const drop = async (e) => {
    e.preventDefault(); setOver(false);
    onFiles(await filesFromDrop(e.dataTransfer));
  };
  const approveSafe = async () => {
    setBusy(true);
    try {
      const r = await call('approveAllSafe');
      toast(r.items ? `Approved ${plural(r.items, 'letter')} (${plural(r.changes, 'change')})` : 'No safe letters to approve', r.items ? 'ok' : '');
      app.refresh();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const done = q.items.filter((i) => !['queued', 'working'].includes(i.status));
  const working = q.items.filter((i) => ['queued', 'working'].includes(i.status));
  const tabs = [['pending', 'To review'], ['info', 'Supporting docs'], ['applied', 'Applied'], ['rejected', 'Rejected'], ['documents', 'All files']];

  return html`
    <div class="page-head"><div><h1>LOA inbox</h1><p>Drop letters here. Each one is read on this computer, split into letters, and matched to your records. You approve the changes.</p></div>
      <div class="row">${safeCount ? html`<button class="btn primary" disabled=${busy} onClick=${approveSafe} title="Apply letters where every change is a confident match with no warnings"><${Icon} name="check" /> Approve ${safeCount} safe</button>` : null}
      <button class="btn" onClick=${async () => { try { const n = await call('rematch'); toast(`Re-matched ${plural(n, 'letter')}`); app.refresh(); } catch (e) { toastError(e); } }} title="Run matching again, e.g. after adding records or aliases"><${Icon} name="refresh" /> Re-match</button></div></div>

    <div class=${`drop ${over ? 'over' : ''}`} onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${drop}
      style=${pendingList.length ? 'padding:16px' : ''}>
      <div class=${pendingList.length ? 'row between' : ''}>
        <div class=${pendingList.length ? 'row' : ''}><${Icon} name="upload" />
          <div style=${pendingList.length ? 'text-align:left' : ''}><h3>Drop LOAs or a whole folder here</h3><div class="muted small">PDF, scanned PDF, PNG, JPG or TIFF · merged PDFs are split into letters · duplicates are skipped</div></div></div>
        <div style=${pendingList.length ? '' : 'margin-top:14px;display:flex;justify-content:center'}><${FilePickers} onFiles=${onFiles} compact=${!!pendingList.length} /></div>
      </div>
    </div>

    ${q.items.length ? html`<div class="card queue"><div class="hd"><h3>${working.length ? html`<span class="row"><${Spinner} /> Reading ${plural(working.length, 'file')}…</span>` : `Finished ${plural(done.length, 'file')}`}</h3>
        ${done.length && !working.length ? html`<button class="btn sm ghost" onClick=${clearFinished}>Clear</button>` : null}</div>
      <div class="bd">${q.items.slice(-60).reverse().map((it) => html`<div class="qitem" key=${it.id}>
        <${Icon} name=${it.status === 'done' ? 'check' : it.status === 'error' || it.status === 'unreadable' ? 'warn' : it.status === 'duplicate' ? 'link' : 'file'} />
        <div class="grow"><div class="ellipsis"><b>${it.name}</b> <span class="faint small">${bytes(it.size)}</span></div>
          <div class=${`small ${it.status === 'error' || it.status === 'unreadable' ? '' : 'muted'}`} style=${it.status === 'error' || it.status === 'unreadable' ? 'color:var(--bad)' : ''}>${it.note}</div>
          ${it.status === 'working' ? html`<div class="bar mt" style="margin-top:4px"><i style=${`width:${Math.round(it.progress * 100)}%`}></i></div>` : null}</div>
      </div>`)}</div></div>` : null}

    <div class="tabs mt-l">${tabs.map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}${k === 'pending' && app.counts.inbox ? html`<span class="count">${app.counts.inbox}</span>` : null}</button>`)}</div>
    ${tab === 'documents' ? html`<${Documents} docs=${docs} app=${app} reload=${reloadDocs} />`
      : !items ? html`<div class="row"><${Spinner} /> Loading…</div>`
        : !items.length ? html`<div class="card"><div class="empty"><${Icon} name="inbox" /><h3>${tab === 'pending' ? 'Nothing to review' : 'Nothing here yet'}</h3><div>${tab === 'pending' ? 'Drop LOAs above to get started.' : ''}</div></div></div>`
          : items.map((it) => html`<${Review} key=${it.id} it=${it} app=${app} threshold=${threshold} readOnly=${tab !== 'pending'} onDone=${() => { reload(); app.refresh(); }} />`)}`;
}

function Review({ it, app, threshold, readOnly, onDone }) {
  const L = it.parsed;
  const [checked, setChecked] = useState(() => it.proposals.map((p) => p.action !== 'unmatched' && !(p.warnings || []).some((w) => /Confirm it covers/.test(w))));
  const [edits, setEdits] = useState(() => it.proposals.map(() => ({})));
  const [picks, setPicks] = useState(() => it.proposals.map(() => []));
  const [editing, setEditing] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(null);
  const safe = it.proposals.length && it.proposals.every((p) => isSafe(p, L, threshold));

  const approve = async () => {
    const decisions = it.proposals.map((p, i) => ({ index: i, edits: edits[i], recordIds: picks[i] })).filter((d, i) => checked[i] && (it.proposals[i].action !== 'unmatched' || picks[i].length));
    if (!decisions.length) return toast('Tick at least one change, or reject the letter');
    setBusy(true);
    try {
      const res = await call('applyInbox', it.id, decisions);
      toast(`Applied: ${summarize(res)}`, 'ok');
      onDone();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const reject = async () => {
    setBusy(true);
    try { await call('rejectInbox', it.id, ''); toast('Letter rejected; no records changed'); onDone(); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const aiFill = async () => {
    setBusy(true);
    try {
      const r = await call('assistInbox', it.id);
      toast(r.changed ? 'AI suggested missing values. Check them before approving.' : (r.message || 'The AI found nothing more in this letter.'));
      onDone();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const showText = async () => {
    try { setText(await call('documentText', it.document_id)); } catch (e) { toastError(e); }
  };
  const missing = !val(L.expiryDate) || !L.products.length;
  const confCls = L.confidence >= 85 ? 'good' : L.confidence >= 60 ? 'warning' : 'expired';

  return html`<div class="card review"><div class="hd"><div class="grow">
      <div class="row wrap"><h3>${letterTitle(L)}</h3>
        <span class="pill brand">${L.scheme || 'Unknown brand'}</span><span class="tag">${L.category}</span>
        <span class=${`pill ${confCls}`} title="How sure the reader is about the extracted values">${L.confidence}% confident</span>
        ${safe && !readOnly ? html`<span class="pill good"><${Icon} name="shield" size="12" /> Safe to auto-approve</span>` : null}
        ${it.status !== 'pending' ? html`<span class="tag">${it.status}${it.decided_at ? ` · ${fmtWhen(it.decided_at)}` : ''}</span>` : null}</div>
      <div class="muted small mt" style="margin-top:4px"><${Icon} name="file" size="12" /> ${it.filename}${L.pageStart ? ` · page ${L.pageStart}${L.pageEnd && L.pageEnd !== L.pageStart ? `–${L.pageEnd}` : ''}` : ''}</div></div>
    <div class="row"><button class="btn sm ghost" onClick=${showText}><${Icon} name="eye" /> Text</button>
      ${isDesktop ? html`<button class="btn sm ghost" onClick=${() => native('openDocument', { id: it.document_id }).catch(toastError)}><${Icon} name="file" /> Open PDF</button>` : null}</div></div>
    <div class="bd">
      <div class="facts">
        <${Fact} k="Device(s)" v=${L.products.map((p) => p.value).join(', ')} ev=${L.products[0] && L.products[0].evidence} />
        <${Fact} k="Approval number" v=${val(L.approvalNumber)} ev=${L.approvalNumber && L.approvalNumber.evidence} optional />
        <${Fact} k="Issued" v=${fmtDate(val(L.issueDate))} ev=${L.issueDate && L.issueDate.evidence} optional />
        <${Fact} k="Expires" v=${fmtDate(val(L.expiryDate))} ev=${L.expiryBasis || (L.expiryDate && L.expiryDate.evidence)} />
        ${val(L.kernelVersion) ? html`<${Fact} k="Kernel / version" v=${val(L.kernelVersion)} />` : null}
        ${L.restricted ? html`<${Fact} k="Restriction" v="Restricted / final extension" />` : null}
      </div>
      ${(L.warnings || []).map((w) => html`<div class="warnline"><${Icon} name="warn" />${w}</div>`)}
      ${L.informational ? html`<div class="callout mt">Supporting document (${L.type || 'bulletin'}). It is kept in the archive and searchable, but does not change any dates.</div>` : null}
      ${!it.proposals.length && !L.informational ? html`<div class="callout warn mt">No matching records for this letter's brand and approval type. Import your tracker or portal page first, add the record by hand, or add a device alias in Settings, then press Re-match.</div>` : null}
      ${it.proposals.map((p, i) => html`<${Proposal} key=${i} p=${p} on=${checked[i]} readOnly=${readOnly} edits=${edits[i]} editing=${editing === i} picks=${picks[i]} app=${app}
        onToggle=${() => setChecked(checked.map((c, j) => (j === i ? !c : c)))} onEdit=${() => setEditing(editing === i ? -1 : i)}
        onEdits=${(e) => setEdits(edits.map((x, j) => (j === i ? { ...x, ...e } : x)))}
        onPicks=${(ids) => { setPicks(picks.map((x, j) => (j === i ? ids : x))); setChecked(checked.map((c, j) => (j === i ? ids.length > 0 : c))); }} />`)}
      ${readOnly ? null : html`<div class="row mt-l">
        ${it.proposals.length ? html`<button class="btn primary" disabled=${busy} onClick=${approve}><${Icon} name="check" /> Approve ${plural(checked.filter(Boolean).length, 'change')}</button>` : null}
        <button class="btn" disabled=${busy} onClick=${reject}>${it.proposals.length ? 'Reject' : 'Dismiss'}</button>
        ${missing && !L.informational ? html`<button class="btn" disabled=${busy} onClick=${aiFill} title="Ask the local AI to find missing values; it may only use text present in the letter"><${Icon} name="spark" /> AI: find missing values</button>` : null}
        <span class="grow"></span>${busy ? html`<${Spinner} />` : null}</div>`}
    </div>
    ${text != null ? html`<${Modal} title=${it.filename} wide onClose=${() => setText(null)}><div class="excerpt" style="max-height:66vh">${text}</div><//>` : null}
  </div>`;
}

const DOC_TYPES = { bulletin: 'Product configuration bulletin', loe: 'Letter of equivalency', tqm: 'TQM statement', pci: 'PCI PTS approval' };
function letterTitle(L) {
  const kind = DOC_TYPES[L.type] || (L.informational ? 'Supporting document' : 'Letter of approval');
  return L.issuer && L.issuer !== 'Manufacturer' ? `${L.issuer} ${kind.toLowerCase()}` : kind;
}

function Fact({ k, v, ev, optional }) {
  return html`<div class="fact"><div class="k">${k}</div><div class=${`v ${v ? '' : 'miss'}`}>${v || (optional ? '—' : 'Not found')}</div>${ev ? html`<div class="ev" title=${ev}>${ev}</div>` : null}</div>`;
}

function Proposal({ p, on, readOnly, edits, editing, picks, app, onToggle, onEdit, onEdits, onPicks }) {
  const a = ACTION[p.action] || { label: p.action, cls: '' };
  const changes = Object.entries(p.changes || {});
  const editable = ['update', 'replacement', 'create'].includes(p.action);
  const fields = p.action === 'create' ? ['device', 'platform', 'bundle', 'approval_number', 'issue_date', 'expiry_date'] : ['approval_number', 'issue_date', 'expiry_date'];
  const base = p.action === 'create' ? p.record : p.action === 'replacement' ? p.replacement : Object.fromEntries(changes.map(([k, v]) => [k, v.to]));
  return html`<div class=${`prop ${on ? '' : 'off'}`}>
    <div>${readOnly ? null : html`<input type="checkbox" checked=${on} onChange=${onToggle} aria-label="Include this change" />`}</div>
    <div>
      <div class="row wrap"><span class=${`pill ${a.cls}`}>${a.label}</span>
        ${p.record_id ? html`<a onClick=${() => app.openRecord(p.record_id)}><b>${p.device}</b></a>` : html`<b>${p.device}</b>`}
        <span class="muted small">${[p.platform, p.bundle].filter(Boolean).join(' · ')}</span>
        ${p.score ? html`<span class="faint small">match ${p.score}%</span>` : null}
        <span class="grow"></span>${editable && !readOnly ? html`<button class="btn sm ghost" onClick=${onEdit}><${Icon} name="edit" /> ${editing ? 'Done' : 'Edit values'}</button>` : null}</div>
      ${p.note ? html`<div class="small muted mt" style="margin-top:4px">${p.note}</div>` : null}
      ${changes.length ? html`<div class="chg">${changes.map(([k, v]) => html`<div>${FIELD[k] || k}: ${v.from !== '' && v.from != null ? html`<s>${fmt(k, v.from)}</s> → ` : ''}<b>${fmt(k, edits[k] != null ? edits[k] : v.to)}</b></div>`)}</div>` : null}
      ${p.action === 'replacement' ? html`<div class="chg">New approval ${p.replacement.approval_number || ''}: effective <b>${fmtDate(edits.issue_date || p.replacement.issue_date)}</b>, expires <b>${fmtDate(edits.expiry_date || p.replacement.expiry_date)}</b>. The current approval stays in force until then.</div>` : null}
      ${p.action === 'create' ? html`<div class="chg">Creates <b>${edits.device || p.record.device}</b> · ${p.scheme} ${p.category}${(edits.expiry_date || p.record.expiry_date) ? html`, expires <b>${fmtDate(edits.expiry_date || p.record.expiry_date)}</b>` : ''}${edits.platform || edits.bundle ? ` · ${[edits.platform, edits.bundle].filter(Boolean).join(' · ')}` : ''}</div>` : null}
      ${(p.warnings || []).map((w) => html`<div class="warnline"><${Icon} name="warn" />${w}</div>`)}
      ${editing ? html`<div class="grid3 mt">${fields.map((k) => html`<label class="field">${{ device: 'Device', platform: 'Platform', bundle: 'Bundle' }[k] || FIELD[k]}
        <input type=${k.endsWith('_date') ? 'date' : 'text'} value=${edits[k] != null ? edits[k] : (base && base[k]) || ''} onInput=${(e) => onEdits({ [k]: e.target.value })} /></label>`)}</div>` : null}
      ${p.action === 'unmatched' && !readOnly ? html`<${RecordPicker} p=${p} picks=${picks} onPicks=${onPicks} />` : null}
    </div></div>`;
}

function fmt(k, v) {
  if (k.endsWith('_date')) return fmtDate(v) || '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return v === '' || v == null ? '—' : String(v);
}

function RecordPicker({ p, picks, onPicks }) {
  const [records] = useLoad(() => call('listRecords'), []);
  const [q, setQ] = useState('');
  // Devices from the same family ("Self/5XXX" -> "Self/...") are listed first.
  const fam = String(p.device).split(/[/\s]/)[0].toLowerCase();
  const list = useMemo(() => (records || []).filter((r) => !r.archived && r.category === p.category && r.scheme.toLowerCase() === String(p.scheme).toLowerCase()
    && (!q || recLabel(r).toLowerCase().includes(q.toLowerCase()) || String(r.platform).toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => (b.device.toLowerCase().startsWith(fam) - a.device.toLowerCase().startsWith(fam)) || a.device.localeCompare(b.device, undefined, { numeric: true })), [records, q]);
  const set = new Set(picks);
  const toggle = (id) => { if (set.has(id)) set.delete(id); else set.add(id); onPicks([...set]); };
  return html`<div class="mt"><div class="row"><input type="search" placeholder="Filter devices" value=${q} onInput=${(e) => setQ(e.target.value)} />
    <button class="btn sm" onClick=${() => onPicks(list.map((r) => r.id))}>Select all ${list.length}</button><button class="btn sm ghost" onClick=${() => onPicks([])}>None</button></div>
    <div style="max-height:200px;overflow:auto;margin-top:8px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;background:var(--panel)">
      ${list.length ? list.map((r) => html`<label class="check small" style="display:flex;padding:3px 0"><input type="checkbox" checked=${set.has(r.id)} onChange=${() => toggle(r.id)} />
        <b>${r.device}</b><span class="muted">${[r.platform, r.bundle].filter(Boolean).join(' · ')}</span><span class="faint">expires ${fmtDate(r.expiry_date) || '—'}</span></label>`)
        : html`<div class="muted small">No ${p.scheme} ${p.category} records.</div>`}</div></div>`;
}

function summarize(res) {
  const c = {};
  for (const r of res) c[r.action] = (c[r.action] || 0) + 1;
  return Object.entries(c).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing changed';
}

function Documents({ docs, app }) {
  const [text, setText] = useState(null);
  const [q, setQ] = useState('');
  if (!docs) return html`<div class="row"><${Spinner} /> Loading…</div>`;
  const list = docs.filter((d) => !q || d.filename.toLowerCase().includes(q.toLowerCase()));
  if (!docs.length) return html`<div class="card"><div class="empty"><${Icon} name="file" /><h3>No documents yet</h3></div></div>`;
  return html`<div class="filters"><input type="search" placeholder="Filter files" value=${q} onInput=${(e) => setQ(e.target.value)} /><span class="muted small">${plural(list.length, 'file')} archived in your data folder</span></div>
    <div class="table-wrap"><table class="t"><thead><tr><th>File</th><th>Added</th><th class="num">Pages</th><th class="num">OCR</th><th class="num">Linked records</th><th class="num">To review</th><th></th></tr></thead>
    <tbody>${list.map((d) => html`<tr key=${d.id}><td class="dev">${d.filename}</td><td class="small nowrap">${fmtWhen(d.uploaded_at)}</td><td class="num">${d.page_count}</td><td class="num">${d.ocr_pages || '–'}</td>
      <td class="num">${d.links || '–'}</td><td class="num">${d.pending || '–'}</td>
      <td class="nowrap"><button class="btn sm ghost" onClick=${async () => { try { setText({ name: d.filename, text: await call('documentText', d.id) }); } catch (e) { toastError(e); } }}>Text</button>
      ${isDesktop ? html`<button class="btn sm ghost" onClick=${() => native('openDocument', { id: d.id }).catch(toastError)}>Open</button>` : null}</td></tr>`)}</tbody></table></div>
    ${text ? html`<${Modal} title=${text.name} wide onClose=${() => setText(null)}><div class="excerpt" style="max-height:66vh">${text.text}</div><//>` : null}`;
}
