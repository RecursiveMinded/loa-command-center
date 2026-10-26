'use strict';
// The only bridge between the page and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('loa', {
  call: (method, ...args) => ipcRenderer.invoke('api', method, args),
  native: (op, args) => ipcRenderer.invoke('native', op, args),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return ''; } },
  on: (channel, fn) => {
    if (!['navigate', 'digest', 'update'].includes(channel)) return () => {};
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
