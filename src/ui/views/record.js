import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Drawer, Modal, fmtDate, fmtWhen, Spinner, toast, toastError, HealthPill, Select, daysLabel } from '../lib.js';
import { extractFile, LOA_EXTENSIONS } from '../extract.js';
import { call } from '../api.js';
import { DocButtons, openDoc } from '../docs.js';

const BLANK = {
  device: '', platform: '', bundle: '', family: '', category: 'EMV L1 Contact', scheme: '', kernel_version: '', approval_number: '',
  issue_date: '', expiry_date: '', expiry_basis: '', restricted: false, stage: '', disposition: '', owner: '', customer: '', market: '',
  next_action: '', next_action_date: '', extension_used: false, notes: '', portal_date: '', portal_status: 'Not Tracked', change_ticket: '', tags: '', covers: '', eol: '', renewal_path: '', test_lab: '', archived: false,
};

export function RecordDrawer({ id, app, onClose, tab: startTab }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(id ? null : { ...BLANK });
  const [tab, setTab] = useState(startTab || 'details');
  const [busy, setBusy] = useState(false);
  const tax = app.info.taxonomy;

  const load = async (rid) => {
    try {
      const d = await call('getRecord', rid);
      if (!d) { toast('That record no longer exists'); onClose(); return; }
      setData(d);
      setForm(Object.fromEntries(Object.keys(BLANK).map((k) => [k, d.record[k] == null ? BLANK[k] : d.record[k]])));
    } catch (e) { toastError(e); }
  };
  useEffect(() => { if (id) load(id); }, [id]);
  // Every certification of the physical device this record belongs to.
  const [profile, setProfile] = useState(null);
  const loadProfile = () => call('deviceProfile', id).then(setProfile).catch(() => setProfile(null));
  useEffect(() => { setProfile(null); if (id) loadProfile(); }, [id, app.version]);

  const set = (k) => (e) => setForm({ ...form, [k]: e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e });
  const save = async () => {
    if (!form.device.trim()) return toast('Device is required', 'err');
    if (!form.scheme.trim()) return toast('Brand is required', 'err');
    setBusy(true);
    try {
      const patch = { ...form };
      for (const k of ['issue_date', 'expiry_date', 'next_action_date', 'portal_date']) if (!patch[k]) patch[k] = null;
      const d = await call('saveRecord', id || null, patch);
      toast(id ? 'Saved' : 'Record created', 'ok');
      app.refresh();
      if (!id) { app.openRecord(d.record.id); return; }
      setData(d);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!confirm(`Move ${form.device} · ${form.scheme} ${form.category} to the Archive? It leaves the register but stays searchable there, and can be restored or deleted for good from the Archive page.`)) return;
    try { await call('deleteRecord', id); toast('Moved to the Archive', 'ok'); app.refresh(); onClose(); } catch (e) { toastError(e); }
  };
  const activate = async (approvalId) => {
    try { setData(await call('activateReplacement', approvalId)); toast('Replacement is now the current approval', 'ok'); app.refresh(); load(id); } catch (e) { toastError(e); }
  };
  const unlink = async (docId) => {
    try { await call('unlinkDocument', docId, id); load(id); app.refresh(); } catch (e) { toastError(e); }
  };
  // Add an LOA straight to this record. A file already in the app is offered for linking instead.
  const [attach, setAttach] = useState(null);
  const [adding, setAdding] = useState('');
  const pickLoa = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      setAdding(`Checking ${file.name}…`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const dup = await call('checkAttach', id, { bytes });
      if (dup) {
        if (dup.linkedHere) toast(`${dup.document.filename} is already linked to this record`);
        else setAttach({ kind: 'duplicate', name: file.name, ...dup });
        return;
      }
      setAdding(`Reading ${file.name}…`);
      const ex = await extractFile(file.name, bytes, { onProgress: (d, t, note) => setAdding(`${note || 'Reading'}…`) });
      const res = await call('attachNewDocument', id, { filename: file.name, bytes, pages: ex.pages, ocrPages: ex.ocrPages });
      if (res.duplicate) { setAttach({ kind: 'duplicate', name: file.name, ...res.duplicate }); return; }
      toast(`Added ${file.name} to this record`, 'ok');
      load(id); app.refresh();
      const v = res.values;
      if (v && r && (v.expiry_date && v.expiry_date !== r.expiry_date || v.approval_number && v.approval_number !== r.approval_number)) {
        setAttach({ kind: 'new', name: file.name, document: { id: res.documentId, filename: file.name }, values: v });
      }
    } catch (err) { toastError(err); } finally { setAdding(''); }
  };
  const linkLoa = async (useValues) => {
    try {
      setData(await call('linkDocumentToRecord', id, attach.document.id, { useValues, values: attach.values }));
      toast(useValues ? 'LOA linked and this record updated from it' : 'LOA linked to this record', 'ok');
      setAttach(null); load(id); app.refresh();
    } catch (err) { toastError(err); }
  };

  if (!form) return html`<${Drawer} title="Loading…" onClose=${onClose}><${Spinner} /><//>`;
  const r = data && data.record;
  const title = id ? `${r.device}` : 'New certification record';
  const sub = id ? html`<span class="row wrap"><span>${r.scheme} · ${r.category}</span>${r.platform ? html`<span class="tag">${[r.platform, r.bundle].filter(Boolean).join(' · ')}</span>` : null}<${HealthPill} r=${r} /><span class="tag">${r.stageNow}</span></span>` : 'Fill in what you know. Dates can be added later from an LOA.';
  const F = (k, label, type = 'text', extra = {}) => html`<label class="field">${label}<input type=${type} value=${form[k] || ''} onInput=${set(k)} ...${extra} /></label>`;
  const footer = html`${id ? html`<button class="btn danger" onClick=${del}><${Icon} name="trash" /> Delete</button><span class="grow"></span>` : null}
    <button class="btn" onClick=${onClose}>Close</button><button class="btn primary" disabled=${busy} onClick=${save}>${id ? 'Save changes' : 'Create record'}</button>`;

  return html`<${Drawer} title=${title} sub=${sub} onClose=${onClose} wide footer=${tab === 'details' ? footer : null}>
    ${data && data.coverage ? html`<div class=${`callout ${data.coverage.kind === 'gap' ? 'bad' : 'good'}`} style="margin-bottom:12px">
      ${data.coverage.kind === 'gap' ? `Coverage gap: ${data.coverage.days} days between the current expiry and the replacement taking effect.` : `Replacement overlaps the current approval by ${data.coverage.days} days, so there is no gap.`}</div>` : null}
    ${id ? html`<div class="tabs">${[['details', 'Details'], ['device', `All certifications${profile ? ` (${countCerts(profile)})` : ''}`], ['approvals', `Approvals (${data.approvals.length})`], ['documents', `LOAs (${data.documents.length})`], ['history', 'History']].map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div>` : null}

    ${tab === 'details' && data && data.documents.length ? html`<div class="loa-strip">
      <${Icon} name="file" /><span class="grow"><b>Latest LOA</b> <a href="#" class="dev" onClick=${(e) => { e.preventDefault(); openDoc(data.documents[0]); }}>${data.documents[0].filename}</a>
        <span class="faint small"> · added ${fmtWhen(data.documents[0].uploaded_at)}${data.documents.length > 1 ? html` · <a href="#" onClick=${(e) => { e.preventDefault(); setTab('documents'); }}>all ${data.documents.length} LOAs</a>` : null}</span></span>
      <${DocButtons} d=${data.documents[0]} /></div>` : null}
    ${tab === 'details' && profile ? html`<${ProfileStrip} p=${profile} onOpen=${() => setTab('device')} />` : null}
    ${tab === 'device' && profile ? html`<${DeviceCerts} p=${profile} current=${id} app=${app} reload=${loadProfile} />` : null}
    ${tab === 'details' ? html`
      <div class="section-title">Certification</div>
      <div class="grid3">
        ${F('device', 'Device *')}
        <label class="field">Brand *<input list="brand-list" value=${form.scheme} onInput=${set('scheme')} /><datalist id="brand-list">${tax.schemes.map((s) => html`<option value=${s} />`)}</datalist></label>
        <label class="field">Approval type<${Select} value=${form.category} onChange=${set('category')} options=${tax.categories} /></label>
        ${F('platform', 'Platform')}${F('bundle', 'Bundle')}${F('kernel_version', 'Kernel / version')}
        ${F('approval_number', 'Approval number')}${F('family', 'Family / model group')}${F('expiry_basis', 'Expiry basis')}
        ${F('issue_date', 'Issued', 'date')}${F('expiry_date', 'Expires', 'date')}
        <label class="field">Days left<input type="text" disabled value=${r ? daysLabel(r.days) : ''} /></label>
      </div>
      <div class="row gap-l mt"><label class="check"><input type="checkbox" checked=${form.restricted} onChange=${set('restricted')} /> Restricted / final extension</label>
        <label class="check"><input type="checkbox" checked=${form.extension_used} onChange=${set('extension_used')} /> Extension already used</label></div>
      <${CoversField} value=${form.covers} device=${form.device} onChange=${(v) => setForm({ ...form, covers: v })} />
      <${EolField} value=${form.eol} onChange=${(v) => setForm({ ...form, eol: v })} />

      <div class="section-title">Ownership and next step</div>
      <div class="grid3">
        <label class="field">Stage<${Select} value=${form.stage} onChange=${set('stage')} placeholder=${`Automatic (${r ? r.stageNow : 'Monitoring'})`} options=${tax.stages} /></label>
        <label class="field">Disposition<${Select} value=${form.disposition} onChange=${set('disposition')} placeholder="(none)" options=${tax.dispositions} /></label>
        <label class="field">Renewal path<${Select} value=${form.renewal_path} onChange=${set('renewal_path')} placeholder="(not decided)" options=${tax.renewalPaths || []} /></label>
        ${F('test_lab', 'Test lab')}
        ${F('owner', 'Owner')}${F('customer', 'Customer')}${F('market', 'Market')}${F('next_action_date', 'Next action date', 'date')}
        <label class="field" style="grid-column:span 2">Tags<input type="text" value=${form.tags} onInput=${set('tags')} placeholder="Comma separated, e.g. Retail, Program X, Customer A" /></label>
      </div>
      <label class="field mt">Next action<input type="text" value=${form.next_action} onInput=${set('next_action')} placeholder="e.g. Request renewal quote from lab" /></label>
      <label class="field mt">Notes<textarea rows="3" value=${form.notes} onInput=${set('notes')}></textarea></label>

      <div class="section-title">Published portal</div>
      <div class="grid3">${F('portal_date', 'Published expiry', 'date')}
        <label class="field">Portal status<${Select} value=${form.portal_status} onChange=${set('portal_status')} options=${tax.portalStatuses} /></label>
        ${F('change_ticket', 'Change ticket')}</div>
      ${r && r.verified_at ? html`<p class="muted small mt">Last verified from an LOA ${fmtWhen(r.verified_at)}${r.verified_by ? ` by ${r.verified_by}` : ''}.</p>` : null}`
    : null}

    ${tab === 'approvals' ? html`${data.approvals.length ? html`<div class="timeline-ap">${data.approvals.map((a) => html`<div class=${`it ${a.role}`}>
        <div class="row wrap"><b>${a.approval_number || 'Approval'}</b><span class=${`pill ${a.role === 'current' ? 'good' : a.role === 'replacement' ? 'info' : ''}`}>${a.role === 'superseded' ? 'History' : a.role}</span>
          ${a.role === 'replacement' ? html`<button class="btn sm" onClick=${() => activate(a.id)}>Make current now</button>` : null}</div>
        <div class="small muted">Issued ${fmtDate(a.issue_date) || '—'} · expires ${fmtDate(a.expiry_date) || '—'}${a.filename ? html` · <a href="#" onClick=${(e) => { e.preventDefault(); openDoc({ id: a.document_id }); }} title="Open this LOA">${a.filename}</a>` : ''}</div></div>`)}</div>`
      : html`<p class="muted">No approvals recorded yet. Drop the LOA in the inbox to add one.</p>`}
      <p class="muted small mt">A replacement that is not yet effective becomes current automatically in the plan; use "Make current now" to switch early.</p>` : null}

    ${tab === 'documents' ? html`${data.documents.length ? html`<table class="t compact"><thead><tr><th>LOA</th><th>Added</th><th class="num">Pages</th><th></th></tr></thead><tbody>
        ${data.documents.map((d) => html`<tr><td class="dev">${d.missing ? d.filename : html`<a href="#" onClick=${(e) => { e.preventDefault(); openDoc(d); }} title="Open">${d.filename}</a>`}</td>
          <td class="small nowrap">${fmtWhen(d.uploaded_at)}</td><td class="num">${d.page_count}</td>
          <td class="nowrap"><span class="row"><${DocButtons} d=${d} />
          <button class="btn sm ghost" onClick=${() => unlink(d.id)} title="Remove the link to this record (the file stays archived)">Unlink</button></span></td></tr>`)}</tbody></table>
        <p class="muted small mt">LOAs are archived in the data folder, so they open even if the original file was moved or deleted.</p>`
      : html`<p class="muted">No LOA linked yet. Add the letter here, or drop it in the LOA inbox and approve it.</p>`}
      <div class="row mt"><label class="btn"><${Icon} name="plus" /> Add LOA to this record
        <input type="file" id="attach-loa" hidden accept=${LOA_EXTENSIONS.map((x) => `.${x}`).join(',')} onChange=${pickLoa} /></label>
        ${adding ? html`<span class="row muted small"><${Spinner} /> ${adding}</span>` : html`<span class="faint small">Use this for a variant device that shares a letter with another record.</span>`}</div>` : null}
    ${attach ? html`<${AttachModal} a=${attach} r=${r} onLink=${linkLoa} onClose=${() => setAttach(null)} />` : null}

    ${tab === 'history' ? html`${data.audit.length ? html`<table class="t compact"><thead><tr><th>When</th><th>Change</th><th>By / source</th></tr></thead><tbody>
        ${data.audit.map((a) => html`<tr><td class="small nowrap">${fmtWhen(a.ts)}</td>
          <td class="small">${a.action === 'create' ? 'Created' : html`<b>${a.field}</b>: ${a.old_value ? html`<s class="faint">${a.old_value}</s> → ` : ''}${a.new_value || '—'}`}</td>
          <td class="small muted">${[a.actor, a.source].filter(Boolean).join(' · ')}</td></tr>`)}</tbody></table>`
      : html`<p class="muted">No changes recorded.</p>`}` : null}
  <//>`;
}

function AttachModal({ a, r, onLink, onClose }) {
  const v = a.values;
  const dates = v ? [v.approval_number, v.issue_date && `issued ${fmtDate(v.issue_date)}`, v.expiry_date && `expires ${fmtDate(v.expiry_date)}`].filter(Boolean).join(' · ') : '';
  const now = [r.approval_number, r.expiry_date && `expires ${fmtDate(r.expiry_date)}`].filter(Boolean).join(' · ') || 'no approval yet';
  if (a.kind === 'new') {
    return html`<${Modal} title="Update this record from the LOA?" onClose=${onClose}>
      <p>${a.name} reads <b>${dates}</b>.</p><p class="muted small">This record has ${now}. Updating keeps the old approval in its history.</p>
      <div class="row mt"><button class="btn primary" onClick=${() => onLink(true)}>Update this record</button><button class="btn" onClick=${onClose}>Keep current values</button></div><//>`;
  }
  return html`<${Modal} title="Duplicate LOA" onClose=${onClose}>
    <p><b>${a.document.filename}</b> is already in the app (added ${fmtWhen(a.document.uploaded_at)})${a.linkedTo.length ? ' and linked to:' : ', but no record uses it yet.'}</p>
    ${a.linkedTo.length ? html`<ul class="small">${a.linkedTo.slice(0, 8).map((x) => html`<li>${x.device} · ${x.scheme} ${x.category}</li>`)}${a.linkedTo.length > 8 ? html`<li>and ${a.linkedTo.length - 8} more</li>` : null}</ul>` : null}
    <p class="muted small">This record (${r.device}) has ${now}.${dates ? ` The letter gives ${dates}.` : ''}</p>
    <div class="col gap mt">
      <button class="btn primary" onClick=${() => onLink(false)}><${Icon} name="link" /> Link the existing LOA to this record</button>
      ${dates ? html`<button class="btn" onClick=${() => onLink(true)}><${Icon} name="refresh" /> Link and override this record with the letter's approval and dates</button>` : null}
      <button class="btn ghost" onClick=${onClose}>Cancel</button></div><//>`;
}

const countCerts = (p) => p.sections.reduce((n, s) => n + s.rows.filter((r) => r.record).length, 0);
const countMissing = (p) => p.sections.reduce((n, s) => n + s.rows.filter((r) => r.status === 'missing').length, 0);

/** One line on the Details tab: how many certifications this device has, and how many are missing. */
function ProfileStrip({ p, onOpen }) {
  const total = countCerts(p);
  const miss = countMissing(p);
  const expired = p.sections.reduce((n, s) => n + s.rows.filter((r) => r.record && r.record.health === 'expired').length, 0);
  return html`<div class="loa-strip"><${Icon} name="shield" /><span class="grow"><b>${p.sections.map((s) => s.device).join(', ')}</b>
    <span class="faint small"> · ${total} certification${total === 1 ? '' : 's'}${expired ? ` · ${expired} expired` : ''}${miss ? html` · <span class="bad-text">${miss} missing</span>` : ''}</span></span>
    <button class="btn sm" onClick=${onOpen}>View all certifications</button></div>`;
}

/**
 * The device's full certification set: the terminal (PCI, L1 Contact, TQM)
 * and each contactless reader in it (L1 Contactless, TQM, L2 per brand),
 * each with its own approval number, dates and LOA.
 */
function DeviceCerts({ p, current, app, reload }) {
  const add = async (sec, row) => {
    try {
      const rid = await call('createSlot', { device: sec.device, platform: p.platform, bundle: p.bundle, slot: row.slot });
      toast(`Created ${sec.device} · ${row.label}. Add its LOA here.`, 'ok');
      app.refresh(); app.openRecord(rid, 'documents');
    } catch (e) { toastError(e); }
  };
  const na = async (sec, row, v) => { try { await call('setCoverageNA', sec.key, row.slot, v); reload(); } catch (e) { toastError(e); } };
  const eol = async (r) => {
    const reason = r.eol ? '' : prompt('Not renewing this certification? Give a reason (e.g. replaced by the CL2 reader):', 'Not renewing');
    if (reason === null) return;
    try { await call('setEol', [r.id], reason); toast(reason ? 'Marked end of life' : 'Tracking it again', 'ok'); reload(); app.refresh(); } catch (e) { toastError(e); }
  };
  return html`<p class="muted small">Each certification has its own approval number, dates and LOA. Click one to open it, or add a missing one.${p.platform || p.bundle ? ` Showing ${[p.platform, p.bundle].filter(Boolean).join(' · ')}.` : ''}</p>
    ${[...p.sections].sort((a, b) => (b.rows.some((x) => x.record && x.record.id === current) ? 1 : 0) - (a.rows.some((x) => x.record && x.record.id === current) ? 1 : 0)).map((sec) => html`<div class="section-title">${sec.device} <span class="faint">${sec.reader ? 'Contactless reader' : 'Terminal'}</span></div>
      <table class="t compact certs"><thead><tr><th>Certification</th><th>Approval no.</th><th>Issued</th><th>Expires</th><th>Status</th><th class="num">LOAs</th><th></th></tr></thead><tbody>
      ${sec.rows.map((row) => {
        const r = row.record;
        if (!r) {
          return html`<tr class=${row.status === 'na' ? 'faint' : 'missing'}><td>${row.label}</td><td colspan="5">${row.status === 'na' ? 'Not applicable' : html`<span class="bad-text">Missing</span>`}</td>
            <td class="nowrap">${row.status === 'na' ? html`<button class="btn sm ghost" onClick=${() => na(sec, row, false)}>Require</button>`
              : html`<button class="btn sm" onClick=${() => add(sec, row)}><${Icon} name="plus" /> Add</button> <button class="btn sm ghost" onClick=${() => na(sec, row, true)} title="Not needed (waiver or no reader)">N/A</button>`}</td></tr>`;
        }
        return html`<tr class=${`click ${r.id === current ? 'sel' : ''}`} onClick=${() => r.id !== current && app.openRecord(r.id)}>
          <td>${row.label}${r.kernel_version && r.category === 'PCI PTS' ? html` <span class="faint">${r.kernel_version}</span>` : null}${r.sharedFrom ? html` <span class="tag" title=${`Certified by the ${r.sharedFrom} LOA, which covers this device too`}>via ${r.sharedFrom}</span>` : null}</td>
          <td class="small ellipsis" style="max-width:180px" title=${r.approval_number}>${r.approval_number || html`<span class="faint">—</span>`}</td>
          <td class="small nowrap">${fmtDate(r.issue_date) || html`<span class="faint">—</span>`}</td>
          <td class="small nowrap">${fmtDate(r.expiry_date) || html`<span class="faint">—</span>`}</td>
          <td><${HealthPill} r=${r} /></td>
          <td class="num">${r.doc_count || html`<span class="faint">—</span>`}</td>
          <td class="nowrap" onClick=${(e) => e.stopPropagation()}><button class="btn sm ghost" onClick=${() => app.openRecord(r.id, 'documents')} title="Open its LOAs or add one"><${Icon} name="file" /> LOA</button>
            <button class="btn sm ghost" onClick=${() => eol(r)} title=${r.eol ? `End of life: ${r.eol}. Click to track it again.` : 'Not renewing: accept this expiration'}>${r.eol ? 'Undo EOL' : 'EOL'}</button></td></tr>`;
      })}</tbody></table>`)}`;
}

/**
 * Accepting an expiration: the certification will not be renewed (end of
 * life, e.g. the CL1 reader replaced by CL2). It then stops raising actions
 * and no longer counts as a gap or a risk.
 */
function EolField({ value, onChange }) {
  const on = !!String(value || '').trim();
  return html`<div class=${`eolbox ${on ? 'on' : ''}`}>
    <label class="check"><input type="checkbox" checked=${on} aria-label="Not renewing"
      onChange=${(e) => onChange(e.target.checked ? 'Not renewing' : '')} /> <b>Not renewing: accept this expiration (end of life)</b></label>
    ${on ? html`<label class="field mt">Reason<input type="text" aria-label="End of life reason" value=${value} onInput=${(e) => onChange(e.target.value || ' ')}
        placeholder="e.g. Replaced by the CL2 reader; customers upgrade" /></label>`
      : html`<div class="faint small">Tick this when the certification will be allowed to expire. It stops counting as a risk or a gap, and the plan stops asking for action.</div>`}
  </div>`;
}

/**
 * Other devices this certification also covers: one LOA can certify a series
 * of devices that share the same physical reader (e.g. Lane/5000, Lane/3600
 * and Desk/1700). Saved reader groups fill the list in one click.
 */
function CoversField({ value, device, onChange }) {
  const [known, setKnown] = useState([]);
  const [groups, setGroups] = useState({});
  useEffect(() => {
    call('knownDevices').then((d) => setKnown(d.map((x) => x.device))).catch(() => {});
    call('listReaderGroups').then(setGroups).catch(() => {});
  }, []);
  const list = String(value || '').split(',').map((x) => x.trim()).filter(Boolean);
  const merge = (names) => onChange([...new Set([...list, ...names])].filter((d) => d.toLowerCase() !== String(device || '').toLowerCase()).join(', '));
  const [adding, setAdding] = useState('');
  const addOne = () => { if (adding.trim()) { merge(adding.split(',').map((x) => x.trim()).filter(Boolean)); setAdding(''); } };
  const saveGroup = async () => {
    const all = [device, ...list].filter(Boolean);
    if (all.length < 2) return toast('Add the other devices first');
    const name = prompt('Name this reader group (e.g. the reader model):', '');
    if (!name) return;
    try { setGroups(await call('setReaderGroup', name, all)); toast(`Saved reader group "${name}"`, 'ok'); } catch (e) { toastError(e); }
  };
  return html`<div class="section-title">This LOA also certifies</div>
    <p class="muted small">Devices that share this physical reader and are certified by the same letter. The certification and its expiry count for each of them.</p>
    <div class="tagrow covers">${list.map((d) => html`<span class="utag">${d} <button class="linkbtn" aria-label=${`Remove ${d}`} onClick=${() => onChange(list.filter((x) => x !== d).join(', '))}>×</button></span>`)}
      ${!list.length ? html`<span class="faint small">Only ${device || 'this device'}</span>` : null}</div>
    <div class="row wrap mt">
      <input type="text" list="covers-devices" aria-label="Add a covered device" placeholder="Add a device, e.g. Lane/3600" value=${adding}
        onInput=${(e) => setAdding(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); addOne(); } }} style="max-width:260px" />
      <datalist id="covers-devices">${known.map((d) => html`<option value=${d} />`)}</datalist>
      <button class="btn sm" onClick=${addOne}><${Icon} name="plus" /> Add</button>
      ${Object.keys(groups).length ? html`<select aria-label="Use a reader group" value="" onChange=${(e) => { const g = groups[e.target.value]; if (g) merge(g); e.target.value = ''; }}>
        <option value="">Use a reader group…</option>${Object.entries(groups).map(([k, v]) => html`<option value=${k}>${k} (${v.join(', ')})</option>`)}</select>` : null}
      <button class="btn sm ghost" onClick=${saveGroup} title="Save this device list to reuse on other LOAs">Save as reader group</button>
    </div>`;
}
