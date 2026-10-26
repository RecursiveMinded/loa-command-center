import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Drawer, fmtDate, fmtWhen, Spinner, toast, toastError, HealthPill, Select, daysLabel } from '../lib.js';
import { call } from '../api.js';
import { DocButtons, openDoc } from '../docs.js';

const BLANK = {
  device: '', platform: '', bundle: '', family: '', category: 'EMV L1 Contact', scheme: '', kernel_version: '', approval_number: '',
  issue_date: '', expiry_date: '', expiry_basis: '', restricted: false, stage: '', disposition: '', owner: '', customer: '', market: '',
  next_action: '', next_action_date: '', extension_used: false, notes: '', portal_date: '', portal_status: 'Not Tracked', change_ticket: '', tags: '', archived: false,
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
    if (!confirm(`Delete ${form.device} · ${form.scheme} ${form.category}? Its history is removed. Archiving keeps it instead.`)) return;
    try { await call('deleteRecord', id); toast('Deleted'); app.refresh(); onClose(); } catch (e) { toastError(e); }
  };
  const activate = async (approvalId) => {
    try { setData(await call('activateReplacement', approvalId)); toast('Replacement is now the current approval', 'ok'); app.refresh(); load(id); } catch (e) { toastError(e); }
  };
  const unlink = async (docId) => {
    try { await call('unlinkDocument', docId, id); load(id); app.refresh(); } catch (e) { toastError(e); }
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
    ${id ? html`<div class="tabs">${[['details', 'Details'], ['approvals', `Approvals (${data.approvals.length})`], ['documents', `LOAs (${data.documents.length})`], ['history', 'History']].map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div>` : null}

    ${tab === 'details' && data && data.documents.length ? html`<div class="loa-strip">
      <${Icon} name="file" /><span class="grow"><b>Latest LOA</b> <a href="#" class="dev" onClick=${(e) => { e.preventDefault(); openDoc(data.documents[0]); }}>${data.documents[0].filename}</a>
        <span class="faint small"> · added ${fmtWhen(data.documents[0].uploaded_at)}${data.documents.length > 1 ? html` · <a href="#" onClick=${(e) => { e.preventDefault(); setTab('documents'); }}>all ${data.documents.length} LOAs</a>` : null}</span></span>
      <${DocButtons} d=${data.documents[0]} /></div>` : null}
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
        <label class="check"><input type="checkbox" checked=${form.extension_used} onChange=${set('extension_used')} /> Extension already used</label>
        <label class="check"><input type="checkbox" checked=${form.archived} onChange=${set('archived')} /> Archived</label></div>

      <div class="section-title">Ownership and next step</div>
      <div class="grid3">
        <label class="field">Stage<${Select} value=${form.stage} onChange=${set('stage')} placeholder=${`Automatic (${r ? r.stageNow : 'Monitoring'})`} options=${tax.stages} /></label>
        <label class="field">Disposition<${Select} value=${form.disposition} onChange=${set('disposition')} placeholder="(none)" options=${tax.dispositions} /></label>
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
      : html`<p class="muted">No LOA linked yet. Drop the letter in the inbox and approve it to attach it here.</p>`}` : null}

    ${tab === 'history' ? html`${data.audit.length ? html`<table class="t compact"><thead><tr><th>When</th><th>Change</th><th>By / source</th></tr></thead><tbody>
        ${data.audit.map((a) => html`<tr><td class="small nowrap">${fmtWhen(a.ts)}</td>
          <td class="small">${a.action === 'create' ? 'Created' : html`<b>${a.field}</b>: ${a.old_value ? html`<s class="faint">${a.old_value}</s> → ` : ''}${a.new_value || '—'}`}</td>
          <td class="small muted">${[a.actor, a.source].filter(Boolean).join(' · ')}</td></tr>`)}</tbody></table>`
      : html`<p class="muted">No changes recorded.</p>`}` : null}
  <//>`;
}
