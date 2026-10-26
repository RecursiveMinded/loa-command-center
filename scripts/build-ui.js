'use strict';
// Bundles the renderer into dist/ui and copies the offline PDF/OCR assets.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'ui');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const watch = process.argv.includes('--watch');

function copy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.statSync(src).isDirectory()) {
    for (const f of fs.readdirSync(src)) copy(path.join(src, f), path.join(dst, f));
  } else fs.copyFileSync(src, dst);
}

function assets() {
  copy(path.join(root, 'src', 'ui', 'index.html'), path.join(out, 'index.html'));
  copy(path.join(root, 'src', 'ui', 'styles.css'), path.join(out, 'styles.css'));
  const v = path.join(out, 'vendor');
  copy(nm('pdfjs-dist', 'build', 'pdf.worker.min.mjs'), path.join(v, 'pdf.worker.min.mjs'));
  copy(nm('pdfjs-dist', 'cmaps'), path.join(v, 'cmaps'));
  copy(nm('pdfjs-dist', 'standard_fonts'), path.join(v, 'standard_fonts'));
  copy(nm('tesseract.js', 'dist', 'worker.min.js'), path.join(v, 'tesseract', 'worker.min.js'));
  for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
    copy(nm('tesseract.js-core', f), path.join(v, 'tesseract', f));
  }
  // The compact "best_int" English model: LSTM only, about 3 MB.
  copy(nm('@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'), path.join(v, 'tesseract', 'lang', 'eng.traineddata.gz'));
}

async function main() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  assets();
  const opts = {
    entryPoints: [path.join(root, 'src', 'ui', 'app.js')],
    bundle: true, format: 'esm', platform: 'browser', target: ['chrome120'],
    outfile: path.join(out, 'app.js'), minify: !watch, sourcemap: watch ? 'inline' : false,
    legalComments: 'none', logLevel: 'info',
    define: { 'process.env.NODE_ENV': '"production"' },
  };
  if (watch) { const ctx = await esbuild.context(opts); await ctx.watch(); } else await esbuild.build(opts);
}

main().catch((e) => { console.error(e); process.exit(1); });
