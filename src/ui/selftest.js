// Start-up self test used by CI (`--smoke-test`): proves the bundled PDF
// reader and OCR engine load and work inside the packaged app.
import { extractPdf, ocrImage } from './extract.js';
import { call } from './api.js';

function tinyPdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 14 Tf 72 700 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

export async function selfTest() {
  const result = { api: false, pdf: false, ocr: false };
  const info = await call('info');
  result.api = !!info.version;
  const pdf = await extractPdf(tinyPdf('Approval Expiration Date: January 5, 2029'), { ocr: false });
  result.pdf = /January 5, 2029/.test(pdf.pages[0]);
  const c = document.createElement('canvas');
  c.width = 900; c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000'; g.font = 'bold 64px Arial, sans-serif'; g.fillText('LOA 2029 TEST', 40, 105);
  const text = await ocrImage(c);
  result.ocr = /2029/.test(text);
  result.ok = result.api && result.pdf && result.ocr;
  return result;
}
