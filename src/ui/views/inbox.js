import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { html, Icon, fmtDate, fmtWhen, plural, useLoad, Spinner, toast, toastError, Modal, bytes, recLabel } from '../lib.js';
import { call } from '../api.js';
import { subscribe, addFiles, clearFinished, filesFromDrop } from '../queue.js';
import { DocButtons, openDoc } from '../docs.js';
import { addRecent, recentIds, clearRecent, onRecent } from '../recent.js';

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
    <input ref=${files} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp,.txt,.xlsx,.xlsm,.csv" class="hidden" onChange=${pick} />
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
  const [recent, setRecent] = useState(recentIds);
  const [sel, setSel] = useState(() => new Set());
  const [find, setFind] = useState('');
  const [dup, setDup] = useState(null);
  useEffect(() => onRecent(setRecent), []);
  useEffect(() => subscribe(setQ), []);
  const threshold = app.settings.autoApproveConfidence || 90;
  const pendingList = tab === 'pending' ? items || [] : [];
  const shown = (items || []).filter((it) => !find || cardText(it).includes(find.toLowerCase()));
  const toggleSel = (id) => setSel((s0) => { const s1 = new Set(s0); if (s1.has(id)) s1.delete(id); else s1.add(id); return s1; });
  const safeCount = pendingList.filter((it) => it.proposals.length && it.proposals.every((p) => isSafe(p, it.parsed, threshold))).length;

  const [sheets, setSheets] = useState([]);
  const onFiles = (files) => {
    // Spreadsheets dropped here are trackers to import, not letters to read.
    const xl = files.filter((f) => /\.(xlsx|xlsm|csv)$/i.test(f.name));
    if (xl.length) setSheets((q0) => [...q0, ...xl]);
    // Once the previous drop is fully reviewed, a new drop starts a new "Bulk edit these" batch.
    if (!app.counts.inbox && !q.items.some((i) => i.status === 'queued' || i.status === 'working')) clearRecent();
    const n = addFiles(files.filter((f) => !xl.includes(f)));
    if (!n && !xl.length) toast('No PDF, image or spreadsheet files found');
  };
  const drop = async (e) => {
    e.preventDefault(); setOver(false);
    onFiles(await filesFromDrop(e.dataTransfer));
  };
  const approveSafe = async () => {
    setBusy(true);
    try {
      const r = await call('approveAllSafe');
      addRecent(r.recordIds);
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
          <div style=${pendingList.length ? 'text-align:left' : ''}><h3>Drop LOAs or a whole folder here</h3><div class="muted small">PDF, scanned PDF, PNG, JPG or TIFF · merged PDFs are split into letters · duplicates are skipped · Excel/CSV trackers are imported</div></div></div>
        <div style=${pendingList.length ? '' : 'margin-top:14px;display:flex;justify-content:center'}><${FilePickers} onFiles=${onFiles} compact=${!!pendingList.length} /></div>
      </div>
    </div>

    ${recent.length ? html`<div class="callout good row recent-bar"><${Icon} name="check" /><span class="grow"><b>${plural(recent.length, 'record')}</b> created or updated from LOAs. Set their platform, bundle, tags or owner in one go.</span>
      <button class="btn sm primary" onClick=${() => app.go('register', { filter: { ids: recent, idsLabel: 'from LOA review' }, select: true })}><${Icon} name="edit" /> Bulk edit these</button>
      <button class="btn sm ghost" onClick=${clearRecent} title="Start a new batch">Clear</button></div>` : null}

    ${q.items.length ? html`<div class="card queue"><div class="hd"><h3>${working.length ? html`<span class="row"><${Spinner} /> Reading ${plural(working.length, 'file')}…</span>` : `Finished ${plural(done.length, 'file')}`}</h3>
        ${done.length && !working.length ? html`<button class="btn sm ghost" onClick=${clearFinished}>Clear</button>` : null}</div>
      <div class="bd">${q.items.slice(-60).reverse().map((it) => html`<div class="qitem" key=${it.id}>
        <${Icon} name=${it.status === 'done' ? 'check' : it.status === 'error' || it.status === 'unreadable' ? 'warn' : it.status === 'duplicate' ? 'link' : 'file'} />
        <div class="grow"><div class="ellipsis"><b>${it.name}</b> <span class="faint small">${bytes(it.size)}</span></div>
          <div class=${`small ${it.status === 'error' || it.status === 'unreadable' ? '' : 'muted'}`} style=${it.status === 'error' || it.status === 'unreadable' ? 'color:var(--bad)' : ''}>${it.note}</div>
          ${it.status === 'working' ? html`<div class="bar mt" style="margin-top:4px"><i style=${`width:${Math.round(it.progress * 100)}%`}></i></div>` : null}</div>
        ${it.status === 'duplicate' && it.result && it.result.documentId ? html`<button class="btn sm" onClick=${() => setDup(it.result.documentId)}
          title="Link this LOA to another device or reader version, e.g. the CL2 record"><${Icon} name="link" /> Map to another device…</button>` : null}
      </div>`)}</div></div>` : null}
    ${dup ? html`<${MapDuplicate} documentId=${dup} app=${app} onClose=${() => setDup(null)} />` : null}

    <div class="tabs mt-l">${tabs.map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}${k === 'pending' && app.counts.inbox ? html`<span class="count">${app.counts.inbox}</span>` : null}</button>`)}</div>
    ${tab === 'documents' ? html`<${Documents} docs=${docs} app=${app} reload=${reloadDocs} />`
      : !items ? html`<div class="row"><${Spinner} /> Loading…</div>`
        : !items.length ? html`<div class="card"><div class="empty"><${Icon} name="inbox" /><h3>${tab === 'pending' ? 'Nothing to review' : 'Nothing here yet'}</h3><div>${tab === 'pending' ? 'Drop LOAs above to get started.' : ''}</div></div></div>`
          : html`${tab === 'pending' ? html`<${BulkBar} items=${shown} all=${items} sel=${sel} setSel=${setSel} find=${find} setFind=${setFind} app=${app} onDone=${() => { reload(); app.refresh(); }} />` : null}
            ${shown.map((it) => html`<${Review} key=${`${it.id}:${proposalSig(it)}:${JSON.stringify(it.parsed.recordDefaults || {})}`} it=${it} app=${app} threshold=${threshold} readOnly=${tab !== 'pending'}
              selected=${sel.has(it.id)} onSelect=${tab === 'pending' ? () => toggleSel(it.id) : null} onDone=${() => { reload(); app.refresh(); }} />`)}`}
    ${sheets.length ? html`<${SheetImport} file=${sheets[0]} app=${app} onClose=${() => setSheets((q0) => q0.slice(1))} />` : null}`;
}

/**
 * A dropped LOA that is already in the app. It is never added twice, but it
 * can be mapped to more records: another reader version of the same device
 * (Lane/5000-CL3 next to Lane/5000-CL2), an existing record, or a new device.
 */
function MapDuplicate({ documentId, app, onClose }) {
  const [info] = useLoad(() => call('duplicateInfo', documentId), [documentId]);
  const [picks, setPicks] = useState(new Set());
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const known = useKnownDevices();
  if (!info) return html`<${Modal} title="Duplicate LOA" onClose=${onClose}><div class="row"><${Spinner} /> Loading…</div><//>`;
  const v = info.values;
  const dates = v ? [v.approval_number, v.expiry_date && `expires ${fmtDate(v.expiry_date)}`].filter(Boolean).join(' · ') : '';
  const toggle = (id) => { const n = new Set(picks); if (n.has(id)) n.delete(id); else n.add(id); setPicks(n); };
  const save = async () => {
    setBusy(true);
    try {
      const r = await call('mapDuplicate', documentId, { recordIds: [...picks], create: name.trim() ? [name.trim()] : [] });
      addRecent(r.recordIds);
      toast(`Linked to ${plural(r.linked, 'more record')}`, 'ok');
      app.refresh();
      onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return html`<${Modal} title="Duplicate LOA: map it to another device" onClose=${onClose}>
    <p><b>${info.document.filename}</b> is already in the app, so it was not added again.${info.linkedTo.length ? ' It is linked to:' : ' No record uses it yet.'}</p>
    ${info.linkedTo.length ? html`<ul class="small">${info.linkedTo.map((x) => html`<li>${x.device} · ${x.scheme} ${x.category}${x.platform ? ` · ${[x.platform, x.bundle].filter(Boolean).join(' ')}` : ''}</li>`)}</ul>` : null}
    ${dates ? html`<p class="muted small">The letter gives ${dates}. Records you link below get these values; their old approval stays in history.</p>` : null}
    ${info.suggestions.length ? html`<h4 class="mt">Other versions of this device</h4>
      <div class="col">${info.suggestions.map((x) => html`<label class="row small"><input type="checkbox" checked=${picks.has(x.id)} onChange=${() => toggle(x.id)} />
        ${x.device} · ${x.scheme} ${x.category}${x.platform ? html` <span class="faint">${[x.platform, x.bundle].filter(Boolean).join(' ')}</span>` : null}</label>`)}</div>` : null}
    ${info.linkedTo.length ? html`<h4 class="mt">Or add it to a device with no record yet</h4>
      <input type="text" aria-label="Device name for a new record" placeholder="Device name, e.g. Lane/5000-CL3" value=${name} onInput=${(e) => setName(e.target.value)} />
      <${DeviceSuggestions} known=${known} q=${name} skip=${[name]} onPick=${setName} />` : null}
    <div class="row mt"><button class="btn primary" disabled=${busy || (!picks.size && !name.trim())} onClick=${save}><${Icon} name="link" /> Link LOA</button>
      <button class="btn" onClick=${onClose}>Keep as is</button></div><//>`;
}

/** Changes when matching or the AI rebuilds a letter's proposals, so its card starts fresh. */
function proposalSig(it) {
  return it.proposals.map((p) => `${p.action}:${p.record_id || p.device || ''}`).join('|');
}

/** What a card can be found by: file name, devices, brand, type, platform. */
function cardText(it) {
  const L = it.parsed;
  return [it.filename, L.scheme, L.category, ...(L.products || []).map((p) => p.value), ...(it.proposals || []).map((p) => `${p.device} ${p.platform || ''}`),
    (L.recordDefaults || {}).platform, (L.recordDefaults || {}).bundle].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Work on many letters at once: pick them (or filter and select all), set
 * the platform/bundle for the records they create, then approve or reject.
 */
function BulkBar({ items, all, sel, setSel, find, setFind, app, onDone }) {
  const [platform, setPlatform] = useState('');
  const [bundle, setBundle] = useState('');
  const [busy, setBusy] = useState(false);
  const [opts] = useLoad(() => call('listRecords').then((rs) => ({
    platforms: [...new Set(rs.map((r) => r.platform).filter(Boolean))].sort(),
    bundles: [...new Set(rs.map((r) => r.bundle).filter(Boolean))].sort(),
  })), []);
  const ids = [...sel].filter((id) => all.some((it) => it.id === id));
  const allShown = items.length && items.every((it) => sel.has(it.id));
  const run = async (fn) => { setBusy(true); try { await fn(); } catch (e) { toastError(e); } finally { setBusy(false); } };
  const setFields = () => run(async () => {
    const f = {};
    if (platform.trim()) f.platform = platform.trim();
    if (bundle.trim()) f.bundle = bundle.trim();
    if (!Object.keys(f).length) return toast('Type a platform or bundle first');
    const n = await call('setInboxDefaults', ids, f);
    toast(`Set ${Object.entries(f).map(([k, v]) => `${k} ${v}`).join(', ')} on ${plural(n, 'letter')}`, 'ok');
    onDone();
  });
  const approve = () => run(async () => {
    const r = await call('approveInboxMany', ids);
    addRecent(r.recordIds);
    const left = r.skipped.length ? ` ${plural(r.skipped.length, 'letter')} still need you: ${r.skipped.slice(0, 3).map((x) => `${x.filename} (${x.reason})`).join('; ')}${r.skipped.length > 3 ? '…' : ''}` : '';
    toast(`Approved ${plural(r.applied, 'letter')} (${plural(r.changes, 'change')}).${left}`, r.applied ? 'ok' : '');
    setSel(new Set(r.skipped.map((x) => x.id)));
    onDone();
  });
  const reject = () => run(async () => {
    if (!confirm(`Reject ${plural(ids.length, 'letter')}? No records will change.`)) return;
    const n = await call('rejectInboxMany', ids);
    toast(`Rejected ${plural(n, 'letter')}`);
    setSel(new Set());
    onDone();
  });
  const reread = () => run(async () => {
    const r = await call('rereadInbox', ids);
    toast(`Read ${plural(r.documents, 'file')} again: ${plural(r.letters, 'letter')} to review${r.removed > r.letters ? `, ${plural(r.removed - r.letters, 'leftover page')} cleared` : ''}`, 'ok');
    setSel(new Set());
    onDone();
  });
  return html`<div class="card pad inbox-bulk">
    <div class="row wrap">
      <label class="check"><input type="checkbox" checked=${allShown} onChange=${() => setSel(allShown ? new Set() : new Set([...sel, ...items.map((it) => it.id)]))} aria-label="Select all shown" />
        ${allShown ? 'Clear selection' : `Select all ${items.length}${find ? ' shown' : ''}`}</label>
      <input type="search" placeholder="Find letters: file name, device, brand, platform" value=${find} onInput=${(e) => setFind(e.target.value)} class="grow" aria-label="Find letters" />
      <b class="small nowrap">${ids.length} selected</b>
    </div>
    ${ids.length ? html`<div class="row wrap mt">
      <input type="text" list="inbox-platforms" placeholder="Platform, e.g. UPP" value=${platform} onInput=${(e) => setPlatform(e.target.value)} aria-label="Platform for selected" style="width:170px" />
      <input type="text" list="inbox-bundles" placeholder="Bundle (optional)" value=${bundle} onInput=${(e) => setBundle(e.target.value)} aria-label="Bundle for selected" style="width:170px" />
      <button class="btn" disabled=${busy} onClick=${setFields}>Set on ${ids.length}</button>
      <span class="grow"></span>
      <button class="btn primary" disabled=${busy} onClick=${approve} title="Apply each letter's suggested changes. Letters that need a choice stay here."><${Icon} name="check" /> Approve ${ids.length}</button>
      <button class="btn" disabled=${busy} onClick=${reject}>Reject ${ids.length}</button>
      <button class="btn ghost" disabled=${busy} onClick=${reread} title="Read these files again with the latest reader. Letters you already approved are not offered again."><${Icon} name="refresh" /> Read again</button>
      ${busy ? html`<${Spinner} />` : null}
      <datalist id="inbox-platforms">${((opts && opts.platforms) || []).map((v) => html`<option value=${v} />`)}</datalist>
      <datalist id="inbox-bundles">${((opts && opts.bundles) || []).map((v) => html`<option value=${v} />`)}</datalist>
    </div>
    <div class="faint small mt">The platform and bundle go on the records these letters create, and fill them on matched records that have none.</div>` : null}
  </div>`;
}

/** Import a tracker spreadsheet dropped into the inbox, after a preview. */
function SheetImport({ file, app, onClose }) {
  const [preview, setPreview] = useState(null);
  const [bytesIn, setBytes] = useState(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const b = new Uint8Array(await file.arrayBuffer());
        const pv = await call('importTracker', { filename: file.name, bytes: b, dryRun: true });
        if (live) { setBytes(b); setPreview(pv); }
      } catch (e) { toastError(e); onClose(); } finally { if (live) setBusy(false); }
    })();
    return () => { live = false; };
  }, [file]);
  const apply = async () => {
    setBusy(true);
    try {
      const r = await call('importTracker', { filename: file.name, bytes: bytesIn, dryRun: false });
      toast(`Imported ${file.name}: ${r.added} new, ${r.updated} updated`, 'ok');
      app.refresh();
      onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return html`<${Modal} title=${`Import ${file.name}`} onClose=${onClose}>
    <p class="muted small">Spreadsheets are imported as records (a tracker), not read as letters. Re-importing is safe: your manual edits and newer dates are never overwritten.</p>
    ${!preview ? html`<div class="row"><${Spinner} /> Reading the spreadsheet…</div>` : html`
      <div class="callout"><b>${plural(preview.added, 'new record')}, ${plural(preview.updated, 'update')}</b>${preview.skipped ? html` · <span class="muted">${plural(preview.skipped, 'row')} skipped</span>` : null}
        ${(preview.sheets || []).filter((sh) => sh.rows).map((sh) => html`<div class="small muted mt">${sh.sheet}: ${plural(sh.rows, 'row')}, columns ${Object.entries(sh.mapping || {}).map(([k, v]) => `${v} → ${k}`).join(', ')}</div>`)}</div>
      <div class="row mt"><button class="btn primary" disabled=${busy} onClick=${apply}>Import</button><button class="btn" onClick=${onClose}>Cancel</button>${busy ? html`<${Spinner} />` : null}</div>`}
  <//>`;
}

function Review({ it, app, threshold, readOnly, selected, onSelect, onDone }) {
  const L = it.parsed;
  const defaults = L.recordDefaults || {};
  const [checked, setChecked] = useState(() => it.proposals.map((p) => p.action !== 'unmatched' && !(p.warnings || []).some((w) => /Confirm it covers/.test(w))));
  const [edits, setEdits] = useState(() => it.proposals.map(() => ({})));
  const [picks, setPicks] = useState(() => it.proposals.map(() => []));
  const [creates, setCreates] = useState(() => it.proposals.map(() => []));
  const [fresh, setFresh] = useState({ devices: [], edits: {} });
  const [editing, setEditing] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(null);
  const safe = it.proposals.length && it.proposals.every((p) => isSafe(p, L, threshold));

  const approve = async () => {
    const decisions = it.proposals.map((p, i) => ({ index: i, edits: edits[i], recordIds: picks[i], create: creates[i] }))
      .filter((d, i) => checked[i] && (it.proposals[i].action !== 'unmatched' || picks[i].length || creates[i].length));
    if (!it.proposals.length && fresh.devices.length) decisions.push({ create: fresh.devices, edits: fresh.edits });
    if (!decisions.length) return toast(it.proposals.length ? 'Tick at least one change, or reject the letter' : 'Add a device name to create its record, or dismiss the letter');
    setBusy(true);
    try {
      const res = await call('applyInbox', it.id, decisions);
      addRecent(res.map((x) => x.record_id));
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

  return html`<div class=${`card review ${selected ? 'picked' : ''}`}><div class="hd">
    ${onSelect ? html`<input type="checkbox" class="pick" checked=${!!selected} onChange=${onSelect} aria-label="Select this letter" />` : null}<div class="grow">
      <div class="row wrap"><h3>${letterTitle(L)}</h3>
        <span class="pill brand">${L.scheme || 'Unknown brand'}</span><span class="tag">${L.category}</span>
        <span class=${`pill ${confCls}`} title="How sure the reader is about the extracted values">${L.confidence}% confident</span>
        ${safe && !readOnly ? html`<span class="pill good"><${Icon} name="shield" size="12" /> Safe to auto-approve</span>` : null}
        ${defaults.platform || defaults.bundle ? html`<span class="pill info" title="Platform/bundle for the records this letter creates">${[defaults.platform, defaults.bundle].filter(Boolean).join(' · ')}</span>` : null}
        ${it.status !== 'pending' ? html`<span class="tag">${it.status}${it.decided_at ? ` · ${fmtWhen(it.decided_at)}` : ''}</span>` : null}</div>
      <div class="muted small mt" style="margin-top:4px"><${Icon} name="file" size="12" /> ${it.filename}${L.pageStart ? ` · page ${L.pageStart}${L.pageEnd && L.pageEnd !== L.pageStart ? `–${L.pageEnd}` : ''}` : ''}</div></div>
    <div class="row"><button class="btn sm ghost" onClick=${showText}><${Icon} name="eye" /> Text</button>
      <button class="btn sm ghost" onClick=${() => openDoc({ id: it.document_id })}><${Icon} name="file" /> Open LOA</button></div></div>
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
      ${!it.proposals.length && !L.informational ? html`<div class="callout warn mt">No matching records for this letter's brand and approval type. Create the record below, import your tracker first, or add a device alias in Settings and press Re-match.</div>` : null}
      ${!it.proposals.length && !L.informational && !readOnly ? html`<${NewRecords} title="Create records from this letter" L=${L} names=${fresh.devices} edits=${fresh.edits} withFields
        onNames=${(devices) => setFresh({ ...fresh, devices })} onEdits=${(e) => setFresh({ ...fresh, edits: { ...fresh.edits, ...e } })} />` : null}
      ${it.proposals.map((p, i) => html`<${Proposal} key=${i} p=${{ ...p, defaults }} on=${!!checked[i]} readOnly=${readOnly} edits=${edits[i] || {}} editing=${editing === i} picks=${picks[i] || []} creates=${creates[i] || []} L=${L} app=${app}
        onToggle=${() => setChecked(checked.map((c, j) => (j === i ? !c : c)))} onEdit=${() => setEditing(editing === i ? -1 : i)}
        onEdits=${(e) => setEdits(edits.map((x, j) => (j === i ? { ...x, ...e } : x)))}
        onPicks=${(ids) => { setPicks(picks.map((x, j) => (j === i ? ids : x))); setChecked(checked.map((c, j) => (j === i ? ids.length + (creates[i] || []).length > 0 : c))); }}
        onCreates=${(names) => { setCreates(creates.map((x, j) => (j === i ? names : x))); setChecked(checked.map((c, j) => (j === i ? names.length + (picks[i] || []).length > 0 : c))); }} />`)}
      ${readOnly ? null : html`<div class="row mt-l">
        ${it.proposals.length ? html`<button class="btn primary" disabled=${busy} onClick=${approve}><${Icon} name="check" /> Approve ${plural(checked.filter(Boolean).length, 'change')}</button>`
          : !L.informational ? html`<button class="btn primary" disabled=${busy || !fresh.devices.length} onClick=${approve}><${Icon} name="check" /> Create ${plural(fresh.devices.length, 'record')}</button>` : null}
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

function Proposal({ p, on, readOnly, edits, editing, picks, creates, L, app, onToggle, onEdit, onEdits, onPicks, onCreates }) {
  const a = ACTION[p.action] || { label: p.action, cls: '' };
  const changes = Object.entries(p.changes || {});
  const editable = ['update', 'replacement', 'create'].includes(p.action);
  const fields = p.action === 'create' ? ['device', 'platform', 'bundle', 'approval_number', 'issue_date', 'expiry_date'] : ['approval_number', 'issue_date', 'expiry_date'];
  const base = p.action === 'create' ? { ...p.record, ...Object.fromEntries(Object.entries(p.defaults || {}).filter(([, v]) => v)) } : p.action === 'replacement' ? p.replacement : Object.fromEntries(changes.map(([k, v]) => [k, v.to]));
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
      ${p.action === 'create' ? html`<div class="chg">Creates <b>${edits.device || p.record.device}</b> · ${p.scheme} ${p.category}${(edits.expiry_date || p.record.expiry_date) ? html`, expires <b>${fmtDate(edits.expiry_date || p.record.expiry_date)}</b>` : ''}${(() => { const pl = [edits.platform || p.defaults.platform || p.record.platform, edits.bundle || p.defaults.bundle || p.record.bundle].filter(Boolean); return pl.length ? ` · ${pl.join(' · ')}` : ''; })()}</div>` : null}
      ${(p.warnings || []).map((w) => html`<div class="warnline"><${Icon} name="warn" />${w}</div>`)}
      ${editing ? html`<div class="grid3 mt">${fields.map((k) => html`<label class="field">${{ device: 'Device', platform: 'Platform', bundle: 'Bundle' }[k] || FIELD[k]}
        <input type=${k.endsWith('_date') ? 'date' : 'text'} value=${edits[k] != null ? edits[k] : (base && base[k]) || ''} onInput=${(e) => onEdits({ [k]: e.target.value })} /></label>`)}</div>
        ${p.action === 'create' && edits.device ? html`<${KnownFor} q=${edits.device} onPick=${(d) => onEdits({ device: d })} />` : null}` : null}
      ${p.action === 'unmatched' && !readOnly ? html`<${RecordPicker} p=${p} picks=${picks} onPicks=${onPicks} />
        <${NewRecords} title=${`Or create records for ${p.device}`} L=${L} names=${creates} edits=${edits} withFields onNames=${onCreates} onEdits=${onEdits} />` : null}
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

/**
 * Device names to add as new records, filled in from the letter (brand, type,
 * approval number and dates). Used when the records a letter covers do not exist yet.
 */
function NewRecords({ title, L, names, edits, withFields, onNames, onEdits }) {
  const [draft, setDraft] = useState('');
  const known = useKnownDevices();
  const add = (text = draft) => {
    const more = text.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
    if (!more.length) return;
    const seen = new Set(names.map((x) => x.toLowerCase()));
    onNames([...names, ...more.filter((x) => !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))]);
    setDraft('');
  };
  const needExpiry = !val(L.expiryDate);
  return html`<div class="newrecs mt"><div class="small"><b>${title}</b> <span class="muted">· ${L.scheme || 'Unknown brand'} ${L.category}${val(L.expiryDate) ? `, expires ${fmtDate(val(L.expiryDate))}` : ''}</span></div>
    <div class="row mt"><input type="text" class="grow" placeholder="Device name, e.g. Self/5000 (separate several with commas)" value=${draft}
      onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} aria-label="New device name" />
      <button class="btn sm" onClick=${() => add()} disabled=${!draft.trim()}><${Icon} name="plus" /> Add</button></div>
    <${DeviceSuggestions} known=${known} q=${draft.split(/[,;]/).pop()} skip=${names} onPick=${(d) => add(draft.replace(/[^,;]*$/, '') + d)} />
    ${names.length ? html`<div class="tagrow mt">${names.map((n) => html`<span class="utag">${n}<button class="linkbtn" title="Remove" onClick=${() => onNames(names.filter((x) => x !== n))}>×</button></span>`)}</div>` : null}
    ${!draft.trim() ? names.filter((n) => !known.some((d) => ckey(d.device) === ckey(n))).slice(0, 3).map((n) => html`<${DeviceSuggestions} known=${known} q=${n} skip=${names}
      label=${`Use a name you already have instead of ${n}?`} onPick=${(d) => onNames(names.map((x) => (x === n ? d : x)))} />`) : null}
    ${withFields && names.length ? html`<div class="grid3 mt">
      <label class="field">Platform<input type="text" value=${edits.platform || ''} onInput=${(e) => onEdits({ platform: e.target.value })} /></label>
      <label class="field">Bundle<input type="text" value=${edits.bundle || ''} onInput=${(e) => onEdits({ bundle: e.target.value })} /></label>
      <label class="field">${FIELD.expiry_date}${needExpiry ? ' (not in letter)' : ''}<input type="date" value=${edits.expiry_date || val(L.expiryDate) || ''} onInput=${(e) => onEdits({ expiry_date: e.target.value })} /></label>
    </div>` : null}</div>`;
}

let knownCache = null;
/** Device names already in the register (archived included), loaded once per inbox visit. */
function useKnownDevices() {
  const [list, setList] = useState(knownCache || []);
  useEffect(() => {
    let live = true;
    call('knownDevices').then((l) => { knownCache = l; if (live) setList(l); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return list;
}

function KnownFor({ q, onPick }) {
  const known = useKnownDevices();
  return html`<${DeviceSuggestions} known=${known} q=${q} skip=${[q]} onPick=${onPick} />`;
}

const ckey = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// "Move/5000-CL3" -> { fam: 'MOVE', num: '5000', cl: 'CL3' }; AXIUM is a range name, not a family.
function devParts(x) {
  const k = ckey(x).replace(/^AXIUM/, '');
  const cl = (k.match(/CL\d$/) || [''])[0];
  const body = cl ? k.slice(0, -cl.length) : k;
  const m = body.match(/^([A-Z]*)(\d{3,5})/);
  return { k, cl, fam: m ? m[1] : body.replace(/\d.*$/, ''), num: m ? m[2] : (body.match(/\d{3,5}/) || [''])[0] };
}
function editRatio(a, b) {
  if (!a || !b) return 0;
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return 1 - d[b.length] / Math.max(a.length, b.length);
}
/** How alike two device names are, 0-100: same model number and family count most, then the reader version. */
export function deviceLikeness(q, d) {
  const a = devParts(q), b = devParts(d);
  if (!a.k || !b.k) return 0;
  if (a.k === b.k) return 100;
  let s = 0;
  if (a.num && a.num === b.num) {
    s = a.fam && a.fam === b.fam ? 80 : !a.fam || !b.fam ? 65 : 45;
    if (a.cl && a.cl === b.cl) s += 10; else if (a.cl && b.cl) s -= 10; else if (!a.cl && !b.cl) s += 5;
  } else if (b.k.includes(a.k) || a.k.includes(b.k)) s = 60;
  else if (a.fam && a.fam === b.fam && a.num && b.num && a.num.slice(0, 2) === b.num.slice(0, 2)) s = 40;
  else if (a.fam && a.fam === b.fam && !a.num) s = 50;
  return Math.max(s, Math.round(editRatio(a.k, b.k) * 55));
}

/** Devices you already track that match what is being typed, so names stay consistent. */
function DeviceSuggestions({ known, q, skip = [], onPick, label = 'In your register:' }) {
  const key = ckey(q);
  if (key.length < 2) return null;
  const taken = new Set(skip.map((x) => ckey(x)));
  const hits = known.filter((d) => !taken.has(ckey(d.device)))
    .map((d) => ({ d, s: deviceLikeness(q, d.device) }))
    .filter((x) => x.s >= 40)
    .sort((x, y) => y.s - x.s || y.d.records - x.d.records)
    .slice(0, 8).map((x) => x.d);
  if (!hits.length) return html`<div class="faint small mt">No device like that in your register yet; it will be added as new.</div>`;
  return html`<div class="suggest mt"><span class="muted small">${label}</span>${hits.map((d) => html`<button class="sugg" onClick=${() => onPick(d.device)}
    title=${`${d.records} record${d.records === 1 ? '' : 's'}${d.archived ? `, ${d.archived} archived` : ''}${d.schemes.length ? ` · ${d.schemes.join(', ')}` : ''}`}>
    <b>${d.device}</b><span class="faint">${d.schemes.slice(0, 3).join(', ')}${d.schemes.length > 3 ? '…' : ''}${d.archived === d.records ? ' · archived' : ''}</span></button>`)}</div>`;
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
    <tbody>${list.map((d) => html`<tr key=${d.id}><td class="dev"><a href="#" onClick=${(e) => { e.preventDefault(); openDoc(d); }} title="Open">${d.filename}</a></td><td class="small nowrap">${fmtWhen(d.uploaded_at)}</td><td class="num">${d.page_count}</td><td class="num">${d.ocr_pages || '–'}</td>
      <td class="num">${d.links || '–'}</td><td class="num">${d.pending || '–'}</td>
      <td class="nowrap"><button class="btn sm ghost" onClick=${async () => { try { setText({ name: d.filename, text: await call('documentText', d.id) }); } catch (e) { toastError(e); } }}>Text</button>
      <${DocButtons} d=${d} compact /></td></tr>`)}</tbody></table></div>
    ${text ? html`<${Modal} title=${text.name} wide onClose=${() => setText(null)}><div class="excerpt" style="max-height:66vh">${text.text}</div><//>` : null}`;
}
