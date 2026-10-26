// Open, save a copy of, or locate an archived LOA.
import { html, Icon, toast, toastError } from './lib.js';
import { call, native, isDesktop, saveAs } from './api.js';

const TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', tif: 'image/tiff', tiff: 'image/tiff' };

export async function openDoc(d) {
  try {
    if (isDesktop) return await native('openDocument', { id: d.id });
    const f = await call('documentFile', d.id);
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    window.open(URL.createObjectURL(new Blob([f.bytes], { type: TYPES[ext] || 'application/octet-stream' })), '_blank', 'noopener');
  } catch (e) { toastError(e); }
  return null;
}

export async function saveDoc(d) {
  try {
    const saved = isDesktop ? await native('saveDocument', { id: d.id, name: d.filename })
      : await call('documentFile', d.id).then((f) => saveAs(f.name, f.bytes));
    if (saved) toast(isDesktop ? `Saved ${saved}` : 'Downloaded', 'ok');
  } catch (e) { toastError(e); }
}

export function showDoc(d) { return native('showDocument', { id: d.id }).catch(toastError); }

/** Open / Save a copy / Show in folder for one archived LOA. */
export function DocButtons({ d, compact }) {
  if (d.missing) return html`<span class="small bad-text" title="The archived file was moved or deleted">File missing</span>`;
  return html`<span class="row nowrap">
    <button class="btn sm ghost" onClick=${() => openDoc(d)} title="Open the LOA"><${Icon} name="eye" />${compact ? null : ' Open'}</button>
    <button class="btn sm ghost" onClick=${() => saveDoc(d)} title="Save a copy"><${Icon} name="download" />${compact ? null : ' Save copy'}</button>
    ${isDesktop ? html`<button class="btn sm ghost" onClick=${() => showDoc(d)} title="Show in folder"><${Icon} name="folder" /></button>` : null}
  </span>`;
}
