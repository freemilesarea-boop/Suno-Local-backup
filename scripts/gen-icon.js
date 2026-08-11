'use strict';

// Build-time helper: rasterize build/icon.svg to build/icon.png (1024x1024,
// RGBA with transparent corners) using the already-installed Electron. Not part
// of the app runtime. Run with: xvfb-run electron scripts/gen-icon.js --no-sandbox
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8');
  const html =
    '<!doctype html><html><head><meta charset="utf-8"></head>' +
    '<body style="margin:0;padding:0;background:transparent;width:1024px;height:1024px;overflow:hidden">' +
    svg +
    '</body></html>';
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.capturePage();
  const size = img.getSize();
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.writeFileSync(out, img.toPNG());
  // eslint-disable-next-line no-console
  console.log('icon written', out, size.width + 'x' + size.height);
  app.quit();
});
