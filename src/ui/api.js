// Calls into the core API: over IPC inside the desktop app, or over HTTP when
// the UI runs in a browser against the dev server (used for testing).

const bridge = typeof window !== 'undefined' ? window.loa : null;
export const isDesktop = !!bridge;

function encode(v) {
  if (v instanceof Uint8Array) return { __b64: toB64(v) };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
}
function decode(v) {
  if (v && typeof v === 'object' && typeof v.__b64 === 'string') return fromB64(v.__b64);
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
  return v;
}
function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b) {
  const s = atob(b);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export async function call(method, ...args) {
  let out;
  if (bridge) {
    out = await bridge.call(method, ...args);
  } else {
    const res = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(encode(args)) });
    out = decode(await res.json());
  }
  if (out && out.__error) throw new Error(out.message);
  return out;
}

export async function native(op, args = {}) {
  if (bridge) {
    const out = await bridge.native(op, args);
    if (out && out.__error) throw new Error(out.message);
    return out;
  }
  // Browser fallbacks for testing.
  switch (op) {
    case 'saveFile': download(args.name, args.bytes || args.text); return args.name;
    case 'savePdf': printHtml(args.html); return null;
    case 'openExternal': window.open(args.url, '_blank', 'noopener'); return true;
    case 'testNotification': return true;
    default: throw new Error('This action is available in the desktop app.');
  }
}

export function onEvent(channel, fn) {
  return bridge ? bridge.on(channel, fn) : () => {};
}

function download(name, data) {
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function printHtml(html) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.appendChild(f);
  f.contentDocument.open();
  f.contentDocument.write(html);
  f.contentDocument.close();
  setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 1000); }, 300);
}

/** Save bytes or text with a native Save dialog (desktop) or a download (browser). */
export function saveAs(name, data, filters) {
  const payload = typeof data === 'string' ? { text: data } : { bytes: data };
  return native('saveFile', { name, filters, ...payload });
}
