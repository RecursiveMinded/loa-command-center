// Device coverage: every device against the certifications it needs. A contact
// device needs PCI, L1 Contact and TQM; a contactless reader (CL1, CL2...) needs
// L1 Contactless, TQM and an L2 Contactless approval from each required brand.
import { useMemo } from 'preact/hooks';
import { html, Icon, fmtDate, useLoad, Spinner, unique, usePersist, Select, HEALTH, daysLabel, plural, toast, toastError } from '../lib.js';
import { call } from '../api.js';

export function Devices({ app }) {
  const [cov, reload] = useLoad(() => call('deviceCoverage'), [app.version]);
  const [f, setF] = usePersist('devices', { platform: '', bundle: '', gaps: false });
  const rows = useMemo(() => {
    if (!cov) return [];
    const q = (app.search || '').toLowerCase();
    return cov.rows.filter((r) => (!f.platform || r.platform === f.platform) && (!f.bundle || r.bundle === f.bundle) && (!f.gaps || r.missing)
      && (!q || `${r.device} ${r.grp}`.toLowerCase().includes(q)));
  }, [cov, f, app.search]);
  if (!cov) return html`<div class="row"><${Spinner} /> Loading…</div>`;

  const done = () => { reload(); app.refresh(); };
  const create = async (items) => {
    try { toast(`Created ${plural(await call('createMissing', items), 'record')}. Add the LOA or dates to finish them.`, 'ok'); done(); } catch (e) { toastError(e); }
  };
  const setNa = async (row, slot, v) => { try { await call('setCoverageNA', row.key, slot, v); reload(); } catch (e) { toastError(e); } };
  const gaps = rows.flatMap((r) => cov.columns.filter((c) => r.cells[c.key].status === 'missing').map((c) => ({ device: r.device, platform: r.platform, bundle: r.bundle, slot: c.key })));
  const createAll = () => { if (confirm(`Create ${plural(gaps.length, 'empty record')} for the missing certifications shown? You can then add each LOA.`)) create(gaps); };
  // Bulk create only within one platform and bundle, so it never floods the register.
  const oneGroup = new Set(rows.map((r) => r.grp)).size === 1;
  const gapsByGrp = {};
  for (const r of rows) gapsByGrp[r.grp] = (gapsByGrp[r.grp] || 0) + r.missing;
  const spans = [];
  for (const c of cov.columns) { const last = spans[spans.length - 1]; if (last && last.group === c.group) last.n++; else spans.push({ group: c.group, n: 1 }); }
  const platforms = unique(cov.rows.map((r) => r.platform));
  const bundles = unique(cov.rows.filter((r) => !f.platform || r.platform === f.platform).map((r) => r.bundle));
  let lastGrp = null;

  return html`
    <div class="page-head"><div><h1>Devices</h1><p>What each device needs to be certified. A contact device needs PCI, L1 Contact and TQM. A contactless reader (CL1, CL2, CL3) needs L1 Contactless, TQM and L2 Contactless from each brand.</p></div>
      <div class="row">${gaps.length && oneGroup ? html`<button class="btn" onClick=${createAll} title="Creates empty records you then fill in from each LOA"><${Icon} name="plus" /> Create ${plural(gaps.length, 'missing record')}</button>` : null}</div></div>
    <div class="filters">
      <${Select} value=${f.platform} onChange=${(v) => setF({ ...f, platform: v, bundle: '' })} placeholder="All platforms" options=${platforms} />
      <${Select} value=${f.bundle} onChange=${(v) => setF({ ...f, bundle: v })} placeholder="All bundles" options=${bundles} />
      <label class="check small"><input type="checkbox" checked=${f.gaps} onChange=${(e) => setF({ ...f, gaps: e.target.checked })} /> Only devices with gaps</label>
      <span class="muted small">${plural(rows.length, 'device')} · ${plural(rows.reduce((n, r) => n + r.missing, 0), 'missing certification')}${!oneGroup && gaps.length ? ' · pick one platform and bundle to create them' : ''}</span>
      <span class="legend">${['expired', 'critical', 'warning', 'good'].map((k) => html`<span><i style=${`background:${HEALTH[k].color}`}></i>${HEALTH[k].label}</span>`)}<span><i class="miss"></i>Missing</span></span>
    </div>
    ${!rows.length ? html`<div class="card"><div class="empty"><${Icon} name="grid" /><h3>No devices to show</h3><div>Add records or change the filters.</div></div></div>` : html`
    <div class="table-wrap" style="max-height:calc(100vh - 250px)"><table class="mx cov">
      <thead><tr><th class="name" rowspan="2">Device</th>${spans.map((s) => html`<th class="cat" colspan=${s.n}>${s.group}</th>`)}</tr>
        <tr>${cov.columns.map((c) => html`<th style="top:31px">${c.label}</th>`)}</tr></thead>
      <tbody>${rows.map((row) => {
        const head = row.grp !== lastGrp ? html`<tr class="grp"><td colspan=${cov.columns.length + 1}>${row.grp}${gapsByGrp[row.grp] ? html` <span class="faint">· ${plural(gapsByGrp[row.grp], 'missing certification')}</span>` : null}</td></tr>` : null;
        lastGrp = row.grp;
        return html`${head}<tr class=${row.reader ? 'reader' : ''}><td class="name">${row.reader ? html`<span class="faint" title="Contactless reader in this device">↳ </span>` : null}${row.device}${row.missing ? html` <span class="pill bad" title="Missing certifications">${row.missing}</span>` : null}</td>${cov.columns.map((c) => {
          const cell = row.cells[c.key];
          const r = cell.record;
          if (r) {
            return html`<td><span class=${`cell ${r.health}${r.sharedFrom ? ' shared' : ''}`} title=${`${row.device} · ${c.group} ${c.label}\n${r.approval_number || ''}\nExpires ${fmtDate(r.expiry_date) || 'unknown'}${r.sharedFrom ? `\nCertified by the ${r.sharedFrom} LOA` : ''}`} onClick=${() => app.openRecord(r.id)}>
              ${r.expiry_date ? fmtDate(r.expiry_date).replace(/^(\w+) \d+, (\d+)$/, '$1 $2') : 'No date'}<small>${r.sharedFrom ? `via ${r.sharedFrom}` : r.expiry_date ? daysLabel(r.days) : 'add LOA'}</small></span></td>`;
          }
          if (cell.status === 'missing') {
            return html`<td><span class="cell miss" title=${`${row.device} has no ${c.group} ${c.label} record`}>Missing<small>
              <button class="linkbtn" onClick=${() => create([{ device: row.device, platform: row.platform, bundle: row.bundle, slot: c.key }])} title="Create an empty record for it">Add</button> ·
              <button class="linkbtn" onClick=${() => setNa(row, c.key, true)} title="This device does not need it (a waiver or no reader)">N/A</button></small></span></td>`;
          }
          if (cell.status === 'na') return html`<td><button class="cell na" onClick=${() => setNa(row, c.key, false)} title="Marked not applicable. Click to require it again.">N/A</button></td>`;
          return html`<td></td>`;
        })}</tr>`;
      })}</tbody></table></div>`}`;
}
