// Reads text out of LOA files in the renderer, fully offline.
// PDFs with a text layer go through pdf.js; scanned pages and images go
// through Tesseract OCR. Nothing leaves the machine.

import * as pdfjs from 'pdfjs-dist/build/pdf.min.mjs';

const base = new URL('./', location.href).href;
pdfjs.GlobalWorkerOptions.workerSrc = `${base}vendor/pdf.worker.min.mjs`;

const MIN_TEXT = 60; // fewer alphanumerics than this on a page means "scanned"

let ocrWorker = null;
let ocrBusy = Promise.resolve();

async function getOcr() {
  if (ocrWorker) return ocrWorker;
  const Tesseract = await import('tesseract.js');
  ocrWorker = await Tesseract.createWorker('eng', 1, {
    workerPath: `${base}vendor/tesseract/worker.min.js`,
    corePath: `${base}vendor/tesseract/`,
    langPath: `${base}vendor/tesseract/lang/`,
    workerBlobURL: false,
    gzip: true,
    cacheMethod: 'none',
  });
  return ocrWorker;
}

/** OCR one image (canvas, blob or bytes). Calls are serialized on one worker. */
export function ocrImage(image) {
  const job = ocrBusy.then(async () => {
    const w = await getOcr();
    const { data } = await w.recognize(image);
    return data.text || '';
  });
  ocrBusy = job.catch(() => {});
  return job;
}

export async function stopOcr() {
  if (ocrWorker) { const w = ocrWorker; ocrWorker = null; await w.terminate(); }
}

/** Group pdf.js text items into visual lines (top to bottom, left to right). */
function toLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    const h = Math.abs(it.transform[3]) || it.height || 10;
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, h * 0.4));
    if (!row) { row = { y, h, items: [] }; rows.push(row); }
    row.items.push({ x, w: it.width || 0, str: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows;
}

function lineText(row) {
  let out = '', end = null;
  for (const it of row.items) {
    if (end != null) {
      const gap = it.x - end;
      // Pieces of one word often arrive as separate items with no gap
      // ("Masterc" + "ard"); only a real gap becomes a space.
      if (gap > row.h * 1.5) out += '   ';
      else if (gap > row.h * 0.15 && !/\s$/.test(out) && !/^\s/.test(it.str)) out += ' ';
    }
    out += it.str;
    end = it.x + it.w;
  }
  return out.replace(/[ \t]+$/, '');
}

function pageText(rows) {
  // A blank line where the vertical gap is larger than a normal line step.
  const out = [];
  let prev = null;
  for (const r of rows) {
    if (prev && prev.y - r.y > Math.max(prev.h, r.h) * 1.9) out.push('');
    out.push(lineText(r));
    prev = r;
  }
  return out.join('\n');
}

async function renderPage(page, scale = 2.2) {
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

/**
 * Extract a PDF. Returns { pages: string[], lines: [[{y, items:[{x,str}]}]],
 * ocrPages, pageCount }. `onProgress(done, total, note)` is optional.
 */
export async function extractPdf(bytes, { onProgress = () => {}, ocr = true, keepLines = false } = {}) {
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
  const doc = await pdfjs.getDocument({
    data,
    cMapUrl: `${base}vendor/cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${base}vendor/standard_fonts/`,
    isEvalSupported: false,
  }).promise;
  const pages = [], lines = [];
  let ocrPages = 0;
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress(i - 1, doc.numPages, `Reading page ${i} of ${doc.numPages}`);
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const rows = toLines(tc.items);
      let text = pageText(rows);
      if (ocr && text.replace(/[^A-Za-z0-9]/g, '').length < MIN_TEXT) {
        onProgress(i - 1, doc.numPages, `Scanning page ${i} of ${doc.numPages} (OCR)`);
        const canvas = await renderPage(page);
        const ocrText = await ocrImage(canvas);
        if (ocrText.replace(/[^A-Za-z0-9]/g, '').length > text.replace(/[^A-Za-z0-9]/g, '').length) {
          text = ocrText;
          ocrPages++;
        }
      }
      pages.push(text);
      if (keepLines) lines.push(rows.map((r) => ({ y: r.y, items: r.items.map((it) => ({ x: it.x, str: it.str })) })));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  onProgress(doc.numPages, doc.numPages, 'Done');
  return { pages, lines, ocrPages, pageCount: pages.length };
}

/** Extract any supported LOA file: PDF, image, or plain text. */
export async function extractFile(name, bytes, opts = {}) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'pdf') return extractPdf(bytes, opts);
  if (['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp'].includes(ext)) {
    (opts.onProgress || (() => {}))(0, 1, 'Scanning image (OCR)');
    const text = await ocrImage(bytes);
    return { pages: [text], lines: [], ocrPages: 1, pageCount: 1 };
  }
  if (['txt', 'text'].includes(ext)) {
    const text = new TextDecoder().decode(bytes);
    return { pages: text.split('\f'), lines: [], ocrPages: 0, pageCount: 1 };
  }
  throw new Error(`Unsupported file type .${ext}`);
}

export const LOA_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp', 'txt'];
