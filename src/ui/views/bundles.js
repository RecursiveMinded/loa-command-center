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
  const [plat, setPlat] = usePersist('bundle-platform', '');
  const [pick, setPick] = usePersist('bundle', '');
  const platforms = list ? [...new Set(list.map((b) => b.platform).filter(Boolean))] : [];
  const pf = platforms.includes(plat) ? plat : (list && list.find((b) => b.key === pick) || {}).platform || platforms[0] || '';
  const inPf = list ? list.filter((b) => b.platform === pf) : [];
  const newest = [...inPf].reverse().find((b) => !b.gap) || inPf[inPf.length - 1];
  const key = inPf.find((b) => b.key === pick) ? pick : newest ? newest.key : '';
  const [view, reloadView] = useLoad(() => (key ? call('bundleView', key) : Promise.resolve(null)), [app.version, key]);
  const [ref, reloadRef] = useLoad(() => (pf ? call('platformReference', pf) : Promise.resolve(null)), [app.version, pf]);
  const [diff, setDiff] = useState(null);
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState(false);
  const input = useRef();

  // One page, or every bundle page of every platform at once (e.g. ARC 1-5 and UPP 0-6):
  // each fills its bundle's kernels and dates, so the app knows the whole history.
  const readPage = async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    setBusy(true);
    const done = [];
    try {
      for (const f of files) {
        const b = new Uint8Array(await f.arrayBuffer());
        const lower = f.name.toLowerCase();
        let p;
        if (/\.(html?|mhtml?|mht)$/.test(lower)) p = { filename: f.name, bytes: b };
        else if (lower.endsWith('.pdf')) { const ex = await extractPdf(b, { ocr: false, keepLines: true }); p = { filename: f.name, text: ex.pages.join('\n'), lines: ex.lines }; }
        else p = { filename: f.name, text: new TextDecoder().decode(b) };
        try { done.push(await call('readBundlePage', p)); } catch (er) { toastError(new Error(`${f.name}: ${er.message || er}`)); }
      }
      if (!done.length) return;
      const r = done[done.length - 1];
      setPick(r.key); setPlat(r.platform);
      app.refresh();
      if (done.length === 1) {
        // Differences pop up straight away, so they are dealt with now.
        if (!r.ok) setDiff(r);
        else toast(`${r.platform} ${r.bundle} matches the page: ${plural(r.pageDates, 'date')}`, 'ok');
      } else {
        const off = done.filter((x) => !x.ok);
        toast(`Read ${plural(done.length, 'bundle page')}: kernels filled in for each.${off.length ? ` ${off.map((x) => `${x.platform} ${x.bundle}`).join(', ')} differ from your records: open each bundle and press Review and fix.` : ' All match your records.'}`, off.length ? undefined : 'ok');
      }
    } catch (er) { toastError(er); } finally { setBusy(false); }
  };
  const openDiff = async () => { try { setDiff(await call('bundleDifferences', key)); } catch (e) { toastError(e); } };
  const print = async () => { try { printHtml((await call('bundleReport', key)).html); } catch (e) { toastError(e); } };
  const excel = async () => { try { await saveAs(`${view.platform} ${view.bundle}.xlsx`, await call('bundleReport', key, { format: 'xlsx' }), [{ name: 'Excel', extensions: ['xlsx'] }]); } catch (e) { toastError(e); } };

  if (!list) return html`<div class="row"><${Spinner} /> Loading…</div>`;
  const cur = list.find((b) => b.key === key);
  return html`
    <div class="page-head"><div><h1>Kernel bundles</h1><p>A bundle is a set of kernel versions packaged, loaded and certified together. An L2 LOA belongs to the bundles that run its kernel, not to every bundle with that device: renewals often land one to three bundles back.</p></div>
      <div class="row"><input ref=${input} type="file" multiple accept=".pdf,.html,.htm,.mhtml,.mht,.txt" class="hidden" onChange=${readPage} />
        <button class="btn primary" disabled=${busy} onClick=${() => input.current.click()} title="Read one or more published bundle pages (saved web pages or PDF printouts): pick every ARC and UPP page at once to load the whole bundle history">
          ${busy ? html`<${Spinner} />` : html`<${Icon} name="globe" />`} Check against website page</button>
        <button class="btn" onClick=${() => setCatalog(true)} title="Every bundle's kernel per card brand, for every platform"><${Icon} name="grid" /> Kernel catalog</button>
        ${key ? html`<button class="btn" onClick=${print}><${Icon} name="print" /> Report like the website</button>
          <button class="btn" onClick=${excel}><${Icon} name="download" /> Excel</button>` : null}</div></div>

    ${!list.length ? html`<div class="card"><div class="empty"><${Icon} name="grid" /><h3>No bundles yet</h3><div>Read a kernel bundle page (PDF or saved web page) to load its matrix, fill in the kernel catalog, or give your records a platform and bundle.</div></div></div>` : html`
    <div class="tabs">${platforms.map((p) => html`<button class=${p === pf ? 'on' : ''} onClick=${() => setPlat(p)}>${p} <span class="faint">· ${plural(list.filter((b) => b.platform === p && !b.unnumbered).length, 'bundle')}</span></button>`)}</div>

    ${ref ? html`<${Reference} r=${ref} selected=${key} onPick=${(k) => setPick(k)} app=${app} onChanged=${() => { reload(); reloadRef(); }} />` : html`<div class="row"><${Spinner} /> Loading…</div>`}

    ${cur ? html`<div class="card pad bundle-head mt">
      <div class="row wrap"><h3 style="margin:0">${cur.platform} ${cur.bundle}</h3><span class="muted small">laid out like the website page</span></div>
      ${cur.gap ? html`<div class="callout mt">Nothing recorded for this bundle yet. Read its website page, or fill in its kernels in the kernel catalog so LOAs for its kernels land here.</div>` : html`
      <div class="kpis compact mt">
        <div><div class="v">${cur.dates}</div><div class="l">expiry dates in the app</div></div>
        <div><div class="v">${cur.page ? cur.page.dates : '—'}</div><div class="l">${cur.page ? `on the website page` : 'website page not read yet'}</div></div>
        <div class="grow muted small">${cur.page ? html`Page: <b>${cur.page.filename}</b>, read ${fmtWhen(cur.page.at)}` : 'Read the bundle page to check every date against it.'}</div>
      </div>`}
      ${cur.issues && !cur.issues.ok ? html`<div class="callout warn mt row"><${Icon} name="warn" /><span class="grow">${describe(cur.issues)}</span>
        <button class="btn sm primary" onClick=${openDiff}>Review and fix</button></div>`
        : cur.issues ? html`<div class="callout good mt row"><${Icon} name="check" /><span class="grow">Matches the website page: ${plural(cur.issues.pageDates, 'date')}, each on one record.</span></div>` : null}
    </div>` : null}

    ${!view ? html`<div class="row"><${Spinner} /> Loading…</div>` : cur && cur.gap ? null : html`<${Layout} v=${view} app=${app} />`}`}
    ${catalog ? html`<${KernelCatalog} onClose=${() => { setCatalog(false); reload(); reloadView(); reloadRef(); app.refresh(); }} />` : null}
    ${diff ? html`<${Differences} d=${diff} app=${app} onClose=${() => setDiff(null)} onDone=${() => { setDiff(null); reload(); reloadView(); reloadRef(); app.refresh(); }} />` : null}`;
}

const shortB = (b) => String(b).replace(/^(kernel\s+)?bundle\s*/i, 'B');

/**
 * One platform's bundles side by side, as a reference: what each bundle holds (the kernel per
 * card brand, with the bundle where each new kernel arrived) and every device's L2 dates across
 * the bundles, so it is plain which bundles a renewal reached.
 */
function Reference({ r, selected, onPick, app, onChanged }) {
  const [brand, setBrand] = usePersist('bundle-ref-brand', '');
  const [count, setCount] = useState(null);
  const b = r.brands.includes(brand) ? brand : r.brands.find((x) => (r.l2[x] || []).length) || r.brands[0];
  const rows = r.l2[b] || [];
  const kRow = r.kernelRows.find((x) => x.key === b);
  const saveCount = async () => {
    try { await call('setBundleCount', r.platform, count); setCount(null); onChanged(); toast(`${r.platform}: ${plural(Number(count) || 0, 'bundle')} tracked`, 'ok'); } catch (e) { toastError(e); }
  };
  const head = html`<th class="name"></th>${r.bundles.map((x) => html`<th class=${`bcol ${x.key === selected ? 'sel' : ''} ${x.gap ? 'gapcol' : ''}`}>
    <a onClick=${() => onPick(x.key)} title=${x.gap ? 'Not filled in yet' : `Show ${x.platform} ${x.bundle} below`}>${x.bundle}</a>${x.gap ? html`<small class="faint" style="display:block;font-weight:400">not filled in</small>` : x.page ? html`<small class="faint" style="display:block;font-weight:400">website read</small>` : null}</th>`)}`;
  const showIds = (ids, label) => app.go('register', { filter: { ids, idsLabel: label } });
  const trim = async (n) => { try { await call('setBundleCount', r.platform, n); onChanged(); toast(`${r.platform}: ${plural(n, 'bundle')} tracked`, 'ok'); } catch (e) { toastError(e); } };
  const loose = r.unnumbered.reduce((n, g) => n + g.ids.length, 0);
  return html`
    ${r.notOnSite.length ? html`<div class="callout warn mt"><${Icon} name="warn" /> <b>${r.notOnSite.map((b) => b.bundle).join(', ')} ${r.notOnSite.length === 1 ? 'is' : 'are'} not on the ${r.platform} website pages you read</b> (the website lists ${r.siteBundles.map((n) => `Bundle ${n}`).join(', ')}).
      ${r.notOnSite.map((b) => (b.ids.length ? html` <button class="btn sm" onClick=${() => showIds(b.ids, `${r.platform} ${b.bundle}`)}>Show the ${plural(b.ids.length, 'record')} in ${b.bundle}</button>` : null))}
      ${r.notOnSite.some((b) => !b.ids.length && b.no > r.siteMax) ? html` <button class="btn sm primary" onClick=${() => trim(r.siteMax)}>Track ${r.siteMax} bundles, like the website</button>` : null}
      ${r.notOnSite.some((b) => !b.ids.length && b.no < r.siteMax) ? html` <span class="small">Read the missing bundle pages too, or ignore the empty columns.</span>` : null}</div>` : null}
    ${loose ? html`<div class="callout warn mt row"><${Icon} name="warn" /><span class="grow"><b>${plural(loose, `${r.platform} record`)} ${loose === 1 ? 'has' : 'have'} no bundle number</b> (${r.unnumbered.map((g) => (g.bundle ? `"${g.bundle}"` : 'blank')).join(', ')}). They are not counted as a bundle. Give each its bundle, or leave the bundle blank if it is not in one.</span>
      <button class="btn sm" onClick=${() => showIds(r.unnumbered.flatMap((g) => g.ids), `${r.platform} records without a bundle number`)}>Show them</button></div>` : null}
    <div class="card mt"><div class="hd"><h3>What is in each ${r.platform} bundle</h3>
      <span class="muted small grow">The kernel each bundle runs per card brand. <span class="knew-key">New</span> marks the bundle where a new kernel arrived; the same kernel often runs in several bundles.</span>
      ${count == null ? html`<button class="btn sm ghost" onClick=${() => setCount(String(r.bundles.length))} title="How many bundles this platform has, so all of them are tracked">${r.platform} has ${plural(r.bundles.length, 'bundle')}</button>`
        : html`<span class="row"><input type="number" min="1" max="50" value=${count} aria-label=${`Number of ${r.platform} bundles`} style="width:70px" onInput=${(e) => setCount(e.target.value)} /><button class="btn sm primary" onClick=${saveCount}>Save</button><button class="btn sm" onClick=${() => setCount(null)}>Cancel</button></span>`}</div>
      <div class="table-wrap"><table class="mx bundle kref"><thead><tr>${head}</tr></thead>
        <tbody>${r.kernelRows.map((k) => html`<tr class=${k.key === b ? 'hl' : ''}><td class="name">${k.label}</td>${k.cells.map((c, i) => html`<td class=${r.bundles[i].key === selected ? 'sel' : ''}>
          ${c.kernel ? html`<span class=${`kv ${c.changed ? 'knew' : ''}`} title=${c.changed ? 'A new kernel arrived in this bundle' : ''}>${c.kernel}${c.changed ? html`<small>new</small>` : null}</span>` : html`<span class="faint">—</span>`}</td>`)}</tr>`)}</tbody></table></div></div>

    <div class="card mt"><div class="hd"><h3>L2 contactless across the bundles</h3>
      <span class="muted small grow">Read across a row: a renewal for an older kernel lands in the older bundles that run it, and the newest bundle can still show the old date.</span></div>
      <div class="row wrap pad" style="padding-top:0">${r.brands.map((x) => html`<button class=${`chip ${x === b ? 'on' : ''}`} onClick=${() => setBrand(x)}>${x}${(r.l2[x] || []).length ? html` <span class="faint">${(r.l2[x] || []).length}</span>` : null}</button>`)}</div>
      <div class="table-wrap"><table class="mx bundle kref"><thead><tr><th class="name">Terminal</th>${r.bundles.map((x, i) => html`<th class=${`bcol ${x.key === selected ? 'sel' : ''}`}><a onClick=${() => onPick(x.key)}>${shortB(x.bundle)}</a>
          <small class="faint" style="display:block;font-weight:400">${kRow && kRow.cells[i].kernel ? `kernel ${kRow.cells[i].kernel}` : 'kernel ?'}</small></th>`)}</tr></thead>
        <tbody>${rows.length ? rows.map((row) => html`<tr><td class="name">${row.device}</td>${r.bundles.map((x) => { const c = row.cells[x.key];
          return c ? html`<${Cell} c=${c} app=${app} />` : html`<td class=${x.key === selected ? 'sel' : ''}><span class="faint">—</span></td>`; })}</tr>`)
          : html`<tr><td colspan=${r.bundles.length + 1} class="muted">No ${b} L2 approvals on ${r.platform} yet.</td></tr>`}</tbody></table></div></div>`;
}

const countIssues = (i) => i.missing + i.pageNewer + i.recordNewer + i.extra + i.undated + i.duplicates + (i.waiver || 0);

function describe(i) {
  const parts = [
    i.missing && `${plural(i.missing, 'date')} on the page ${i.missing === 1 ? 'is' : 'are'} missing here`,
    i.pageNewer && `${plural(i.pageNewer, 'record')} ${i.pageNewer === 1 ? 'is' : 'are'} older than the page`,
    i.recordNewer && `${plural(i.recordNewer, 'record')} ${i.recordNewer === 1 ? 'is' : 'are'} newer than the website`,
    i.duplicates && `${plural(i.duplicates, 'duplicate')}`,
    i.waiver && `${plural(i.waiver, 'date')} struck through or XX on the website (waiver required)`,
    i.undated && `${plural(i.undated, 'record')} without a date`,
    i.extra && `${plural(i.extra, 'record')} not on the page`,
  ].filter(Boolean);
  return `${parts.join(', ')}.`;
}

function Cell({ c, app }) {
  if (!c) return html`<td><span class="faint" title="No approval on file">—</span></td>`;
  if (c.missing) return html`<td><span class="cell miss" title="On the website page, but there is no record for it">${mdy(c.page)}<small>missing here</small></span></td>`;
  const d = c.diff;
  const wk = c.wrongKernel;
  const note = wk ? `kernel ${wk.kernel}, not ${wk.expected}${wk.fits ? ` (fits ${wk.fits.replace(/^kernel\s+/i, '')})` : ''}` : d ? (d.kind === 'pageNewer' ? `web ${mdy(d.page)}` : d.kind === 'recordNewer' ? `web shows ${mdy(d.page)}` : 'not on page') : c.eol ? 'end of life' : c.restriction === 'waiver' ? 'waiver required' : c.restriction === 'mandate' ? 'scheme mandate' : '';
  const tip = `${c.approval_number ? `Approval ${c.approval_number}\n` : ''}${c.kernel_version ? `Kernel ${c.kernel_version}\n` : ''}${c.doc_count ? `${plural(c.doc_count, 'LOA')} on file` : 'No LOA on file'}${c.restriction === 'waiver' ? '\nExpired, restricted renewal: customers must request their own extension waiver' : c.restriction === 'mandate' ? '\nRenewal blocked by a scheme mandate: a new kernel and certification are needed' : ''}${wk ? `\nWrong kernel: the LOA is for ${wk.kernel}, the bundle runs ${wk.expected}. This date does not count for the bundle.${wk.fits ? ` It matches ${wk.fits}.` : ''}` : ''}${d ? `\n${d.kind === 'pageNewer' ? 'The website has a later date' : d.kind === 'recordNewer' ? 'The website needs updating' : 'Not on the website page'}` : ''}`;
  return html`<td><span class=${`cell ${c.eol ? 'retired' : c.health}${d ? ' differs' : ''}${wk ? ' wrongk' : ''}${c.restriction ? ` restr-${c.restriction}` : ''}`} title=${tip} onClick=${() => app.openRecord(c.id)}>
    <span class="d">${c.expiry_date ? mdy(c.expiry_date) : 'No date'}</span>${note ? html`<small>${note}</small>` : null}</span></td>`;
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
        <div class="row wrap mt">${v.brands.map((b) => html`<span class="chip" title=${b.alsoIn && b.alsoIn.length ? `Kernel ${b.kernel} also runs in ${b.alsoIn.join(', ')}: an LOA for it applies there too` : ''}>${b.label} <b>${b.kernel || '—'}</b>${b.alsoIn && b.alsoIn.length ? html`<span class="faint">also ${b.alsoIn.map((x) => x.replace(/^(kernel\s+)?bundle\s*/i, 'B')).join(', ')}</span>` : null}</span>`)}</div></div></div>
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
  ['waiver', 'Struck through or XX on the website', 'The website shows these as expired with a restricted renewal: customers must request their own extension waiver. The records are marked "waiver required".', true],
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
    if (k === 'waiver') return x.map((y) => `${rec(y.record)}: ${y.page ? `${mdy(y.page)} struck through` : 'XX'} on the page`);
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
      toast(`${d.platform} ${d.bundle}: ${[r.added && `${r.added} added`, r.updated && `${r.updated} updated`, r.merged && `${r.merged} duplicates merged`, r.archived && `${r.archived} archived`, r.waiver && `${r.waiver} marked waiver required`, r.flagged && `${r.flagged} flagged for the website`].filter(Boolean).join(', ') || 'nothing to change'}. Now ${a.recordDates} dates here, ${a.pageDates} on the page.`, 'ok');
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

/**
 * The kernel catalog: every bundle of every platform (ARC, UPP...) with the kernel it runs
 * per card brand. A bundle is a snapshot of the kernels current when it was cut, so one
 * kernel often runs in several bundles; an L2 LOA applies to each of them.
 */
function KernelCatalog({ onClose }) {
  const [cat, reload] = useLoad(() => call('kernelCatalog'), []);
  const [add, setAdd] = useState({ platform: '', bundle: '' });
  const [paste, setPaste] = useState(null);
  const file = useRef();
  if (!cat) return html`<${Modal} title="Kernel catalog" wide onClose=${onClose}><div class="row"><${Spinner} /> Loading…</div><//>`;
  const cols = ['EMV Contact', ...cat.brands];
  const spanOf = (b, brand, value) => cat.spans.find((x) => x.platform === b.platform && x.brand.toLowerCase() === brand.toLowerCase() && x.bundles.includes(b.bundle) && x.kernel === value);
  const save = async (b, brand, value) => {
    const cur = brand === 'EMV Contact' ? b.l2Contact : b.kernels[brand.toLowerCase()];
    if (String(value || '').trim() === String((cur && cur.value) || '')) return;
    try {
      await call('setKernelCatalog', brand === 'EMV Contact' ? { platform: b.platform, bundle: b.bundle, l2Contact: value } : { platform: b.platform, bundle: b.bundle, kernels: { [brand]: value } });
      reload();
    } catch (e) { toastError(e); }
  };
  const addBundle = async () => {
    try { await call('setKernelCatalog', { ...add, kernels: {} }); setAdd({ platform: add.platform, bundle: '' }); reload(); } catch (e) { toastError(e); }
  };
  const done = (r) => { toast(`Imported ${plural(r.kernels, 'kernel')} for ${plural(r.bundles, 'bundle')}`, 'ok'); reload(); };
  const importFile = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { done(await call('importKernelCatalog', { filename: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })); } catch (er) { toastError(er); }
  };
  const importText = async () => { try { done(await call('importKernelCatalog', { text: paste })); setPaste(null); } catch (e) { toastError(e); } };
  const remove = async (b) => { try { await call('removeKernelBundle', b.key); reload(); } catch (e) { toastError(e); } };
  const shared = cat.spans.filter((x) => x.bundles.length > 1);
  return html`<${Modal} title="Kernel catalog" wide onClose=${onClose}>
    <p class="muted small" style="margin-top:0">The kernel each bundle runs per card brand. A bundle is a snapshot of the kernels current when it was cut, so the same kernel often runs in several bundles: an L2 LOA applies to every bundle that runs its kernel. An older kernel in an older bundle can carry the longest renewal (a newer kernel is coming), and that is expected. Values read from a website page are filled in for you; type to correct them.</p>
    <div class="row wrap">
      <input type="file" ref=${file} class="hidden" accept=".xlsx,.csv,.txt" onChange=${importFile} />
      <button class="btn" onClick=${() => file.current.click()}><${Icon} name="upload" /> Import Excel or CSV</button>
      <button class="btn" onClick=${() => setPaste(paste == null ? '' : null)}><${Icon} name="edit" /> Paste a table</button>
      <span class="faint small">Columns: Platform, Bundle, then one per card brand and EMV Contact. Or Platform, Bundle, Brand, Kernel.</span></div>
    ${paste != null ? html`<div class="mt"><textarea rows="5" style="width:100%" placeholder=${'Platform\tBundle\tVisa\tMastercard\tAmex\tDiscover\nARC\tBundle 3\t0301\t0403\t0201\t0202'} value=${paste} onInput=${(e) => setPaste(e.target.value)} aria-label="Pasted kernel table"></textarea>
      <button class="btn primary sm" disabled=${!paste.trim()} onClick=${importText}>Import pasted table</button></div>` : null}
    <div class="table-wrap mt"><table class="mx bundle kcat"><thead><tr><th class="name">Bundle</th>${cols.map((c) => html`<th>${c}</th>`)}<th></th></tr></thead>
      <tbody>${cat.bundles.length ? cat.bundles.map((b) => html`<tr><td class="name"><b>${b.platform}</b> ${b.bundle}${b.page ? html`<small class="faint" style="display:block">website page read</small>` : null}</td>
        ${cols.map((c) => { const k = c === 'EMV Contact' ? b.l2Contact : b.kernels[c.toLowerCase()]; const sp = k && spanOf(b, c, k.value); const others = sp ? sp.bundles.filter((x) => x !== b.bundle) : [];
          return html`<td><input type="text" class=${`kin ${others.length ? 'shared' : ''}`} key=${`${b.key}|${c}|${k ? k.value : ''}`} defaultValue=${k ? k.value : ''} placeholder="—" aria-label=${`${b.platform} ${b.bundle} ${c} kernel`}
            title=${k ? `${k.source === 'page' ? 'From the website page' : 'Typed or imported'}${others.length ? `. Also runs in ${others.join(', ')}` : ''}` : 'Not known yet'} onBlur=${(e) => save(b, c, e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); }} />
            ${others.length ? html`<small class="faint" style="display:block">also ${others.map((x) => x.replace(/^(kernel\s+)?bundle\s*/i, 'B')).join(', ')}</small>` : null}</td>`; })}
        <td>${b.inCatalog ? html`<button class="btn ghost sm icon" title="Remove what you typed for this bundle" aria-label="Remove" onClick=${() => remove(b)}><${Icon} name="x" /></button>` : null}</td></tr>`)
        : html`<tr><td colspan=${cols.length + 2} class="muted">No bundles yet. Add one below, import a table, or read a bundle's website page.</td></tr>`}</tbody></table></div>
    <div class="row mt"><input type="text" placeholder="Platform, e.g. ARC" value=${add.platform} onInput=${(e) => setAdd({ ...add, platform: e.target.value })} aria-label="Platform" style="width:150px" />
      <input type="text" placeholder="Bundle, e.g. Bundle 3" value=${add.bundle} onInput=${(e) => setAdd({ ...add, bundle: e.target.value })} aria-label="Bundle" style="width:170px" />
      <button class="btn" disabled=${!add.platform.trim() || !add.bundle.trim()} onClick=${addBundle}><${Icon} name="plus" /> Add bundle</button></div>
    ${shared.length ? html`<div class="mt-l"><b>Kernels that run in more than one bundle</b>
      <ul class="small difflist">${shared.map((x) => html`<li>${x.platform} ${x.brand} <b>${x.kernel}</b>: ${x.bundles.join(', ')}</li>`)}</ul></div>` : null}
  <//>`;
}
