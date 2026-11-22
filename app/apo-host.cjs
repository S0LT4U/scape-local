// PC-side Boost via Equalizer APO: detection (registry/files) and applying/removing our
// managed config. Runs in the Electron main process. Pure text logic lives in lib/apo.mjs.
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MMDEV = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio';
const PKEY_NAME = '{a45c254e-df1c-4efd-8020-67d146a850e0},2'; // endpoint name, e.g. "Headset Earphone"
const PKEY_IFACE = '{b3f8fa53-0004-438e-9003-51a46e139bfc},6'; // interface, e.g. "Fractal Scape Dongle"
const APO_CLSID = 'EACD2258-FCAC-4FF4-B36D-419E924A6D79';

let lib; // lib/apo.mjs, loaded lazily (ESM)
const loadLib = async () => (lib ??= await import('./lib/apo.mjs'));

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

/** Parse `reg query` output into { keyPath: { valueName: data } }. */
function parseReg(out) {
  const res = {};
  let key = null;
  for (const line of out.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) res[(key = line.trim())] = {};
    else if (key) {
      const m = /^\s{4}(.+?)\s{4}(REG_\w+)\s{4}?(.*)$/.exec(line);
      if (m) res[key][m[1]] = m[3];
    }
  }
  return res;
}

async function apoInstallDir() {
  const r = parseReg(await reg(['query', 'HKLM\\SOFTWARE\\EqualizerAPO', '/v', 'InstallPath']));
  const v = Object.values(r)[0]?.InstallPath;
  return v || 'C:\\Program Files\\EqualizerAPO';
}

/** All Scape endpoints of one kind ('Render' = playback, 'Capture' = mic) that Windows knows about. */
async function scapeEndpoints(kind = 'Render') {
  const RENDER_KEY = `${MMDEV}\\${kind}`;
  const r = parseReg(await reg(['query', RENDER_KEY, '/s', '/v', PKEY_IFACE]));
  const eps = [];
  for (const [key, vals] of Object.entries(r)) {
    const iface = vals[PKEY_IFACE];
    if (!iface || !/Fractal Scape/i.test(iface)) continue;
    const m = /\\(?:Render|Capture)\\(\{[0-9a-f-]+\})\\Properties$/i.exec(key);
    if (!m) continue;
    const guid = m[1];
    const props = parseReg(await reg(['query', `${RENDER_KEY}\\${guid}\\Properties`, '/v', PKEY_NAME]));
    const name = Object.values(props)[0]?.[PKEY_NAME] || '';
    const stateOut = parseReg(await reg(['query', `${RENDER_KEY}\\${guid}`, '/v', 'DeviceState']));
    const state = parseInt(Object.values(stateOut)[0]?.DeviceState || '0', 16);
    const fx = await reg(['query', `${RENDER_KEY}\\${guid}\\FxProperties`]);
    const child = await reg(['query', `HKLM\\SOFTWARE\\EqualizerAPO\\Child APOs\\${guid}`]);
    eps.push({ guid, name, iface, active: state === 1, apoAttached: new RegExp(APO_CLSID, 'i').test(fx) || !!child.trim() });
  }
  return eps;
}

function readIf(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function createApoHost(userDataDir) {
  const originalFile = path.join(userDataDir, 'apo-config-original.txt');

  async function status() {
    const L = await loadLib();
    const installDir = await apoInstallDir();
    const configDir = path.join(installDir, 'config');
    const installed = fs.existsSync(path.join(installDir, 'EqualizerAPO.dll')) || fs.existsSync(path.join(installDir, 'Configurator.exe'));
    const configText = readIf(path.join(configDir, 'config.txt'));
    let writable = false;
    try { fs.accessSync(configDir, fs.constants.W_OK); writable = true; } catch {}
    const endpoints = await scapeEndpoints('Render');
    const micEndpoints = await scapeEndpoints('Capture');
    const boostText = readIf(path.join(configDir, L.BOOST_FILE));
    const levels = boostText && configText && L.hasBlock(configText) ? L.parseBoostFile(boostText) : { speakers: 0, mic: 0 };
    const level = levels.speakers || null;
    // conflicts: other config that would also hit the Scape
    const files = {};
    if (configText != null) {
      files['config.txt'] = configText;
      for (const m of configText.matchAll(/^\s*Include\s*:\s*(.+)$/gim))
        for (const f of m[1].split(';').map((s) => s.trim())) {
          const t = readIf(path.join(configDir, f));
          if (t != null) files[f] = t;
        }
    }
    return {
      installed,
      installDir,
      configDir,
      configExists: configText != null,
      writable,
      endpoints,
      attached: endpoints.some((e) => e.apoAttached),
      active: level != null,
      level,
      micEndpoints,
      micAttached: micEndpoints.some((e) => e.apoAttached),
      micLevel: levels.mic || null,
      conflicts: L.findConflicts(files),
    };
  }

  /** Write speaker and mic levels (0 = off). When both are 0, config.txt is restored byte for byte. */
  async function apply(levels) {
    const L = await loadLib();
    const st = await status();
    if (!st.writable) throw new Error(`Cannot write to ${st.configDir}`);
    const cfgPath = path.join(st.configDir, 'config.txt');
    const boostPath = path.join(st.configDir, L.BOOST_FILE);
    const current = readIf(cfgPath) ?? '';
    if (levels.speakers > 0 || levels.mic > 0) {
      if (levels.speakers > 0 && !st.endpoints.length) throw new Error('No Scape playback device found in Windows');
      if (levels.mic > 0 && !st.micEndpoints.length) throw new Error('No Scape microphone found in Windows');
      fs.writeFileSync(boostPath, L.buildBoostFileFor(levels, { render: st.endpoints, capture: st.micEndpoints }));
      if (!L.hasBlock(current)) {
        fs.writeFileSync(originalFile, current); // exact copy for byte-for-byte restore
        fs.writeFileSync(cfgPath, L.addBlock(current));
      }
    } else {
      const original = readIf(originalFile);
      fs.writeFileSync(cfgPath, L.removeBlock(current, original));
      try { fs.unlinkSync(boostPath); } catch {}
      try { fs.unlinkSync(originalFile); } catch {}
    }
    return status();
  }

  /** Speaker Boost: db > 0 = on at that level, 0 = off. Keeps the mic level as it is. */
  async function set(db) {
    const st = await status();
    return apply({ speakers: db, mic: st.micLevel || 0 });
  }
  /** Mic Boost: db > 0 = on at that level, 0 = off. Keeps the speaker level as it is. */
  async function setMic(db) {
    const st = await status();
    return apply({ speakers: st.level || 0, mic: db });
  }

  return { status, set, setMic };
}

module.exports = { createApoHost };
