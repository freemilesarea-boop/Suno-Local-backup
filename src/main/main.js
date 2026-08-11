'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const { parseUrlList } = require('../core/url');
const { createController } = require('../core/factory');
const { Logger } = require('../core/logger');
const { validateStartPayload, VALID_FORMATS } = require('./validate');

/**
 * Electron main process.
 *
 * Security posture:
 *  - contextIsolation ON, nodeIntegration OFF, sandbox ON.
 *  - The renderer gets NO direct Node/fs access. It talks to main only through
 *    a small, explicitly-validated IPC surface (see preload.js).
 *  - No IPC channel executes arbitrary commands or fetches arbitrary URLs;
 *    every channel validates its inputs and constrains behavior.
 */

let mainWindow = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch {
    /* config persistence is best-effort */
  }
}

function makeLogger() {
  return new Logger({
    filePath: path.join(app.getPath('userData'), 'logs', 'import.log'),
    console: false,
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Block navigation to external origins and new-window creation.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function registerIpc() {
  // Native folder picker; remembers the last chosen directory.
  ipcMain.handle('dialog:selectFolder', async () => {
    const cfg = readConfig();
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: cfg.lastDir || app.getPath('music'),
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const dir = result.filePaths[0];
    writeConfig({ ...cfg, lastDir: dir });
    return { canceled: false, path: dir };
  });

  ipcMain.handle('config:getLastDir', async () => {
    return readConfig().lastDir || null;
  });

  // Parse + validate a block of URLs (no network).
  ipcMain.handle('urls:parse', async (_evt, text) => {
    if (typeof text !== 'string') return { valid: [], invalid: [] };
    const { valid, invalid } = parseUrlList(text);
    return {
      valid: valid.map((v) => ({ id: v.id, canonicalUrl: v.canonicalUrl, originalUrl: v.originalUrl, kind: v.kind })),
      invalid,
    };
  });

  // Start an import batch. Streams per-job updates on 'job:update'.
  ipcMain.handle('import:start', async (evt, payload) => {
    const validation = validateStartPayload(payload);
    if (!validation.ok) return { ok: false, error: validation.error };
    const { text, format, destDir } = validation.value;

    const { valid } = parseUrlList(text);
    if (!valid.length) return { ok: false, error: 'No valid Suno URLs provided.' };

    const logger = makeLogger();
    const controller = createController({ baseDir: destDir, logger });
    const send = (snapshot) => {
      if (!evt.sender.isDestroyed()) evt.sender.send('job:update', snapshot);
    };
    controller.addJobs(valid, { format, onChange: send });

    currentController = controller;
    const snapshots = await controller.run();
    return { ok: true, jobs: snapshots };
  });

  ipcMain.handle('import:retryFailed', async (evt) => {
    if (!currentController) return { ok: false, error: 'No active import.' };
    const send = (snapshot) => {
      if (!evt.sender.isDestroyed()) evt.sender.send('job:update', snapshot);
    };
    // Re-attach the change listener to existing jobs.
    for (const job of currentController.jobs) job._onChange = send;
    const snapshots = await currentController.retryFailed();
    return { ok: true, jobs: snapshots };
  });
}

let currentController = null;
