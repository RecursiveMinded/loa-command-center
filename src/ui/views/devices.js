// Device coverage: every device against the certifications it needs. A contact
// device holds PCI, L1 Contact and L2 Contact for all its versions; a hardware version (CL1, CL2...) needs
// L1 Contactless, TQM and an L2 Contactless approval from each required brand.
import { useMemo, useState } from 'preact/hooks';
import { ValiditySummary } from './inbox.js';
import { openDoc } from '../docs.js';
import { html, Icon, fmtDate, useLoad, Spinner, unique, usePersist, Select, HEALTH, daysLabel, plural, toast, toastError, Modal } from '../lib.js';
import { call, saveAs } from '../api.js';
import { addCertFromLoa } from './record.js';

export function Devices({ app }) {
  const [cov, reload] = useLoad(() => call('deviceCoverage'), [app.version]);
  const [f, setF] = usePersist('devices', { platform: '', bundle: '', gaps: false });
  const [cl, setCl] = useState(false);
  const [vl, setVl] = useState(false);
  const [clPlan] = useLoad(() => call('clCleanupPlan'), [app.version]);
  const rows = useMemo(() => {
    if (!cov) return [];
    const q = (app.search || '').toLowerCase();
    return cov.rows.filter((r) => (!f.platform || r.platform === f.platform) && (!f.bundle || r.bundle === f.bundle) && (!f.gaps || r.missing)
      && (!q || `${r.device} ${r.grp}`.toLowerCase().includes(q)));
  }, [cov, f, app.search]);
  if (!cov) return html`<div class="row"><${Spinner} /> Loading…</div>`;

  const done = () => { reload(); app.refresh(); };
  const create = async (items) => {
    try { toast(`Created ${plural(await call('createMissing', items), 'placeholder')}. They stay gaps until each LOA is added.`, 'ok'); done(); } catch (e) { toastError(e); }
  };
  const l3 = async () => {
    try { await saveAs(`L3 approval numbers${f.platform ? ` ${f.platform}` : ''}${f.bundle ? ` ${f.bundle}` : ''}.xlsx`, await call('exportL3Sheet', { platform: f.platform, bundle: f.bundle }), [{ name: 'Excel', extensions: ['xlsx'] }]); } catch (e) { toastError(e); }
  };
  const setNa = async (row, slot, v) => { try { await call('setCoverageNA', row.key, slot, v); reload(); } catch (e) { toastError(e); } };
  const gaps = rows.flatMap((r) => cov.columns.filter((c) => r.cells[c.key].status === 'missing').map((c) => ({ device: r.device, platform: r.platform, bundle: r.bundle, slot: c.key })));
  const createAll = () => { if (confirm(`Create ${plural(gaps.length, 'placeholder')} for the missing certifications shown? They stay marked "Needs LOA" and count as gaps until each letter is added.`)) create(gaps); };
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
    <div class="page-head"><div><h1>Devices</h1><p>Click a device to see everything it is certified for. What each device needs to be certified. PCI, L1 Contact and L2 Contact are held once per device and shared by all its hardware versions. Each hardware version (CL1, CL2, CL3; a name without a suffix is CL1) needs its own L1 Contactless, TQM and L2 Contactless from each brand. Certifications marked end of life are not gaps.</p></div>
      <div class="row">${clPlan && clPlan.length ? html`<button class="btn" onClick=${() => setCl(true)} title="Device names that do not follow the hardware version (CL) rules"><${Icon} name="warn" /> Clean up ${plural(clPlan.length, 'CL name')}</button>` : null}
        <button class="btn" onClick=${() => setVl(true)} title="Manufacturer letters saying one family LoA covers every model"><${Icon} name="file" /> Validity letters</button>
        <button class="btn" onClick=${l3} title="Every device's L1, L2 and brand approval numbers, for acquirers' Level 3 work"><${Icon} name="download" /> L3 sheet</button>
        ${gaps.length && oneGroup ? html`<button class="btn" onClick=${createAll} title="Creates placeholders marked Needs LOA. They stay gaps until each letter is added."><${Icon} name="plus" /> Create ${plural(gaps.length, 'placeholder')}</button>` : null}</div></div>
    ${vl ? html`<${ValidityLetters} onClose=${() => setVl(false)} />` : null}
    ${cl ? html`<${ClCleanup} plan=${clPlan} app=${app} onClose=${() => setCl(false)} />` : null}
    <div class="filters">
      <${Select} value=${f.platform} onChange=${(v) => setF({ ...f, platform: v, bundle: '' })} placeholder="All platforms" options=${platforms} />
      <${Select} value=${f.bundle} onChange=${(v) => setF({ ...f, bundle: v })} placeholder="All bundles" options=${bundles} />
      <label class="check small"><input type="checkbox" checked=${f.gaps} onChange=${(e) => setF({ ...f, gaps: e.target.checked })} /> Only devices with gaps</label>
      <span class="muted small">${plural(rows.length, 'device')} · ${plural(rows.reduce((n, r) => n + r.missing, 0), 'missing certification')}${!oneGroup && gaps.length ? ' · pick one platform and bundle to create them' : ''}</span>
      <span class="legend">${['expired', 'critical', 'warning', 'good'].map((k) => html`<span><i style=${`background:${HEALTH[k].color}`}></i>${HEALTH[k].label}</span>`)}<span><i class="miss"></i>Missing</span><span><i style="background:var(--none)"></i>End of life</span></span>
    </div>
    ${!rows.length ? html`<div class="card"><div class="empty"><${Icon} name="grid" /><h3>No devices to show</h3><div>Add records or change the filters.</div></div></div>` : html`
    <div class="table-wrap" style="max-height:calc(100vh - 250px)"><table class="mx cov">
      <thead><tr><th class="name" rowspan="2">Device</th>${spans.map((s) => html`<th class="cat" colspan=${s.n}>${s.group}</th>`)}</tr>
        <tr>${cov.columns.map((c) => html`<th style="top:31px">${c.label}</th>`)}</tr></thead>
      <tbody>${rows.map((row) => {
        const head = row.grp !== lastGrp ? html`<tr class="grp"><td colspan=${cov.columns.length + 1}>${row.grp}${gapsByGrp[row.grp] ? html` <span class="faint">· ${plural(gapsByGrp[row.grp], 'missing certification')}</span>` : null}</td></tr>` : null;
        lastGrp = row.grp;
        return html`${head}<tr class=${row.reader ? 'reader' : ''}><td class="name"><div class="nm" title=${row.label || row.device}>${row.reader ? html`<span class="faint" title="Hardware version of this device">↳ </span>` : null}<a class="devlink" title="Open this device: every certification, LOA and gap" onClick=${() => app.openDevice({ device: row.device, platform: row.platform || '', bundle: row.bundle || '' })}>${row.label || row.device}</a>${row.replacedBy ? html` <span class="tag" title=${`A newer hardware version exists: ${row.replacedBy}`}>replaced by ${row.replacedBy.replace(/^.*?(CL\d+)\)?$/, '$1')}</span>` : null}${row.retired ? html` <span class="tag" title="Every certification of this device is end of life">EOL</span>` : null}${row.missing ? html` <span class="pill bad" title="Missing certifications">${row.missing}</span>` : null}</div></td>${cov.columns.map((c) => {
          const cell = row.cells[c.key];
          const r = cell.record;
          if (r && cell.status === 'awaiting') {
            return html`<td><span class="cell miss" title=${`${row.device} · ${c.group} ${c.label}\nA placeholder with no LOA yet. It is still a gap until the letter is added.`} onClick=${() => app.openRecord(r.id, 'documents')}>Needs LOA<small>add letter</small></span></td>`;
          }
          if (r) {
            return html`<td><span class=${`cell ${r.health}${r.sharedFrom ? ' shared' : ''}`} title=${`${row.device} · ${c.group} ${c.label}\n${r.approval_number || ''}\nExpires ${fmtDate(r.expiry_date) || 'unknown'}${r.sharedFrom ? `\nCertified by the ${r.sharedFrom} LOA` : ''}`} onClick=${() => app.openRecord(r.id)}>
              ${r.expiry_date ? fmtDate(r.expiry_date).replace(/^(\w+) \d+, (\d+)$/, '$1 $2') : 'No date'}<small>${r.eol ? 'EOL' : r.sharedFrom ? `via ${r.sharedFrom}` : r.expiry_date ? daysLabel(r.days) : 'add LOA'}</small></span></td>`;
          }
          if (cell.status === 'missing') {
            return html`<td><span class="cell miss" title=${`${row.device} has no ${c.group} ${c.label} record`}>Missing<small>
              <button class="linkbtn" onClick=${() => addCertFromLoa(app, { device: row.device, platform: row.platform, bundle: row.bundle, slot: c.key }, `${row.label || row.device} · ${c.group} ${c.label}`, reload)} title="Choose its LOA. The certification is added from the letter.">Add LOA</button> ·
              <button class="linkbtn" onClick=${() => setNa(row, c.key, true)} title="This device does not need it (a waiver or no reader)">N/A</button></small></span></td>`;
          }
          if (cell.status === 'na') return html`<td><button class="cell na" onClick=${() => setNa(row, c.key, false)} title="Marked not applicable. Click to require it again.">N/A</button></td>`;
          return html`<td></td>`;
        })}</tr>`;
      })}</tbody></table></div>`}`;
}

/**
 * Hardware version clean-up: a bare name is CL1 once a CL2 exists (or other records already
 * say CL1) for contactless, TQM and L2 contactless; PCI and contact approvals sit on the device.
 */
function ClCleanup({ plan, app, onClose }) {
  const [on, setOn] = useState(() => new Set(plan.map((x) => x.id)));
  const [busy, setBusy] = useState(false);
  const flip = (id) => { const n = new Set(on); if (n.has(id)) n.delete(id); else n.add(id); setOn(n); };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await call('applyClCleanup', [...on]);
      toast(`${plural(r.renamed, 'record')} renamed, ${plural(r.merged, 'duplicate')} merged${r.skipped.length ? `, ${r.skipped.length} skipped: ${r.skipped.map((x) => `${x.label} (${x.reason})`).join('; ')}` : ''}. A backup was taken first.`, r.skipped.length ? '' : 'ok');
      app.refresh(); onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return html`<${Modal} title="Clean up hardware version (CL) names" wide onClose=${onClose}>
    <p class="muted small" style="margin-top:0">CL1, CL2 and CL3 are separate device models. A name without CL is the only version until a CL2 arrives; from then on the first version is CL1. L1 Contactless, TQM and L2 Contactless belong to one version; PCI, L1 Contact and L2 Contact belong to the device and are shared. A merge keeps the record with the later expiry, moves the other's LOAs to it and archives the other.</p>
    <div style="max-height:56vh;overflow:auto"><table><thead><tr><th></th><th>Now</th><th>Becomes</th><th>Approval</th><th>Where</th><th>Why</th></tr></thead><tbody>
      ${plan.map((x) => html`<tr><td><input type="checkbox" checked=${on.has(x.id)} onChange=${() => flip(x.id)} aria-label=${`Fix ${x.from}`} /></td>
        <td>${x.from}</td><td><b>${x.to}</b>${x.action === 'merge' ? html`<div class="small"><span class="pill warning">merge</span> with the ${x.into.device} record${x.into.expiry_date ? ` (expires ${fmtDate(x.into.expiry_date)})` : ''}</div>` : null}</td>
        <td class="small">${x.scheme && x.scheme !== 'EMVCo' ? `${x.scheme} ` : ''}${x.category}${x.expiry_date ? html`<div class="faint">expires ${fmtDate(x.expiry_date)}</div>` : null}</td>
        <td class="small">${[x.platform, x.bundle].filter(Boolean).join(' · ') || '—'}</td><td class="small muted">${x.why}</td></tr>`)}
    </tbody></table></div>
    <div class="row mt"><button class="btn primary" disabled=${busy || !on.size} onClick=${apply}>${busy ? html`<${Spinner} />` : null} Apply ${plural(on.size, 'change')}</button><span class="faint small">A backup is taken first.</span></div>
  <//>`;
}

/** Every manufacturer validity letter read from the inbox, newest first per family. */
function ValidityLetters({ onClose }) {
  const [list] = useLoad(() => call('listValidityLetters'), []);
  const [open, setOpen] = useState(null);
  return html`<${Modal} title="Validity letters" wide onClose=${onClose}>
    <p class="faint small">A validity letter is the manufacturer's signed statement that an L2 approval won on one model of a family is valid on every model of it. A contact letter lets a sibling's L2 Contact LoA fill a device's gap. A contactless letter is evidence and a kernel reference only: approvals stay per product. Drop new letters in the LOA inbox.</p>
    ${!list ? html`<${Spinner} />` : !list.length ? html`<div class="empty"><${Icon} name="file" /><h3>No validity letters yet</h3><div>Drop them in the LOA inbox and they are read automatically.</div></div>` : html`
    <table class="mt"><thead><tr><th>Family</th><th>Interface</th><th>Reference</th><th>Dated</th><th>Products</th><th></th></tr></thead><tbody>
      ${list.map((L) => html`<tr class=${L.current ? '' : 'faint'}><td>${L.family}${L.nextGen ? ' (incl. Next-Gen)' : ''}</td><td>${L.interface}</td><td>${L.reference || '—'}</td><td class="nowrap">${fmtDate(L.issued) || '—'}${L.current ? '' : html` <span class="tag">replaced</span>`}</td>
        <td><a href="#" onClick=${(e) => { e.preventDefault(); setOpen(open === L.inboxId ? null : L.inboxId); }}>${plural(L.products.length, 'product')}${L.kernels.length ? `, ${plural(L.kernels.length, 'kernel')}` : ''}</a></td>
        <td>${L.document_id ? html`<button class="btn sm ghost" onClick=${() => openDoc({ id: L.document_id })}><${Icon} name="eye" /> Open</button>` : null}</td></tr>
        ${open === L.inboxId ? html`<tr><td colspan="6"><${ValiditySummary} v=${L} /></td></tr>` : null}`)}
    </tbody></table>`}
  <//>`;
}
