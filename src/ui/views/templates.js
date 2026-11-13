import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, fmtDate, fmtWhen, plural, useLoad, Spinner, toast, toastError } from '../lib.js';
import { call } from '../api.js';
import { samplePages } from '../extract.js';

const COLORS = { device: '#2563eb', approval: '#7c3aed', issued: '#0891b2', expires: '#dc2626', kernel: '#16a34a' };

/**
 * Letter templates: open a sample LOA of one type, then drag a box around each value
 * (device list, approval number, dates, kernel). Every later letter of that type is
 * read from the same places, so OCR and odd layouts stop hiding values.
 */
export function LetterTemplates() {
  const [data, reload] = useLoad(() => call('listLetterTemplates'), []);
  const [type, setType] = useState('');
  const [sample, setSample] = useState(null);
  const [page, setPage] = useState(0);
  const [regions, setRegions] = useState([]);
  const [field, setField] = useState('expires');
  const [drag, setDrag] = useState(null);
  const [preview, setPreview] = useState([]);
  const [busy, setBusy] = useState('');
  const [dirty, setDirty] = useState(false);
  const [guess, setGuess] = useState('');
  // Every box change can be undone (button or Ctrl+Z) and redone (Ctrl+Y).
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const keys = useRef({});
  const file = useRef();
  const stage = useRef();

  const types = data ? data.types : [];
  const cur = types.find((t) => t.key === type) || types[0];
  // Opening a type shows its saved regions on its saved sample.
  useEffect(() => {
    if (!cur) return;
    const t = cur.template;
    setRegions(t ? t.regions : []);
    setSample(t && t.sample ? t.sample : null);
    setPage(0); setDirty(false); setGuess(''); setPast([]); setFuture([]);
  }, [cur && cur.key, data]);
  useEffect(() => {
    const k = (e) => {
      if (!(e.ctrlKey || e.metaKey) || /INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return;
      const key = e.key.toLowerCase();
      const { undo, redo } = keys.current;
      if (!undo) return;
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  useEffect(() => {
    if (!sample || !regions.length) { setPreview([]); return; }
    call('previewLetterTemplate', regions, sample.words || []).then(setPreview).catch(() => setPreview([]));
  }, [sample, regions]);

  if (!data) return html`<div class="row"><${Spinner} /> Loading…</div>`;
  const fields = data.fields;
  const change = (next) => { setPast([...past, regions]); setFuture([]); setRegions(next); setDirty(true); };
  const undo = () => { if (!past.length) return; setFuture([regions, ...future]); setRegions(past[past.length - 1]); setPast(past.slice(0, -1)); setDirty(true); };
  const redo = () => { if (!future.length) return; setPast([...past, regions]); setRegions(future[0]); setFuture(future.slice(1)); setDirty(true); };
  keys.current = { undo, redo };
  const removeBox = (r) => change(regions.filter((x) => x !== r));
  const revert = () => { if (!cur.template) return; change(cur.template.regions || []); setDirty(false); };
  const flabel = (k) => (fields.find((f) => f.key === k) || {}).label || k;

  const load = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    setBusy(`Reading ${f.name}…`);
    try {
      const s = await samplePages(f.name, new Uint8Array(await f.arrayBuffer()));
      setSample({ name: f.name, pages: s.pages, words: s.words });
      setPage(0); setDirty(true);
      const k = await call('sampleLetterType', s.texts);
      setGuess(k && k !== cur.key ? k : '');
      if (!s.words.length) toast('No words were found on this sample. Boxes can be drawn, but nothing can be read from them.');
    } catch (er) { toastError(er); } finally { setBusy(''); }
  };
  const pos = (ev) => {
    const r = stage.current.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)) };
  };
  const down = (ev) => { if (ev.button !== 0) return; ev.preventDefault(); const p = pos(ev); setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); };
  const move = (ev) => { if (drag) { const p = pos(ev); setDrag({ ...drag, x1: p.x, y1: p.y }); } };
  const up = () => {
    if (!drag) return;
    const r = { field, page, x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
    setDrag(null);
    if (r.w < 0.01 || r.h < 0.005) return;
    // One box per field: drawing it again moves it.
    change([...regions.filter((x) => x.field !== field), r]);
    const next = fields.find((f) => f.key !== field && !regions.some((x) => x.field === f.key));
    if (next) setField(next.key);
  };
  const save = async () => {
    setBusy('Saving…');
    try {
      await call('saveLetterTemplate', cur.key, { regions, sample });
      toast(regions.length ? `${cur.label}: template saved. New letters of this type are read from these boxes; press Re-read in the LOA inbox for ones waiting.` : `${cur.label}: saved with its sample LOA. Draw the boxes whenever you are ready; nothing is read from it until then.`, 'ok');
      setDirty(false); reload();
    } catch (e) { toastError(e); } finally { setBusy(''); }
  };
  const remove = async () => {
    if (!confirm(`Remove the ${cur.label} template?`)) return;
    try { await call('removeLetterTemplate', cur.key); reload(); } catch (e) { toastError(e); }
  };
  const box = (r, i) => html`<div class="tpl-box" key=${i} style=${`left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%;border-color:${COLORS[r.field]};background:${COLORS[r.field]}22`}>
    <span style=${`background:${COLORS[r.field]}`}>${flabel(r.field)}${i !== 'd' ? html`<button class="tpl-x" aria-label=${`Remove the ${flabel(r.field)} box`} title="Remove this box"
      onMouseDown=${(e) => e.stopPropagation()} onClick=${(e) => { e.stopPropagation(); removeBox(r); }}>×</button>` : null}</span></div>`;
  const pv = (k) => preview.find((x) => x.field === k);
  const show = (k, v) => (v == null ? '' : Array.isArray(v) ? v.join(', ') : /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(v) : String(v));

  return html`<div class="tpl">
    <div class="card tpl-types">
      <div class="hd"><h3>Letter types</h3></div>
      ${types.map((t) => html`<button class=${`tpl-type ${t.key === cur.key ? 'on' : ''}`} onClick=${() => { if (!dirty || confirm('Discard the boxes you have not saved?')) setType(t.key); }}>
        <span class="grow">${t.label}</span>${t.template && t.template.regions.length ? html`<span class="pill good" title=${`Saved ${fmtWhen(t.template.savedAt)}`}>${plural(t.template.regions.length, 'box', 'boxes')}</span>`
          : t.template ? html`<span class="pill warning" title=${`Saved ${fmtWhen(t.template.savedAt)}`}>saved, no boxes yet</span>` : html`<span class="faint small">not mapped</span>`}</button>`)}
      <p class="faint small" style="padding:8px 16px;margin:0">LOAs for other card brands are archived, so they need no template.</p>
      <div class="hd"><h3>Kernel labels learned</h3></div>
      ${data.kernelLabels.length ? data.kernelLabels.map((x) => html`<div class="row" style="padding:4px 16px"><span class="grow small"><b>${x.label}</b>${x.scheme ? html` <span class="faint">· ${x.scheme}</span>` : null}</span>
        <button class="btn ghost sm icon" aria-label=${`Forget ${x.label}`} onClick=${async () => { try { await call('removeKernelLabel', x.label); reload(); } catch (e) { toastError(e); } }}><${Icon} name="x" /></button></div>`)
        : html`<p class="faint small" style="padding:4px 16px;margin:0">None yet. When you type a kernel on a review card, I learn the words printed before it and read the next letters like it myself.</p>`}
    </div>
    <div class="card pad tpl-main">
      <div class="row wrap"><h3 style="margin:0">${cur.label}</h3><span class="grow"></span>
        <input type="file" ref=${file} class="hidden" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp" onChange=${load} />
        <button class="btn" disabled=${!!busy} onClick=${() => file.current.click()}><${Icon} name="upload" /> ${sample ? 'Use another sample' : 'Open a sample LOA'}</button>
        ${cur.template ? html`<button class="btn ghost" onClick=${remove}><${Icon} name="trash" /> Remove</button>` : null}
        <button class="btn primary" disabled=${!!busy || (!dirty && !!cur.template)} onClick=${save}><${Icon} name="check" /> Save template</button></div>
      <p class="muted small">Open one ${cur.label} letter, pick a value below, then drag a box around where it is printed. Boxes are kept as positions on the page, so letters scanned at another size still line up. The box text and the value it gives are shown underneath.</p>
      ${guess ? html`<div class="callout warn">This sample looks like ${(types.find((t) => t.key === guess) || {}).label}. <a onClick=${() => { const s = sample; setType(guess); setTimeout(() => { setSample(s); setDirty(true); }, 0); }}>Map it there instead</a></div>` : null}
      <div class="row wrap mt">${fields.map((f) => html`<button class=${`chip ${f.key === field ? 'on' : ''}`} onClick=${() => setField(f.key)}>
        <i class="sw" style=${`background:${COLORS[f.key]}`}></i>${f.label}${regions.some((r) => r.field === f.key) ? ' ✓' : ''}</button>`)}</div>
      <div class="row wrap mt tpl-tools">
        <button class="btn sm" disabled=${!past.length} onClick=${undo} title="Undo (Ctrl+Z)"><${Icon} name="undo" /> Undo</button>
        <button class="btn sm" disabled=${!future.length} onClick=${redo} title="Redo (Ctrl+Y)"><${Icon} name="redo" /> Redo</button>
        <button class="btn sm ghost" disabled=${!regions.length} onClick=${() => change([])}>Clear all boxes</button>
        ${cur.template && dirty ? html`<button class="btn sm ghost" onClick=${revert}>Back to saved</button>` : null}
        <span class="faint small">Click × on a box to remove it, or draw the same value again to move it.</span></div>
      ${busy ? html`<div class="row mt"><${Spinner} /> ${busy}</div>` : null}
      ${sample ? html`
        ${sample.pages.length > 1 ? html`<div class="tabs mt">${sample.pages.map((_, i) => html`<button class=${i === page ? 'on' : ''} onClick=${() => setPage(i)}>Page ${i + 1}</button>`)}</div>` : null}
        <div class="tpl-stage mt" ref=${stage} onMouseDown=${down} onMouseMove=${move} onMouseUp=${up} onMouseLeave=${up}>
          <img src=${sample.pages[page]} alt=${`Sample ${sample.name}, page ${page + 1}`} draggable="false" />
          ${regions.filter((r) => r.page === page).map(box)}
          ${drag ? box({ field, x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) }, 'd') : null}
        </div>
        <div class="faint small mt">Sample: ${sample.name}</div>`
        : html`<div class="empty mt"><${Icon} name="file" /><h3>No sample yet</h3><div>Open a ${cur.label} LOA (PDF or image) to mark where its values are.</div></div>`}
      ${regions.length ? html`<table class="mt tpl-read"><thead><tr><th>Value</th><th>Page</th><th>Text in the box</th><th>Reads as</th><th></th></tr></thead>
        <tbody>${regions.map((r) => { const p = pv(r.field); return html`<tr><td><i class="sw" style=${`background:${COLORS[r.field]}`}></i> ${flabel(r.field)}</td><td>${r.page + 1}</td>
          <td class="small">${p ? p.text || html`<span class="faint">nothing in this box</span>` : '…'}</td><td><b>${p ? show(r.field, p.value) || html`<span class="bad">no ${r.field === 'device' ? 'device' : 'value'}</span>` : ''}</b></td>
          <td><button class="btn ghost sm icon" aria-label="Remove box" onClick=${() => removeBox(r)}><${Icon} name="x" /></button></td></tr>`; })}</tbody></table>` : null}
    </div>
  </div>`;
}
