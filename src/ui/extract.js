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

/**
 * OCR one image and keep where each word sits, as fractions of the image (for letter
 * templates). Returns { text, words: [{ x, y, w, h, t }] }.
 */
export function ocrImageWords(image, width, height) {
  const job = ocrBusy.then(async () => {
    const w = await getOcr();
    const { data } = await w.recognize(image, {}, { text: true, blocks: true });
    const words = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const wd of l.words || []) {
      const bb = wd.bbox;
      if (!wd.text || !wd.text.trim() || !width || !height) continue;
      words.push({ x: bb.x0 / width, y: bb.y0 / height, w: (bb.x1 - bb.x0) / width, h: (bb.y1 - bb.y0) / height, t: wd.text });
    }
    return { text: data.text || '', words };
  });
  ocrBusy = job.catch(() => {});
  return job;
}

/** Word boxes of a pdf.js page's text layer, as fractions of the page (top-left origin). */
function textWords(items, vp) {
  const out = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, , , d, e, f] = it.transform;
    const h = Math.abs(d) || it.height || 10;
    const width = it.width || Math.abs(a) * it.str.length * 0.5;
    const [x0, y0] = vp.convertToViewportPoint(e, f + h);
    const [x1, y1] = vp.convertToViewportPoint(e + width, f);
    const left = Math.min(x0, x1), top = Math.min(y0, y1), W = Math.abs(x1 - x0), H = Math.abs(y1 - y0);
    // One item often holds several words: share its width out by characters.
    const n = it.str.length || 1;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(it.str))) {
      out.push({ x: (left + (W * m.index) / n) / vp.width, y: top / vp.height, w: ((W * m[0].length) / n) / vp.width, h: H / vp.height, t: m[0] });
    }
  }
  return out;
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
  const pages = [], lines = [], words = [];
  let ocrPages = 0;
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress(i - 1, doc.numPages, `Reading page ${i} of ${doc.numPages}`);
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const rows = toLines(tc.items);
      let text = pageText(rows);
      let pageWords = textWords(tc.items, page.getViewport({ scale: 1 }));
      if (ocr && text.replace(/[^A-Za-z0-9]/g, '').length < MIN_TEXT) {
        onProgress(i - 1, doc.numPages, `Scanning page ${i} of ${doc.numPages} (OCR)`);
        const canvas = await renderPage(page);
        const o = await ocrImageWords(canvas, canvas.width, canvas.height);
        if (o.text.replace(/[^A-Za-z0-9]/g, '').length > text.replace(/[^A-Za-z0-9]/g, '').length) {
          text = o.text;
          pageWords = o.words;
          ocrPages++;
        }
      }
      for (const w of pageWords) words.push({ p: i - 1, ...w });
      pages.push(text);
      if (keepLines) lines.push(rows.map((r) => ({ y: r.y, items: r.items.map((it) => ({ x: it.x, str: it.str })) })));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  onProgress(doc.numPages, doc.numPages, 'Done');
  return { pages, lines, words, ocrPages, pageCount: pages.length };
}

/** Extract any supported LOA file: PDF, image, or plain text. */
export async function extractFile(name, bytes, opts = {}) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'pdf') return extractPdf(bytes, opts);
  if (['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp'].includes(ext)) {
    (opts.onProgress || (() => {}))(0, 1, 'Scanning image (OCR)');
    let size = { width: 0, height: 0 };
    try { const bmp = await createImageBitmap(new Blob([bytes])); size = { width: bmp.width, height: bmp.height }; bmp.close(); } catch (_) { /* positions unknown */ }
    const o = await ocrImageWords(bytes, size.width, size.height);
    return { pages: [o.text], lines: [], words: o.words.map((w) => ({ p: 0, ...w })), ocrPages: 1, pageCount: 1 };
  }
  if (['txt', 'text'].includes(ext)) {
    const text = new TextDecoder().decode(bytes);
    return { pages: text.split('\f'), lines: [], ocrPages: 0, pageCount: 1 };
  }
  throw new Error(`Unsupported file type .${ext}`);
}

export const LOA_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp', 'txt', 'eml', 'msg'];

/**
 * A sample letter for marking template regions: each page as an image (data URL)
 * and every word with its position. PDFs and images.
 */
export async function samplePages(name, bytes, { maxPages = 3, width = 1000 } = {}) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
    const doc = await pdfjs.getDocument({ data, cMapUrl: `${base}vendor/cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}vendor/standard_fonts/`, isEvalSupported: false }).promise;
    const out = { pages: [], words: [], texts: [] };
    try {
      for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
        const page = await doc.getPage(i);
        const vp1 = page.getViewport({ scale: 1 });
        const canvas = await renderPage(page, width / vp1.width);
        const tc = await page.getTextContent();
        let words = textWords(tc.items, vp1);
        let text = pageText(toLines(tc.items));
        if (text.replace(/[^A-Za-z0-9]/g, '').length < MIN_TEXT) {
          const big = await renderPage(page, 2.2);
          const o = await ocrImageWords(big, big.width, big.height);
          words = o.words; text = o.text;
        }
        out.pages.push(canvas.toDataURL('image/jpeg', 0.72));
        out.texts.push(text);
        for (const w of words) out.words.push({ p: i - 1, ...w });
        page.cleanup();
      }
    } finally { await doc.destroy(); }
    return out;
  }
  const blob = new Blob([bytes]);
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, width / bmp.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const o = await ocrImageWords(bytes, bmp.width, bmp.height);
  bmp.close();
  return { pages: [canvas.toDataURL('image/jpeg', 0.72)], words: o.words.map((w) => ({ p: 0, ...w })), texts: [o.text] };
}
