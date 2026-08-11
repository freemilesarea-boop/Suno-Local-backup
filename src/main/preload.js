'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload bridge.
 *
 * Exposes ONLY a small, explicit API to the renderer — no `require`, no `fs`,
 * no `ipcRenderer` object, no arbitrary channel access. Each method maps to a
 * single validated main-process handler. Event subscriptions are wrapped so the
 * renderer receives only the payload, never the Electron event object.
 */

contextBridge.exposeInMainWorld('suno', {
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  getLastDir: () => ipcRenderer.invoke('config:getLastDir'),
  parseUrls: (text) => ipcRenderer.invoke('urls:parse', String(text ?? '')),
  startImport: (payload) =>
    ipcRenderer.invoke('import:start', {
      text: String(payload && payload.text != null ? payload.text : ''),
      format: String(payload && payload.format != null ? payload.format : 'original'),
      destDir: String(payload && payload.destDir != null ? payload.destDir : ''),
    }),
  retryFailed: () => ipcRenderer.invoke('import:retryFailed'),
  onJobUpdate: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_evt, snapshot) => callback(snapshot);
    ipcRenderer.on('job:update', listener);
    return () => ipcRenderer.removeListener('job:update', listener);
  },
});
