// Scape Local: Electron main process.
// Tray-only app: no taskbar entry while hidden, starts with Windows (hidden), and
// talks to the headset over WebHID from the (hidden) renderer window.
'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, protocol, session, ipcMain, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { createApoHost } = require('./apo-host.cjs');
let apo = null; // created once userData is known

const VID = 0x36bc;
const PIDS = [0x2001, 0x0001]; // headset (USB), 2.4 GHz dongle
const RENDERER = path.join(__dirname, 'renderer');
const START_HIDDEN = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win = null;
let tray = null;
let quitting = false;
let status = { connected: false, battery: null, label: 'Not connected' };

// ---------- settings (userData/settings.json) ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

// ---------- start with Windows ----------
function loginItemOptions(enable) {
  // Packaged: the exe itself. Unpackaged (npm start): electron.exe + this app folder.
  const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
  return { openAtLogin: enable, path: process.execPath, args };
}
function getAutostart() {
  return app.getLoginItemSettings(loginItemOptions(true)).openAtLogin;
}
function setAutostart(enable) {
  app.setLoginItemSettings(loginItemOptions(enable));
  const s = loadSettings();
  s.autostartConfigured = true;
  s.autostart = enable;
  saveSettings(s);
  rebuildTrayMenu();
  return getAutostart();
}

// ---------- window ----------
function showWindow() {
  if (!win) return;
  win.setSkipTaskbar(false);
  win.show();
  win.focus();
}
function hideWindow() {
  if (!win) return;
  win.hide();
  win.setSkipTaskbar(true);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    show: false,
    skipTaskbar: START_HIDDEN,
    title: 'Scape Local',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#111315',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep HID handling alive while hidden in the tray
      spellcheck: false,
    },
  });
  win.setMenu(null);
  win.loadURL('app://local/index.html');
  win.once('ready-to-show', () => {
    if (!START_HIDDEN) showWindow();
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideWindow();
    }
  });
  // No navigation away, no popups; external links open in the default browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------- tray ----------
function rebuildTrayMenu() {
  if (!tray) return;
  const battery = status.battery != null ? ` · ${status.battery}%` : '';
  const boost = status.boost ? ` · BOOST ${status.boost}` : '';
  tray.setToolTip(`Scape Local: ${status.label}${battery}${boost}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Scape Local', click: showWindow },
      { type: 'separator' },
      { label: `${status.label}${battery}`, enabled: false },
      ...(status.boost ? [{ label: `Boost on: ${status.boost}`, enabled: false }] : []),
      { type: 'separator' },
      { label: 'Start with Windows', type: 'checkbox', checked: getAutostart(), click: (mi) => setAutostart(mi.checked) },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]),
  );
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
  tray.on('click', () => (win && win.isVisible() ? hideWindow() : showWindow()));
  rebuildTrayMenu();
}

// ---------- security / HID ----------
function isOurDevice(d) {
  return d.vendorId === VID && PIDS.includes(d.productId);
}

function setupSession() {
  const ses = session.defaultSession;

  // Serve the renderer from app://local/ (secure context, so WebHID is allowed).
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
  protocol.handle('app', async (req) => {
    let file;
    try {
      file = path.normalize(path.join(RENDERER, decodeURIComponent(new URL(req.url).pathname)));
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (!file.startsWith(RENDERER + path.sep)) return new Response('forbidden', { status: 403 });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, { headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  // No network at runtime: block every request that isn't our own app:// content
  // (devtools: scheme is allowed so the inspector still works).
  ses.webRequest.onBeforeRequest((details, cb) => {
    const ok = /^(app|devtools|chrome-extension|data|blob):/.test(details.url);
    cb({ cancel: !ok });
  });

  // Only WebHID is allowed (the Copy button uses Electron's clipboard via IPC instead).
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler((_wc, permission, origin) => permission === 'hid' && String(origin).startsWith('app://'));
  // Pre-grant the Scape headset/dongle so the hidden window can reconnect at boot without a click.
  ses.setDevicePermissionHandler((d) => d.deviceType === 'hid' && d.origin.startsWith('app://') && isOurDevice(d.device));
  // requestDevice() from the "Connect" button: pick the Scape automatically (no Chromium chooser in Electron).
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const match = details.deviceList.find(isOurDevice);
    callback(match ? match.deviceId : '');
  });
}

// ---------- IPC from the renderer ----------
ipcMain.on('status', (_e, s) => {
  status = { ...status, ...s };
  rebuildTrayMenu();
});
ipcMain.handle('autostart:get', () => getAutostart());
ipcMain.handle('autostart:set', (_e, on) => setAutostart(!!on));
ipcMain.on('window:hide', hideWindow);
ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text).slice(0, 10000)); return true; });
ipcMain.handle('apo:status', () => apo.status());
ipcMain.handle('apo:set', (_e, db) => {
  const n = Number(db);
  if (!(n === 0 || (n > 0 && n <= 14))) throw new Error('invalid boost level');
  return apo.set(n);
});
ipcMain.handle('apo:setMic', (_e, db) => {
  const n = Number(db);
  if (!(n === 0 || (Number.isInteger(n) && n > 0 && n <= 12))) throw new Error('invalid mic boost level');
  return apo.setMic(n);
});

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(() => {
  app.setAppUserModelId('local.scape');
  apo = createApoHost(app.getPath('userData'));
  setupSession();
  createWindow();
  createTray();
  // First run: turn on "Start with Windows" (requested behaviour). Can be unticked in the tray menu.
  // (SCAPE_NO_AUTOSTART=1 skips this, for test launches.)
  const s = loadSettings();
  if (!process.env.SCAPE_NO_AUTOSTART) {
    if (!s.autostartConfigured) setAutostart(true);
    // Self-heal: setting says "on" but the Windows entry is gone (e.g. removed by an older updater).
    else if (s.autostart && !getAutostart()) setAutostart(true);
  }
});
