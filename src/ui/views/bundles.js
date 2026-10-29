import { useState, useRef, useEffect } from 'preact/hooks';
import { html, Icon, fmtDate, fmtWhen, plural, useLoad, Spinner, toast, toastError, Modal, usePersist, HEALTH } from '../lib.js';
import { call, saveAs, printHtml } from '../api.js';
import { extractPdf } from '../extract.js';

// A date as the website prints it: 01/13/30.
const mdy = (iso) => (iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(2, 4)}` : '');

/**
 * Each platform's kernel bundle, laid out like the published page: PCI,
 * EMV contact (L1 + TQM), EMV contactless (L1 + TQM), the bundle's EMV L2
 * contact kernel and the L2 contactless brand matrix. One date on the page
 * is one record; the page can be read in to find and fix every difference.
 */
export function Bundles({ app }) {
  const [list, reload] = useLoad(() => call('listBundles'), [app.version]);
  const [pick, setPick] = usePersist('bundle', '');
  const key = list && list.length ? (list.find((b) => b.key === pick) ? pick : list[0].key) : '';
  const [view, reloadView] = useLoad(() => (key ? call('bundleView', key) : Promise.resolve(null)), [app.version, key]);
  const [diff, setDiff] = useState(null);
  const [busy, setBusy] = useState(false);
  const input = useRef();

  const readPage = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    setBusy(true);
    try {
      const b = new Uint8Array(await f.arrayBuffer());
      const lower = f.name.toLowerCase();
      let p;
      if (/\.(html?|mhtml?|mht)$/.test(lower)) p = { filename: f.name, bytes: b };
      else if (lower.endsWith('.pdf')) { const ex = await extractPdf(b, { ocr: false, keepLines: true }); p = { filename: f.name, text: ex.pages.join('\n'), lines: ex.lines }; }
      else p = { filename: f.name, text: new TextDecoder().decode(b) };
      const r = await call('readBundlePage', p);
      setPick(r.key);
      app.refresh();
      // Differences pop up straight away, so they are dealt with now.
      if (!r.ok) setDiff(r);
      else toast(`${r.platform} ${r.bundle} matches the page: ${plural(r.pageDates, 'date')}`, 'ok');
    } catch (er) { toastError(er); } finally { setBusy(false); }
  };
  const openDiff = async () => { try { setDiff(await call('bundleDifferences', key)); } catch (e) { toastError(e); } };
  const print = async () => { try { printHtml((await call('bundleReport', key)).html); } catch (e) { toastError(e); } };
  const excel = async () => { try { await saveAs(`${view.platform} ${view.bundle}.xlsx`, await call('bundleReport', key, { format: 'xlsx' }), [{ name: 'Excel', extensions: ['xlsx'] }]); } catch (e) { toastError(e); } };

  if (!list) return html`<div class="row"><${Spinner} /> Loading…</div>`;
  const cur = list.find((b) => b.key === key);
  return html`
    <div class="page-head"><div><h1>Bundles</h1><p>Each platform's kernel bundle, laid out like your website. Every date on the website is one record here, no more and no less.</p></div>
      <div class="row"><input ref=${input} type="file" accept=".pdf,.html,.htm,.mhtml,.mht,.txt" class="hidden" onChange=${readPage} />
        <button class="btn primary" disabled=${busy} onClick=${() => input.current.click()} title="Read the published bundle page (PDF printout or saved web page) and compare it with your records">
          ${busy ? html`<${Spinner} />` : html`<${Icon} name="globe" />`} Check against website page</button>
        ${key ? html`<button class="btn" onClick=${print}><${Icon} name="print" /> Report like the website</button>
          <button class="btn" onClick=${excel}><${Icon} name="download" /> Excel</button>` : null}</div></div>

    ${!list.length ? html`<div class="card"><div class="empty"><${Icon} name="grid" /><h3>No bundles yet</h3><div>Read a kernel bundle page (PDF or saved web page) to load its matrix, or give your records a platform and bundle.</div></div></div>` : html`
    <div class="tabs">${list.map((b) => html`<button class=${b.key === key ? 'on' : ''} onClick=${() => setPick(b.key)}>${b.platform} · ${b.bundle}
      ${b.issues ? (b.issues.ok ? html`<span class="count good" title="Matches the website page">✓</span>` : html`<span class="count bad" title="Differences from the website page">${countIssues(b.issues)}</span>`) : null}</button>`)}</div>

    ${cur ? html`<div class="card pad bundle-head">
      <div class="kpis compact">
        <div><div class="v">${cur.dates}</div><div class="l">expiry dates in the app</div></div>
        <div><div class="v">${cur.page ? cur.page.dates : '—'}</div><div class="l">${cur.page ? `on the website page` : 'website page not read yet'}</div></div>
        <div class="grow muted small">${cur.page ? html`Page: <b>${cur.page.filename}</b>, read ${fmtWhen(cur.page.at)}` : 'Read the bundle page to check every date against it.'}</div>
      </div>
      ${cur.issues && !cur.issues.ok ? html`<div class="callout warn mt row"><${Icon} name="warn" /><span class="grow">${describe(cur.issues)}</span>
        <button class="btn sm primary" onClick=${openDiff}>Review and fix</button></div>`
        : cur.issues ? html`<div class="callout good mt row"><${Icon} name="check" /><span class="grow">Matches the website page: ${plural(cur.issues.pageDates, 'date')}, each on one record.</span></div>` : null}
    </div>` : null}

    ${!view ? html`<div class="row"><${Spinner} /> Loading…</div>` : html`<${Layout} v=${view} app=${app} />`}`}
    ${diff ? html`<${Differences} d=${diff} app=${app} onClose=${() => setDiff(null)} onDone=${() => { setDiff(null); reload(); reloadView(); app.refresh(); }} />` : null}`;
}

const countIssues = (i) => i.missing + i.pageNewer + i.recordNewer + i.extra + i.undated + i.duplicates;

function describe(i) {
  const parts = [
    i.missing && `${plural(i.missing, 'date')} on the page ${i.missing === 1 ? 'is' : 'are'} missing here`,
    i.pageNewer && `${plural(i.pageNewer, 'record')} ${i.pageNewer === 1 ? 'is' : 'are'} older than the page`,
    i.recordNewer && `${plural(i.recordNewer, 'record')} ${i.recordNewer === 1 ? 'is' : 'are'} newer than the website`,
    i.duplicates && `${plural(i.duplicates, 'duplicate')}`,
    i.undated && `${plural(i.undated, 'record')} without a date`,
    i.extra && `${plural(i.extra, 'record')} not on the page`,
  ].filter(Boolean);
  return `${parts.join(', ')}.`;
}

function Cell({ c, app }) {
  if (!c) return html`<td><span class="faint" title="No approval on file">—</span></td>`;
  if (c.missing) return html`<td><span class="cell miss" title="On the website page, but there is no record for it">${mdy(c.page)}<small>missing here</small></span></td>`;
  const d = c.diff;
  const note = d ? (d.kind === 'pageNewer' ? `web ${mdy(d.page)}` : d.kind === 'recordNewer' ? `web shows ${mdy(d.page)}` : 'not on page') : c.eol ? 'end of life' : '';
  const tip = `${c.approval_number ? `Approval ${c.approval_number}\n` : ''}${c.kernel_version ? `Kernel ${c.kernel_version}\n` : ''}${c.doc_count ? `${plural(c.doc_count, 'LOA')} on file` : 'No LOA on file'}${d ? `\n${d.kind === 'pageNewer' ? 'The website has a later date' : d.kind === 'recordNewer' ? 'The website needs updating' : 'Not on the website page'}` : ''}`;
  return html`<td><span class=${`cell ${c.eol ? 'retired' : c.health}${d ? ' differs' : ''}`} title=${tip} onClick=${() => app.openRecord(c.id)}>
    ${c.expiry_date ? mdy(c.expiry_date) : 'No date'}${note ? html`<small>${note}</small>` : null}</span></td>`;
}

function Table({ title, head, rows, cols, app, note }) {
  return html`<div class="card mt"><div class="hd"><h3>${title}</h3>${note ? html`<span class="muted small">${note}</span>` : null}</div>
    <div class="table-wrap"><table class="mx bundle"><thead><tr>${head.map((h, i) => html`<th class=${i ? '' : 'name'}>${h}</th>`)}</tr></thead>
    <tbody>${rows.length ? rows.map((r) => html`<tr><td class="name">${r.device}</td>${r.version !== undefined && cols[0] === '#version' ? html`<td>${r.version}</td>` : null}
      ${cols.filter((c) => c !== '#version').map((c) => html`<${Cell} c=${r.cells[c]} app=${app} />`)}</tr>`)
      : html`<tr><td colspan=${head.length} class="muted">None</td></tr>`}</tbody></table></div></div>`;
}

function Layout({ v, app }) {
  const l2 = v.l2contact;
  return html`
    <div class="legend mt">${['expired', 'critical', 'warning', 'good'].map((k) => html`<span><i style=${`background:${HEALTH[k].color}`}></i>${HEALTH[k].label}</span>`)}
      <span><i class="dash"></i>On the website, missing here</span></div>
    <div class="card mt pad"><b>Level 2 kernels</b> <span class="muted">· EMV Contact: one approval shared by every device in the bundle</span>
      <div class="row mt">${l2 ? html`<span class=${`cell ${l2.health}${l2.diff ? ' differs' : ''}`} style="display:inline-block" onClick=${() => app.openRecord(l2.id)}>
          ${v.l2contactKernel ? `v${v.l2contactKernel} · ` : ''}expires ${mdy(l2.expiry_date) || 'no date'}${l2.diff && l2.diff.page ? html`<small>web ${mdy(l2.diff.page)}</small>` : null}</span>`
        : v.l2missing ? html`<span class="cell miss" style="display:inline-block">v${v.l2missing.kernel_version} · ${mdy(v.l2missing.expiry_date)}<small>missing here</small></span>`
          : html`<span class="muted">No EMV L2 Contact kernel on file for this bundle.</span>`}</div>
      <div class="kernels mt"><b>Contactless kernels by card brand</b>
        <div class="row wrap mt">${v.brands.map((b) => html`<span class="chip">${b.label} <b>${b.kernel || '—'}</b></span>`)}</div></div></div>
    <${Table} title="PCI" head=${['Terminal', 'Version', 'Exp Date']} rows=${v.sections.pci} cols=${['#version', 'date']} app=${app} />
    <${Table} title="EMV Contact" head=${['Terminal', 'L1 Contact', 'TQM']} rows=${v.sections.contact} cols=${['l1', 'tqm']} app=${app} />
    <${Table} title="EMV Contactless" head=${['Terminal', 'L1 Contactless', 'TQM']} rows=${v.sections.contactless} cols=${['l1', 'tqm']} app=${app} />
    <${Table} title="Level 2 · EMV Contactless" note="One approval per card brand" head=${['Terminal', ...v.brands.map((b) => (b.kernel ? html`${b.label}<small class="faint" style="display:block;font-weight:400">kernel ${b.kernel}</small>` : b.label))]} rows=${v.sections.l2contactless} cols=${v.brands.map((b) => b.key)} app=${app} />`;
}

const GROUPS = [
  ['missing', 'Missing here', 'Dates on the website page with no record. They will be added.', true],
  ['pageNewer', 'Older than the website', 'The page shows a later date, usually a renewal not yet recorded. The page date will be taken.', true],
  ['duplicates', 'Duplicates', 'More than one record for one cell. The one with LOAs (else the latest) is kept; its LOAs are moved over and the others go to the Archive.', true],
  ['undated', 'No expiry date', 'Placeholder rows such as "waiver required" that are not a date on the page. They go to the Archive (restorable).', true],
  ['recordNewer', 'Newer than the website', 'Your record has a later date than the page. It is kept, and the website is flagged for an update in the Website change request.', true],
  ['extra', 'Not on the website page', 'Dated records whose cell the page does not have (a device or brand dropped from the bundle, or one not published yet). Archive them only if they do not belong in this bundle.', false],
];

/** Every difference between a bundle and its website page, with one button to fix them. */
function Differences({ d, app, onClose, onDone }) {
  const [fix, setFix] = useState(() => Object.fromEntries(GROUPS.map(([k, , , on]) => [k, on])));
  const [open, setOpen] = useState('');
  const [busy, setBusy] = useState(false);
  const rec = (r) => `${r.device} · ${r.category === 'EMV L2 Contactless' ? r.scheme : r.category.replace('EMV ', '')}${r.category === 'PCI PTS' && r.kernel_version ? ` ${r.kernel_version}` : ''}${r.category === 'TQM' && r.kernel_version ? ` (${/PCD|less/i.test(r.kernel_version) ? 'contactless' : 'contact'})` : ''}`;
  const items = (k) => {
    const x = d.details[k] || [];
    if (k === 'missing') return x.map((p) => `${rec(p)}: ${mdy(p.expiry_date)}`);
    if (k === 'pageNewer' || k === 'recordNewer') return x.map((y) => `${rec(y.record)}: ${mdy(y.record.expiry_date) || 'no date'} here, ${mdy(y.page)} on the page`);
    if (k === 'duplicates') return x.map((y) => `${rec(y.keep)}: keeps ${mdy(y.keep.expiry_date)}, archives ${y.others.length}`);
    return x.map((r) => `${rec(r)}${r.expiry_date ? `: ${mdy(r.expiry_date)}` : ''}${r.notes ? ` · ${r.notes}` : ''}`);
  };
  const n = (k) => (k === 'duplicates' ? (d.details.duplicates || []).reduce((s, y) => s + y.others.length, 0) : (d.details[k] || []).length);
  const run = async () => {
    setBusy(true);
    try {
      const r = await call('cleanBundle', d.key, fix);
      const a = r.after;
      toast(`${d.platform} ${d.bundle}: ${[r.added && `${r.added} added`, r.updated && `${r.updated} updated`, r.merged && `${r.merged} duplicates merged`, r.archived && `${r.archived} archived`, r.flagged && `${r.flagged} flagged for the website`].filter(Boolean).join(', ') || 'nothing to change'}. Now ${a.recordDates} dates here, ${a.pageDates} on the page.`, 'ok');
      onDone();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return html`<${Modal} title=${`${d.platform} ${d.bundle} vs the website page`} wide onClose=${onClose}>
    <div class="callout ${d.ok ? 'good' : 'warn'}"><b>${d.pageDates} dates on the page (${d.filename}), ${d.recordDates} in the app.</b> ${d.same} already match.</div>
    ${GROUPS.filter(([k]) => n(k)).map(([k, label, help]) => html`<div class="diffgrp mt">
      <label class="check"><input type="checkbox" checked=${fix[k]} onChange=${(e) => setFix({ ...fix, [k]: e.target.checked })} /> <b>${label}: ${n(k)}</b></label>
      <div class="muted small">${help} <a onClick=${() => setOpen(open === k ? '' : k)}>${open === k ? 'Hide' : 'Show'} list</a></div>
      ${open === k ? html`<ul class="small difflist">${items(k).map((t) => html`<li>${t}</li>`)}</ul>` : null}</div>`)}
    ${d.ok ? html`<p class="mt">Nothing to fix.</p>` : null}
    <div class="row mt-l"><button class="btn primary" disabled=${busy || d.ok || !GROUPS.some(([k]) => fix[k] && n(k))} onClick=${run}>${busy ? html`<${Spinner} />` : html`<${Icon} name="check" />`} Make it match the website</button>
      <button class="btn" onClick=${onClose}>Not now</button><span class="faint small">A backup is taken first; archived records can be restored.</span></div>
  <//>`;
}
