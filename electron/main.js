'use strict';
// Electron main process: window, tray, native dialogs, scheduled digest
// notifications, and the IPC bridge to the core API.

const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, nativeImage, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const { AppApi, PUBLIC_METHODS } = require('../src/core/api');

const APP_NAME = 'LOA Command Center';
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.loacommandcenter.app');

// The UI is served from app://ui/ so that fetch() and workers (PDF reader,
// OCR) can load their bundled files; file:// does not support fetch.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const UI_ROOT = path.join(__dirname, '..', 'dist', 'ui');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.gz': 'application/gzip', '.svg': 'image/svg+xml', '.png': 'image/png', '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream', '.ttf': 'font/ttf',
};
function registerUiProtocol() {
  protocol.handle('app', async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(UI_ROOT, rel));
    if (!file.startsWith(UI_ROOT + path.sep)) return new Response('Not found', { status: 404 });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch (_) {
      return new Response('Not found', { status: 404 });
    }
  });
}

let win = null;
let tray = null;
let api = null;
let quitting = false;
const startHidden = process.argv.includes('--hidden');
const smokeTest = process.argv.includes('--smoke-test');

// ----------------------------------------------------------- data location
function configFile() { return path.join(app.getPath('userData'), 'config.json'); }
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch (_) { return {}; }
}
function writeConfig(c) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2));
}
function defaultDataDir() {
  if (smokeTest) return path.join(app.getPath('temp'), `loa-smoke-${process.pid}`);
  // Local (not roaming) AppData on Windows, like the R6 design: large PDFs
  // should not sync with roaming profiles.
  const base = process.platform === 'win32' && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA : app.getPath('userData');
  return path.join(base, 'LOA Command Center');
}
function dataDir() { return readConfig().dataDir || defaultDataDir(); }

function logError(e) {
  try {
    const f = path.join(dataDir(), 'error.log');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `[${new Date().toISOString()}] ${e && e.stack ? e.stack : e}\n`);
  } catch (_) { /* nothing else to do */ }
}
process.on('uncaughtException', logError);
process.on('unhandledRejection', logError);

// ------------------------------------------------------------------ window
function iconPath() {
  const p = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1460, height: 920, minWidth: 1100, minHeight: 700,
    title: APP_NAME, icon: iconPath(), show: false, backgroundColor: '#f4f6fa',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL('app://ui/index.html');
  win.once('ready-to-show', () => { if (!startHidden && !smokeTest) win.show(); });
  if (smokeTest) runSmokeTest();
  win.on('close', (e) => {
    if (quitting) return;
    let bg = true;
    try { bg = api.getSettings().runInBackground !== false; } catch (_) { /* default */ }
    if (bg) {
      e.preventDefault();
      win.hide();
      if (process.platform === 'win32' && !readConfig().trayHintShown) {
        writeConfig({ ...readConfig(), trayHintShown: true });
        notify('Still running in the background', 'LOA Command Center keeps watching your expiry dates. Open it from the tray icon.');
      }
    }
  });
  // Never navigate away from the app; open web links in the browser.
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
  });
}

/** CI check: the UI renders and the PDF reader and OCR work in the packaged app. */
function runSmokeTest() {
  const finish = (code, msg) => { console.log(`SMOKE ${code ? 'FAIL' : 'PASS'} ${msg}`); quitting = true; app.exit(code); };
  setTimeout(() => finish(1, 'timeout'), 120000);
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.log(`renderer: ${message}`); });
  win.webContents.on('did-finish-load', async () => {
    try {
      const r = await win.webContents.executeJavaScript(`new Promise((res) => { const t = setInterval(() => { if (window.__loaSelfTest && document.querySelector('.side')) { clearInterval(t); window.__loaSelfTest().then(res, (e) => res({ ok: false, error: String(e) })); } }, 200); })`);
      finish(r.ok ? 0 : 1, JSON.stringify(r));
    } catch (e) { finish(1, e.message); }
  });
}

function openExternal(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

function showWindow(route) {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (route) win.webContents.send('navigate', route);
}

function createTray() {
  const icon = iconPath() ? nativeImage.createFromPath(iconPath()) : nativeImage.createEmpty();
  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open LOA Command Center', click: () => showWindow() },
    { label: 'Show action plan', click: () => showWindow('plan') },
    { label: 'Send digest now', click: () => sendDigest(true) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showWindow());
}

// ---------------------------------------------------------- notifications
function notify(title, body, route) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath(), silent: false });
  n.on('click', () => showWindow(route));
  n.show();
}

function sendDigest(force = false) {
  try {
    const dg = force ? api.digest() : api.checkNotification(new Date());
    if (!dg) return null;
    const body = [dg.headline, ...dg.lines.slice(0, 3)].join('\n');
    notify(dg.title, body, 'plan');
    if (win) win.webContents.send('digest', dg);
    return dg;
  } catch (e) {
    logError(e);
    return null;
  }
}

function startScheduler() {
  setTimeout(() => sendDigest(false), 15000); // catch up on a missed slot after start-up
  setInterval(() => sendDigest(false), 60 * 1000);
}

// --------------------------------------------------------------------- IPC
function serializeError(e) {
  return { __error: true, message: e && e.message ? e.message : String(e) };
}

function registerIpc() {
  ipcMain.handle('api', async (_e, method, args) => {
    if (!PUBLIC_METHODS.includes(method)) return serializeError(new Error(`Unknown method ${method}`));
    try {
      const fixed = (args || []).map((a) => fixBinary(a));
      const out = await api[method](...fixed);
      if (method === 'setSettings') applyOsSettings();
      return out;
    } catch (e) {
      logError(e);
      return serializeError(e);
    }
  });

  ipcMain.handle('native', async (_e, op, a = {}) => {
    try {
      switch (op) {
        case 'openFiles': {
          const r = await dialog.showOpenDialog(win, { properties: [a.folder ? 'openDirectory' : 'openFile', ...(a.multi ? ['multiSelections'] : [])], filters: a.filters });
          if (r.canceled) return [];
          return a.folder ? listFiles(r.filePaths[0], a.extensions || ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff']) : r.filePaths;
        }
        case 'listFolder': return listFiles(a.path, a.extensions || ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff']);
        case 'readFile': {
          const st = fs.statSync(a.path);
          if (st.isDirectory()) return { dir: true, files: listFiles(a.path, a.extensions || ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff']) };
          if (st.size > 200 * 1024 * 1024) throw new Error('File is larger than 200 MB');
          return { name: path.basename(a.path), bytes: new Uint8Array(fs.readFileSync(a.path)) };
        }
        case 'saveFile': {
          const r = await dialog.showSaveDialog(win, { defaultPath: a.name, filters: a.filters });
          if (r.canceled || !r.filePath) return null;
          fs.writeFileSync(r.filePath, a.bytes ? Buffer.from(a.bytes) : a.text, a.bytes ? undefined : 'utf8');
          return r.filePath;
        }
        case 'savePdf': {
          const r = await dialog.showSaveDialog(win, { defaultPath: a.name || 'Summary Report.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
          if (r.canceled || !r.filePath) return null;
          const pdf = await htmlToPdf(a.html);
          fs.writeFileSync(r.filePath, pdf);
          shell.openPath(r.filePath);
          return r.filePath;
        }
        case 'openDocument': {
          const p = api.documentPath(a.id);
          if (!p) throw new Error('The archived file is missing');
          const err = await shell.openPath(p);
          if (err) throw new Error(err);
          return true;
        }
        case 'openPath': { await shell.openPath(a.path); return true; }
        case 'showItem': { shell.showItemInFolder(a.path); return true; }
        case 'openExternal': { openExternal(a.url); return true; }
        case 'testNotification': { sendDigest(true); return true; }
        case 'chooseFolder': {
          const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
          return r.canceled ? null : r.filePaths[0];
        }
        case 'moveData': {
          const target = path.join(a.path, 'LOA Command Center');
          if (path.resolve(target) === path.resolve(dataDir())) return dataDir();
          api.backup('before-move');
          copyDir(dataDir(), target);
          writeConfig({ ...readConfig(), dataDir: target });
          app.relaunch();
          quitting = true;
          app.exit(0);
          return target;
        }
        case 'relaunch': { app.relaunch(); quitting = true; app.exit(0); return true; }
        default: throw new Error(`Unknown native op ${op}`);
      }
    } catch (e) {
      logError(e);
      return serializeError(e);
    }
  });
}

function fixBinary(a) {
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    if (a instanceof Uint8Array) return Buffer.from(a);
    const out = {};
    for (const [k, v] of Object.entries(a)) out[k] = v instanceof Uint8Array ? Buffer.from(v) : v;
    return out;
  }
  return a;
}

function listFiles(dir, exts, depth = 0, out = []) {
  if (depth > 6 || out.length > 2000) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listFiles(p, exts, depth + 1, out);
    else if (exts.includes(path.extname(ent.name).slice(1).toLowerCase())) out.push(p);
  }
  return out;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
  }
}

async function htmlToPdf(html) {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await w.webContents.printToPDF({ printBackground: true, pageSize: 'Letter', margins: { marginType: 'default' } });
  } finally {
    w.destroy();
  }
}

function applyOsSettings() {
  try {
    const s = api.getSettings();
    if (process.platform === 'win32' || process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: !!s.startWithWindows, args: ['--hidden'] });
    }
  } catch (e) { logError(e); }
}

// --------------------------------------------------------------- lifecycle
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(async () => {
    try {
      api = await AppApi.create({ dataDir: dataDir() });
    } catch (e) {
      logError(e);
      dialog.showErrorBox(APP_NAME, `The database could not be opened.\n\n${e.message}\n\nData folder: ${dataDir()}\nA log was written to error.log in that folder.`);
      app.exit(1);
      return;
    }
    registerUiProtocol();
    registerIpc();
    createWindow();
    if (smokeTest) return;
    createTray();
    applyOsSettings();
    startScheduler();
  });
  app.on('before-quit', () => { quitting = true; try { api && api.db.close(); } catch (_) { /* closing */ } });
  app.on('window-all-closed', () => { /* stay in tray */ });
  app.on('activate', () => showWindow());
}
