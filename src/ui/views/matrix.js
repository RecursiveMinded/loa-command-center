import { useMemo } from 'preact/hooks';
import { html, Icon, fmtDate, useLoad, Spinner, unique, usePersist, Select, HEALTH, daysLabel } from '../lib.js';
import { call } from '../api.js';

const GROUPS = [
  { value: 'L1', label: 'EMV Level 1', test: (c) => /^EMV L1/.test(c) },
  { value: 'L2', label: 'EMV Level 2', test: (c) => /^EMV L2/.test(c) },
  { value: 'TQM', label: 'TQM', test: (c) => c === 'TQM' },
  { value: 'PCI', label: 'PCI PTS', test: (c) => c === 'PCI PTS' },
  { value: 'other', label: 'Other', test: (c) => !/^EMV L[12]/.test(c) && !['TQM', 'PCI PTS'].includes(c) },
];

export function Matrix({ app }) {
  const [records] = useLoad(() => call('listRecords'), [app.version]);
  const [f, setF] = usePersist('matrix', { group: '', platform: '', bundle: '', q: '' });
  const tax = app.info.taxonomy;
  const model = useMemo(() => {
    if (!records) return null;
    const g = GROUPS.find((x) => x.value === f.group);
    const q = (app.search || '').toLowerCase();
    const rs = records.filter((r) => !r.archived && (!g || g.test(r.category)) && (!f.platform || r.platform === f.platform) && (!f.bundle || r.bundle === f.bundle)
      && (!q || `${r.device} ${r.platform} ${r.bundle}`.toLowerCase().includes(q)));
    const catOrder = (c) => { const i = tax.categories.indexOf(c); return i < 0 ? 99 : i; };
    const colKeys = unique(rs.map((r) => `${String(catOrder(r.category)).padStart(2, '0')}|${r.category}|${r.scheme}`));
    const cols = colKeys.map((k) => { const [, category, scheme] = k.split('|'); return { key: `${category}|${scheme}`, category, scheme }; });
    const rows = new Map();
    for (const r of rs) {
      const grp = [r.platform, r.bundle].filter(Boolean).join(' · ') || 'Unassigned';
      const rk = `${grp}||${r.device}`;
      if (!rows.has(rk)) rows.set(rk, { grp, device: r.device, cells: {} });
      const ck = `${r.category}|${r.scheme}`;
      const cur = rows.get(rk).cells[ck];
      // Several approvals for one cell (e.g. PCI v5 and v6): show the one that lasts longest.
      if (!cur || (r.days ?? -1e9) > (cur.days ?? -1e9)) rows.get(rk).cells[ck] = r;
    }
    const list = [...rows.values()].sort((a, b) => a.grp.localeCompare(b.grp, undefined, { numeric: true }) || a.device.localeCompare(b.device, undefined, { numeric: true }));
    return { cols, list, platforms: unique(records.map((r) => r.platform)), bundles: unique(records.filter((r) => !f.platform || r.platform === f.platform).map((r) => r.bundle)) };
  }, [records, f, app.search]);

  if (!model) return html`<div class="row"><${Spinner} /> Loading…</div>`;
  const { cols, list } = model;
  // Header row 1: categories spanning their brands.
  const spans = [];
  for (const c of cols) { const last = spans[spans.length - 1]; if (last && last.category === c.category) last.n++; else spans.push({ category: c.category, n: 1 }); }
  let lastGrp = null;
  return html`
    <div class="page-head"><div><h1>Matrix</h1><p>Every device against every brand, coloured by how soon it expires. Click a cell to open the record.</p></div>
      <div class="legend">${['expired', 'critical', 'warning', 'good', 'unknown'].map((k) => html`<span><i style=${`background:${HEALTH[k].color}`}></i>${HEALTH[k].label}</span>`)}</div></div>
    <div class="filters">
      <div class="seg"><button class=${!f.group ? 'on' : ''} onClick=${() => setF({ ...f, group: '' })}>All</button>${GROUPS.map((g) => html`<button class=${f.group === g.value ? 'on' : ''} onClick=${() => setF({ ...f, group: g.value })}>${g.label}</button>`)}</div>
      <${Select} value=${f.platform} onChange=${(v) => setF({ ...f, platform: v, bundle: '' })} placeholder="All platforms" options=${model.platforms} />
      <${Select} value=${f.bundle} onChange=${(v) => setF({ ...f, bundle: v })} placeholder="All bundles" options=${model.bundles} />
      <span class="muted small">${list.length} devices · ${cols.length} columns</span>
    </div>
    ${!list.length ? html`<div class="card"><div class="empty"><${Icon} name="grid" /><h3>Nothing to show</h3><div>Add records or change the filters.</div></div></div>` : html`
    <div class="table-wrap" style="max-height:calc(100vh - 230px)"><table class="mx">
      <thead><tr><th class="name" rowspan="2">Device</th>${spans.map((s) => html`<th class="cat" colspan=${s.n}>${s.category}</th>`)}</tr>
        <tr>${cols.map((c) => html`<th style="top:31px">${c.scheme}</th>`)}</tr></thead>
      <tbody>${list.map((row) => {
        const head = row.grp !== lastGrp ? html`<tr class="grp"><td colspan=${cols.length + 1}>${row.grp}</td></tr>` : null;
        lastGrp = row.grp;
        return html`${head}<tr><td class="name">${row.device}</td>${cols.map((c) => {
          const r = row.cells[c.key];
          if (!r) return html`<td></td>`;
          return html`<td><span class=${`cell ${r.health}`} title=${`${r.device} · ${r.scheme} ${r.category}\nExpires ${fmtDate(r.expiry_date) || 'unknown'}\n${r.stageNow}${r.owner ? `\nOwner: ${r.owner}` : ''}`} onClick=${() => app.openRecord(r.id)}>
            ${r.expiry_date ? fmtDate(r.expiry_date).replace(/^(\w+) \d+, (\d+)$/, '$1 $2') : 'No date'}<small>${r.expiry_date ? daysLabel(r.days) : r.stageNow}</small></span></td>`;
        })}</tr>`;
      })}</tbody></table></div>`}`;
}
