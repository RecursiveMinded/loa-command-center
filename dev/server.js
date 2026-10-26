'use strict';
// Development/test server: the same UI and API as the desktop app, over HTTP,
// so the interface can be exercised in a normal browser. Not shipped.
//   node dev/server.js [dataDir] [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { AppApi, PUBLIC_METHODS } = require('../src/core/api');

const dataDir = path.resolve(process.argv[2] || path.join(__dirname, '..', '.devdata'));
const port = Number(process.argv[3] || 5179);
const root = path.join(__dirname, '..', 'dist', 'ui');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.gz': 'application/gzip', '.wasm': 'application/wasm' };

function decode(v) {
  if (v && typeof v === 'object' && typeof v.__b64 === 'string') return Buffer.from(v.__b64, 'base64');
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
  return v;
}
function encode(v) {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { __b64: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
}

(async () => {
  const api = await AppApi.create({ dataDir });
  // Tests: LOA_FAKE_AI="NX200" makes the AI 'find' that device in any letter.
  if (process.env.LOA_FAKE_AI) api.ai.assistExtract = async (_text, missing) => (missing.includes('products') ? { products: [process.env.LOA_FAKE_AI] } : {});
  http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) {
        const method = url.pathname.slice(5);
        let body = '';
        for await (const c of req) body += c;
        let out;
        if (!PUBLIC_METHODS.includes(method)) out = { __error: true, message: `Unknown method ${method}` };
        else {
          try { out = await api[method](...decode(JSON.parse(body || '[]'))); } catch (e) { out = { __error: true, message: e.message }; }
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(encode(out === undefined ? null : out)));
        return;
      }
      const file = path.normalize(path.join(root, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
      if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500); res.end(e.message);
    }
  }).listen(port, '127.0.0.1', () => console.log(`LOA Command Center dev server: http://127.0.0.1:${port}  (data: ${dataDir})`));
})();
