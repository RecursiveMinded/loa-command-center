'use strict';
// Automatic updates for the installed app. New versions are published as
// GitHub releases (see "publish" in package.json); the app checks
// at start-up and every 12 hours, downloads in the background, and installs
// when the user restarts (or on the next quit).

const { app } = require('electron');

const CHECK_EVERY = 12 * 3600 * 1000;

let updater = null;
let status = { state: 'idle', current: app.getVersion(), version: null, message: '' };
let onChange = () => {};

function supported() {
  // The portable exe cannot replace itself; only the installed app updates.
  return app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR;
}

function set(patch) {
  status = { ...status, ...patch };
  onChange(status);
}

function init({ enabled, log, changed }) {
  onChange = changed || onChange;
  if (!supported()) { set({ state: 'unsupported' }); return; }
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = { info() {}, warn() {}, debug() {}, error: (e) => log(e) };
  updater.on('checking-for-update', () => set({ state: 'checking', message: '' }));
  updater.on('update-available', (i) => set({ state: 'downloading', version: i.version }));
  updater.on('update-not-available', () => set({ state: 'current', checkedAt: new Date().toISOString() }));
  updater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  updater.on('update-downloaded', (i) => set({ state: 'ready', version: i.version }));
  updater.on('error', (e) => { log(e); set({ state: 'error', message: friendly(e) }); });
  if (enabled()) setTimeout(() => check(), 30 * 1000);
  setInterval(() => { if (enabled()) check(); }, CHECK_EVERY);
}

function friendly(e) {
  const m = String((e && e.message) || e);
  if (/404|Cannot find latest|No published versions/i.test(m)) return 'No published updates yet.';
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|net::/i.test(m)) return 'Could not reach the update server.';
  return m.split('\n')[0].slice(0, 160);
}

async function check() {
  if (!updater) return status;
  if (['checking', 'downloading', 'ready'].includes(status.state)) return status;
  try { await updater.checkForUpdates(); } catch (_) { /* reported through the error event */ }
  // Resolve once the check has settled into a result.
  for (let i = 0; i < 100 && status.state === 'checking'; i++) await new Promise((r) => setTimeout(r, 100));
  return status;
}

function install() {
  if (!updater || status.state !== 'ready') return false;
  setImmediate(() => updater.quitAndInstall(true, true));
  return true;
}

module.exports = { init, check, install, getStatus: () => status };
