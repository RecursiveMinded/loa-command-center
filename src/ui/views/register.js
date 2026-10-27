import { useState, useMemo, useEffect } from 'preact/hooks';
import { html, Icon, fmtDate, plural, useLoad, Spinner, toast, toastError, HealthPill, unique, usePersist, Select, HEALTH } from '../lib.js';
import { call, saveAs } from '../api.js';
import { EmailModal } from './plan.js';

export const DUE = [
  { value: 'expired', label: 'Expired', test: (d) => d != null && d < 0 },
  { value: 'd30', label: 'Due ≤ 30 days', test: (d) => d != null && d >= 0 && d <= 30 },
  { value: 'd90', label: 'Due ≤ 90 days', test: (d) => d != null && d >= 0 && d <= 90 },
  { value: 'd180', label: 'Due ≤ 6 months', test: (d) => d != null && d >= 0 && d <= 180 },
  { value: 'd365', label: 'Due ≤ 12 months', test: (d) => d != null && d >= 0 && d <= 365 },
  { value: 'later', label: 'More than 12 months', test: (d) => d != null && d > 365 },
  { value: 'missing', label: 'No expiry date', test: (d) => d == null },
];

const EMPTY = { scheme: '', category: '', platform: '', bundle: '', kernel: '', hw: '', tag: '', changed: '', window: '', health: '', stage: '', owner: '', disposition: '', portal: '', archived: false, month: '', ids: null, idsLabel: '' };

export const CHANGED = [{ value: 'today', label: 'Changed today', days: 0 }, { value: 'week', label: 'Changed in 7 days', days: 7 }, { value: 'month', label: 'Changed in 30 days', days: 30 }];

export const tagList = (r) => String(r.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
/** Hardware (reader) version of a record: its CLn tag, else the CLn in the device name. */
export const hwOf = (r) => {
  const t = tagList(r).find((x) => /^CL\d$/i.test(x));
  if (t) return t.toUpperCase();
  const m = String(r.device || '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(/CL(\d)$/);
  return m ? `CL${m[1]}` : '';
};
const NO_HW = 'No CL (contact)';

const COLS = [
  ['device', 'Device'], ['scheme', 'Brand'], ['category', 'Approval type'], ['approval_number', 'Approval no.'],
  ['expiry_date', 'Expires'], ['days', 'Status'], ['stageNow', 'Stage'], ['owner', 'Owner'], ['next_action', 'Next action'], ['doc_count', 'LOA'], ['portal_status', 'Portal'],
];

export function applyFilter(records, f, q) {
  const due = DUE.find((d) => d.value === f.window);
  const ids = f.ids ? new Set(f.ids) : null;
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return records.filter((r) => {
    if (ids) return ids.has(r.id);
    if (!f.archived && r.archived) return false;
    if (f.scheme && r.scheme !== f.scheme) return false;
    if (f.category && r.category !== f.category) return false;
    if (f.platform && (r.platform || '(none)') !== f.platform) return false;
    if (f.bundle && (r.bundle || '(none)') !== f.bundle) return false;
    if (f.kernel && (r.kernel_version || '(none)') !== f.kernel) return false;
    if (f.hw && (hwOf(r) || NO_HW) !== f.hw) return false;
    if (f.tag && !(f.tag === '(none)' ? !tagList(r).length : tagList(r).some((t) => t.toLowerCase() === f.tag.toLowerCase()))) return false;
    if (f.changed) {
      const c = CHANGED.find((x) => x.value === f.changed);
      const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - c.days);
      if (!r.updated_at || new Date(r.updated_at) < since) return false;
    }
    if (f.health && r.health !== f.health) return false;
    if (f.stage && r.stageNow !== f.stage) return false;
    if (f.owner && (r.owner || '(unassigned)') !== f.owner) return false;
    if (f.disposition && (r.disposition || '(none)') !== f.disposition) return false;
    if (f.portal && r.portal_status !== f.portal) return false;
    if (f.month && String(r.expiry_date || '').slice(0, 7) !== f.month) return false;
    if (due && !due.test(r.days)) return false;
    if (words.length) {
      const hay = [r.device, r.family, r.platform, r.bundle, r.tags, r.scheme, r.category, r.approval_number, r.owner, r.customer, r.market, r.notes, r.kernel_version, r.next_action, r.change_ticket].join(' ').toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

export function filterLabel(f, q) {
  const parts = [];
  if (f.ids) parts.push(`${f.ids.length} selected records`);
  for (const k of ['scheme', 'category', 'platform', 'bundle', 'stage', 'owner', 'disposition', 'portal']) if (f[k]) parts.push(f[k]);
  if (f.kernel) parts.push(`Kernel: ${f.kernel}`);
  if (f.hw) parts.push(`Hardware: ${f.hw}`);
  if (f.tag) parts.push(`Tag: ${f.tag}`);
  if (f.changed) parts.push(CHANGED.find((x) => x.value === f.changed).label);
  if (f.window) parts.push(DUE.find((d) => d.value === f.window).label);
  if (f.health) parts.push(HEALTH[f.health].label);
  if (f.month) parts.push(`Expiring ${f.month}`);
  if (q) parts.push(`"${q}"`);
  return parts.join(' · ');
}

export function Register({ app, params }) {
  const [records, reload] = useLoad(() => call('listRecords'), [app.version]);
  const [f, setF] = usePersist('register.filter', EMPTY);
  const [sort, setSort] = usePersist('register.sort', { key: 'days', dir: 1 });
  const [sel, setSel] = useState(new Set());
  const [limit, setLimit] = useState(300);
  const [email, setEmail] = useState(null);
  const q = app.search;

  // Filters requested by another screen (dashboard tile, timeline, action).
  useEffect(() => {
    if (params && params.filter) {
      setF({ ...EMPTY, ...params.filter });
      setSel(params.select && params.filter.ids ? new Set(params.filter.ids) : new Set());
    }
  }, [params]);

  const tax = app.info.taxonomy;
  const list = useMemo(() => {
    if (!records) return [];
    const out = applyFilter(records, f, q);
    const k = sort.key, dir = sort.dir;
    out.sort((a, b) => {
      let x = a[k], y = b[k];
      if (k === 'days' || k === 'expiry_date') { x = a.days ?? 1e9; y = b.days ?? 1e9; }
      if (x == null || x === '') return 1;
      if (y == null || y === '') return -1;
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir;
    });
    return out;
  }, [records, f, q, sort]);

  if (!records) return html`<div class="row"><${Spinner} /> Loading…</div>`;
  const live = records.filter((r) => !r.archived);
  const tags = unique(live.flatMap(tagList));
  const hws = unique(live.map(hwOf).filter(Boolean));
  const opt = (key, none) => unique(live.map((r) => r[key] || none));
  const active = Object.entries(f).some(([k, v]) => (k === 'archived' ? v : v && (Array.isArray(v) ? v.length : true)));
  const healthCounts = {};
  for (const r of applyFilter(records, { ...f, health: '' }, q)) healthCounts[r.health] = (healthCounts[r.health] || 0) + 1;

  const toggle = (id) => { const s = new Set(sel); if (s.has(id)) s.delete(id); else s.add(id); setSel(s); };
  const allOn = list.length && list.every((r) => sel.has(r.id));
  const toggleAll = () => setSel(allOn ? new Set() : new Set(list.map((r) => r.id)));
  const ids = () => (sel.size ? [...sel] : list.map((r) => r.id));
  const label = () => (sel.size ? `${sel.size} selected records` : filterLabel(f, q));
  const exportX = async () => { try { const b = await call('exportExcel', { ids: ids() }); await saveAs('Certifications.xlsx', b, [{ name: 'Excel', extensions: ['xlsx'] }]); } catch (e) { toastError(e); } };
  const exportC = async () => { try { const t = await call('exportCsv', { ids: ids() }); await saveAs('Certifications.csv', t, [{ name: 'CSV', extensions: ['csv'] }]); } catch (e) { toastError(e); } };
  const delOne = async (r) => {
    if (!confirm(`Delete ${r.device} · ${r.scheme} ${r.category}? Its history is removed (a daily backup is kept). Archiving hides it instead.`)) return;
    try { await call('deleteRecord', r.id); toast('Deleted', 'ok'); const s = new Set(sel); s.delete(r.id); setSel(s); reload(); app.refresh(); } catch (e) { toastError(e); }
  };
  const draft = async () => { try { setEmail(await call('aiDraftEmail', [...sel], { purpose: 'renewal status' })); } catch (e) { toastError(e); } };

  return html`
    <div class="page-head"><div><h1>Certifications</h1><p>${plural(list.length, 'record')}${list.length !== live.length ? ` of ${live.length}` : ''}${f.ids ? ` · ${f.idsLabel || 'from an action'}` : ''}</p></div>
      <div class="row"><button class="btn" onClick=${exportX}><${Icon} name="download" /> Excel</button><button class="btn" onClick=${exportC}>CSV</button>
      <button class="btn" onClick=${() => app.openReport({ ids: active || q || sel.size ? ids() : null, filterLabel: label() })}><${Icon} name="report" /> Report</button>
      <button class="btn primary" onClick=${() => app.openRecord(null)}><${Icon} name="plus" /> Add record</button></div></div>

    <div class="chips">${['expired', 'critical', 'warning', 'good', 'unknown'].map((h) => html`<button class=${`chip ${f.health === h ? 'on' : ''}`} onClick=${() => setF({ ...f, health: f.health === h ? '' : h })}>
      <span class="sw" style=${`background:${HEALTH[h].color}`}></span>${HEALTH[h].label} <b>${healthCounts[h] || 0}</b></button>`)}</div>

    <div class="filters">
      <${Select} value=${f.scheme} onChange=${(v) => setF({ ...f, scheme: v })} placeholder="All brands" options=${opt('scheme', '')} />
      <${Select} value=${f.category} onChange=${(v) => setF({ ...f, category: v })} placeholder="All approval types" options=${tax.categories.filter((c) => live.some((r) => r.category === c))} />
      <${Select} value=${f.platform} onChange=${(v) => setF({ ...f, platform: v })} placeholder="All platforms" options=${opt('platform', '(none)')} />
      <${Select} value=${f.bundle} onChange=${(v) => setF({ ...f, bundle: v })} placeholder="All bundles" options=${opt('bundle', '(none)')} />
      <${Select} value=${f.kernel} onChange=${(v) => setF({ ...f, kernel: v })} placeholder="All kernel versions" options=${opt('kernel_version', '(none)')} />
      ${hws.length || f.hw ? html`<${Select} value=${f.hw} onChange=${(v) => setF({ ...f, hw: v })} placeholder="All hardware (CL)" options=${[...hws, NO_HW]} />` : null}
      ${tags.length || f.tag ? html`<${Select} value=${f.tag} onChange=${(v) => setF({ ...f, tag: v })} placeholder="All tags" options=${[...tags, '(none)']} />` : null}
      <${Select} value=${f.changed} onChange=${(v) => setF({ ...f, changed: v })} placeholder="Changed: any time" options=${CHANGED} />
      <${Select} value=${f.window} onChange=${(v) => setF({ ...f, window: v, month: '' })} placeholder="Any expiry" options=${DUE} />
      <${Select} value=${f.stage} onChange=${(v) => setF({ ...f, stage: v })} placeholder="All stages" options=${tax.stages} />
      <${Select} value=${f.owner} onChange=${(v) => setF({ ...f, owner: v })} placeholder="All owners" options=${opt('owner', '(unassigned)')} />
      <${Select} value=${f.disposition} onChange=${(v) => setF({ ...f, disposition: v })} placeholder="All dispositions" options=${opt('disposition', '(none)')} />
      <${Select} value=${f.portal} onChange=${(v) => setF({ ...f, portal: v })} placeholder="Portal: any" options=${tax.portalStatuses} />
      <label class="check small"><input type="checkbox" checked=${f.archived} onChange=${(e) => setF({ ...f, archived: e.target.checked })} /> Show archived</label>
      ${f.month ? html`<span class="chip on" onClick=${() => setF({ ...f, month: '' })}>Expiring ${f.month} <${Icon} name="x" size="12" /></span>` : null}
      ${f.ids ? html`<span class="chip on" onClick=${() => setF({ ...f, ids: null, idsLabel: '' })}>${plural(f.ids.length, 'record')} ${f.idsLabel || 'from an action'} <${Icon} name="x" size="12" /></span>` : null}
      ${active || q ? html`<button class="btn sm ghost" onClick=${() => { setF(EMPTY); app.setSearch(''); }}>Clear filters</button>` : null}
    </div>

    ${!list.length ? html`<div class="card"><div class="empty"><${Icon} name="search" /><h3>No records match</h3><div>Try clearing a filter.</div></div></div>` : html`
    <div class="table-wrap" style="max-height:calc(100vh - 300px)"><table class="t">
      <thead><tr><th class="chk"><input type="checkbox" aria-label="Select all" checked=${allOn} onChange=${toggleAll} /></th>
        ${COLS.map(([k, l]) => html`<th class="sort" onClick=${() => setSort({ key: k, dir: sort.key === k ? -sort.dir : 1 })}>${l}${sort.key === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`)}<th></th></tr></thead>
      <tbody>${list.slice(0, limit).map((r) => html`<tr key=${r.id} class=${`click ${sel.has(r.id) ? 'sel' : ''}`} onClick=${() => app.openRecord(r.id)}>
        <td class="chk" onClick=${(e) => e.stopPropagation()}><input type="checkbox" aria-label="Select" checked=${sel.has(r.id)} onChange=${() => toggle(r.id)} /></td>
        <td><div class="dev">${r.device}${r.archived ? html` <span class="tag">Archived</span>` : null}</div><div class="faint small">${[r.platform, r.bundle, r.kernel_version].filter(Boolean).join(' · ')}</div>
          ${r.tags ? html`<div class="tagrow">${tagList(r).map((t) => html`<span class="utag" onClick=${(e) => { e.stopPropagation(); setF({ ...f, tag: t }); }} title="Show records with this tag">${t}</span>`)}</div>` : null}</td>
        <td>${r.scheme}</td><td class="nowrap">${r.category}</td>
        <td class="small ellipsis" style="max-width:170px" title=${r.approval_number}>${r.approval_number}</td>
        <td class="nowrap">${fmtDate(r.expiry_date) || html`<span class="faint">—</span>`}${r.restricted ? html` <span class="tag" title="Restricted / final extension">R</span>` : null}</td>
        <td><${HealthPill} r=${r} /></td>
        <td class="small nowrap">${r.stageNow}</td>
        <td class="small">${r.owner || html`<span class="faint">—</span>`}</td>
        <td class="small ellipsis" style="max-width:200px" title=${r.next_action}>${r.next_action}${r.next_action_date ? html` <span class="faint">${fmtDate(r.next_action_date)}</span>` : null}</td>
        <td class="num">${r.doc_count ? html`<button class="tag linktag" title="View the LOAs for this record" onClick=${(e) => { e.stopPropagation(); app.openRecord(r.id, 'documents'); }}><${Icon} name="file" /> ${r.doc_count}</button>` : html`<span class="faint">—</span>`}</td>
        <td class="small nowrap">${r.portal_status === 'Not Tracked' ? html`<span class="faint">—</span>` : r.portal_status}</td>
        <td class="row-del"><button class="iconbtn" title=${`Delete ${r.device} · ${r.scheme} ${r.category}`} aria-label="Delete record" onClick=${(e) => { e.stopPropagation(); delOne(r); }}><${Icon} name="trash" /></button></td>
      </tr>`)}</tbody></table>
      ${list.length > limit ? html`<div class="row" style="justify-content:center;padding:12px"><button class="btn" onClick=${() => setLimit(limit + 500)}>Show more (${list.length - limit} hidden)</button></div>` : null}
    </div>`}
    ${sel.size ? html`<${BulkBar} ids=${[...sel]} tax=${tax} values=${{ owner: opt('owner', ''), platform: opt('platform', ''), bundle: opt('bundle', ''), family: opt('family', ''), customer: opt('customer', ''), market: opt('market', ''), 'tags+': tags, 'tags-': unique(records.filter((r) => sel.has(r.id)).flatMap(tagList)) }} onDone=${() => { reload(); app.refresh(); }} onClear=${() => setSel(new Set())} onEmail=${draft} />` : null}
    ${email ? html`<${EmailModal} email=${email} onClose=${() => setEmail(null)} />` : null}`;
}

const BULK_FIELDS = [
  ['platform', 'Platform'], ['bundle', 'Bundle'], ['family', 'Family / model group'], ['kernel_version', 'Kernel / version'],
  ['hw', 'Hardware version (CL)'], ['tags+', 'Add tag'], ['tags-', 'Remove tag'],
  ['owner', 'Owner'], ['stage', 'Stage'], ['disposition', 'Disposition'], ['next_action', 'Next action'], ['next_action_date', 'Next action date'],
  ['portal_status', 'Portal status'], ['customer', 'Customer'], ['market', 'Market'], ['change_ticket', 'Change ticket'], ['archived', 'Archive'],
];

function BulkBar({ ids, tax, values, onDone, onClear, onEmail }) {
  const [field, setField] = useState('platform');
  const [value, setValue] = useState('');
  const isTag = field === 'tags+' || field === 'tags-';
  const apply = async () => {
    if (isTag && !value.trim()) return toast('Type a tag first');
    try {
      const v = field === 'archived' ? value === 'yes' : value;
      const CLS = ['CL1', 'CL2', 'CL3', 'CL4', 'CL5', 'CL6', 'CL7', 'CL8', 'CL9'];
      const tags = field === 'tags+' ? { add: v.split(',') } : field === 'tags-' ? { remove: v.split(',') }
        : field === 'hw' ? { remove: CLS, add: v ? [v] : [] } : null;
      const r = await call('bulkUpdate', ids, tags ? {} : { [field]: v }, tags);
      toast(`Updated ${plural(r.changed, 'record')}`, 'ok');
      if (r.skipped && r.skipped.length) {
        toast(`Skipped ${plural(r.skipped.length, 'record')}: ${r.skipped.slice(0, 3).map((x) => `${x.label} (${x.reason})`).join('; ')}${r.skipped.length > 3 ? '…' : ''}`, 'err');
      }
      setValue('');
      onDone();
    } catch (e) { toastError(e); }
  };
  const remove = async () => {
    if (!confirm(`Delete ${plural(ids.length, 'record')}? Their history is removed (a daily backup is kept). Use Set > Archive to hide them instead.`)) return;
    try {
      const n = await call('deleteRecords', ids);
      toast(`Deleted ${plural(n, 'record')}`, 'ok');
      onClear();
      onDone();
    } catch (e) { toastError(e); }
  };
  const list = values[field] ? values[field].filter(Boolean) : null;
  const input = field === 'hw' ? html`<${Select} value=${value} onChange=${setValue} placeholder="None (contact)" options=${['CL1', 'CL2', 'CL3', 'CL4']} />`
    : field === 'stage' ? html`<${Select} value=${value} onChange=${setValue} placeholder="(automatic)" options=${tax.stages} />`
    : field === 'disposition' ? html`<${Select} value=${value} onChange=${setValue} placeholder="(none)" options=${tax.dispositions} />`
      : field === 'portal_status' ? html`<${Select} value=${value} onChange=${setValue} options=${tax.portalStatuses} placeholder="Choose" />`
        : field === 'archived' ? html`<${Select} value=${value} onChange=${setValue} options=${[{ value: 'yes', label: 'Archive' }, { value: 'no', label: 'Restore' }]} placeholder="Choose" />`
          : field === 'next_action_date' ? html`<input type="date" value=${value} onInput=${(e) => setValue(e.target.value)} />`
            : html`<input type="text" list=${list ? 'bulk-values' : null} value=${value} aria-label="Value"
                placeholder=${isTag ? 'Tag, e.g. Retail or Program X' : 'Value (blank clears)'} onInput=${(e) => setValue(e.target.value)}
                onKeyDown=${(e) => { if (e.key === 'Enter') apply(); }} />`;
  return html`<div class="bulkbar"><b>${ids.length} selected</b><span style="opacity:.6">Set</span>
    <select value=${field} onChange=${(e) => { setField(e.target.value); setValue(''); }} aria-label="Field">${BULK_FIELDS.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>
    ${input}${list ? html`<datalist id="bulk-values">${list.map((o) => html`<option value=${o} />`)}</datalist>` : null}
    <button class="btn primary" onClick=${apply}>Apply</button><span class="grow"></span>
    <button class="btn" onClick=${onEmail}><${Icon} name="mail" /> Draft email</button>
    <button class="btn danger" onClick=${remove} title="Delete the selected records"><${Icon} name="trash" /> Delete ${ids.length}</button>
    <button class="btn" onClick=${onClear}>Clear selection</button></div>`;
}

