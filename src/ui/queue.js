// Background LOA intake queue. Files keep processing while the user moves
// between screens; screens subscribe to progress.
import { call } from './api.js';
import { extractFile, LOA_EXTENSIONS } from './extract.js';

const state = { items: [], running: false };
const subs = new Set();
let seq = 0;

function emit() { for (const fn of subs) fn({ ...state, items: [...state.items] }); }
export function subscribe(fn) { subs.add(fn); fn({ ...state, items: [...state.items] }); return () => subs.delete(fn); }
export function snapshot() { return { ...state, items: [...state.items] }; }

export function clearFinished() {
  state.items = state.items.filter((i) => i.status === 'queued' || i.status === 'working');
  emit();
}

const isLoa = (name) => LOA_EXTENSIONS.includes(name.toLowerCase().split('.').pop());

/** Add File objects (from a drop or a file input). Returns how many were accepted. */
export function addFiles(files, { onDone } = {}) {
  let n = 0;
  for (const f of files) {
    if (!isLoa(f.name)) continue;
    state.items.push({ id: ++seq, name: f.name, size: f.size, file: f, status: 'queued', progress: 0, note: 'Waiting', onDone });
    n++;
  }
  emit();
  run();
  return n;
}

async function run() {
  if (state.running) return;
  state.running = true;
  emit();
  try {
    for (;;) {
      const it = state.items.find((i) => i.status === 'queued');
      if (!it) break;
      it.status = 'working';
      emit();
      try {
        const bytes = new Uint8Array(await it.file.arrayBuffer());
        const ex = await extractFile(it.name, bytes, {
          onProgress: (done, total, note) => { it.progress = total ? done / total : 0; it.note = note; emit(); },
        });
        it.note = 'Matching to your records';
        emit();
        const res = await call('ingestDocument', { filename: it.name, bytes, pages: ex.pages, ocrPages: ex.ocrPages });
        it.result = res;
        it.status = res.status === 'ok' ? 'done' : res.status;
        it.progress = 1;
        it.note = describe(res, ex);
      } catch (e) {
        it.status = 'error';
        it.note = e.message || String(e);
      }
      it.file = null; // release memory
      emit();
      if (it.onDone) it.onDone(it);
    }
  } finally {
    state.running = false;
    emit();
    for (const fn of doneListeners) fn();
  }
}

const doneListeners = new Set();
export function onQueueIdle(fn) { doneListeners.add(fn); return () => doneListeners.delete(fn); }

function describe(res, ex) {
  if (res.status === 'duplicate') return `Already imported as ${res.duplicateOf}`;
  if (res.status === 'unreadable') return res.message || 'No readable text';
  const parts = [`${res.letters} letter${res.letters === 1 ? '' : 's'} found`];
  if (res.pending) parts.push(`${res.pending} to review`);
  if (res.info) parts.push(`${res.info} informational`);
  if (ex.ocrPages) parts.push(`${ex.ocrPages} page${ex.ocrPages === 1 ? '' : 's'} scanned with OCR`);
  return parts.join(' · ');
}

/** Collect files from a drag-and-drop, walking dropped folders. */
export async function filesFromDrop(dt) {
  const out = [];
  const entries = [];
  for (const item of dt.items || []) {
    const e = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (e) entries.push(e);
  }
  if (!entries.length) return [...(dt.files || [])];
  const walk = async (entry, depth = 0) => {
    if (entry.isFile) {
      await new Promise((res) => entry.file((f) => { out.push(f); res(); }, () => res()));
    } else if (entry.isDirectory && depth < 6) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        if (!batch.length) break;
        for (const b of batch) await walk(b, depth + 1);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}
