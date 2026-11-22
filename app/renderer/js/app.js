import { decodeEqCode, encodeEqCode, validateBands, describeBands, tidy, FILTER_LABELS, MAX_BANDS, LIMITS } from './eqcode.js';
import { responseDb, logFreqs, coefficients, magnitudeDb } from './biquad.js';
import { ScapeDevice } from './hid.js';
import { cmd, hex, parse, ALLOWED, buildEqWrite, SIDETONE, BlockedCommandError, sidetoneStepPlan, sidetonePercent } from './protocol.js';
import { initLighting } from './lighting-ui.js';
import { applyHeadsetBoost, headsetBoostBlocker, isBoostOf, isBoostBand, stripHeadsetBoost, HEADSET_MAX_DB, dbToPercent } from './boost.js';

const $ = (id) => document.getElementById(id);
const host = window.scapeHost || null; // present when running inside the Electron shell

// ---------------------------------------------------------------------------
// storage (localStorage; Electron keeps it in the app's userData folder)
// ---------------------------------------------------------------------------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

const BUILTIN = [
  { name: 'Flat', code: 'AQAB' },
  { name: 'Everyday', code: 'AQMBAACAvzMzMz9kAAAAAAAAAAAAwAAAAECsDQAAAAAAAAAAwAAAQEBwFwAAAADS' },
  { name: 'Competitive', code: 'AQUBAACAwDMzMz94AAAAAAAAAAAAQAAAwD/QBwAAAAAAAAAAwAAAgD/6AAAAAAAAAAAAQAAAAECgDwAAAAAAAAAAwAAAQEBYGwAAAADw' },
  { name: 'Immersive', code: 'AQMBAAAAQDMzMz88AAAAAAAAAACAPwAAgD/cBQAAAAAAAAAAwAAAAECgDwAAAACF' },
].map((p) => ({ ...p, builtin: true }));

const state = {
  device: null,
  info: null,
  hs: null, // parsed device state
  slots: [],
  readDone: false, // writes stay disabled until a full read succeeded
  bands: [],
  presets: [...BUILTIN, ...store.get('scape.presets', [])],
  currentPreset: 'Everyday',
  backups: store.get('scape.backups', []),
  enforce: store.get('scape.enforceDefaults', false),
  busy: false,
  light: null, // lighting effect metadata read from the headset
};
let lighting = null; // lighting card controller (set at boot)

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
let toastTimer;
function toast(text, isErr = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), isErr ? 6000 : 3000);
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

/** Confirmation dialog showing the exact bytes. Resolves true if the user clicks Send. */
function confirmPackets(packets, label) {
  const dlg = $('dlgConfirm');
  $('dlgTitle').textContent = label;
  $('dlgBytes').textContent = packets
    .map((p, i) => `${String(i + 1).padStart(2)}. ${(ALLOWED.get((p[0] << 8) | p[1])?.name || '?').padEnd(18)} ${hex(p)}`)
    .join('\n');
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.returnValue = 'cancel';
    dlg.showModal();
    $('dlgOk').focus();
  });
}

function setBusy(b) {
  state.busy = b;
  $('connDot').className = `dot ${b ? 'busy' : state.device ? 'on' : ''}`;
  updateWriteButtons();
  renderBoost();
  renderQuickEq();
  lighting?.render();
}

function updateWriteButtons() {
  const can = !!state.device && state.readDone && !state.busy && !!state.hs;
  const valid = validateBands(state.bands).length === 0;
  document.querySelectorAll('[data-act], #btnApplyDefaults, .slot button[data-write]').forEach((b) => {
    b.disabled = !can || (b.dataset.write === 'eq' && !valid);
  });
  $('btnRefresh').disabled = !state.device || state.busy;
}

function pushStatus() {
  if (!host) return;
  host.setStatus({
    connected: !!state.device,
    battery: state.hs ? state.hs.battery : null,
    label: !state.device ? 'Not connected' : state.hs ? `${state.device.name}` : 'Headset not linked',
    boost: boostLabel(),
  });
}

// ---------------------------------------------------------------------------
// EQ editor
// ---------------------------------------------------------------------------
function setBands(bands, source) {
  state.bands = bands.map((b) => ({ type: b.type, freq: Math.round(b.freq), gain: tidy(b.gain, 2), q: tidy(b.q, 3) }));
  renderBands();
  renderGraph();
  if (source !== undefined) state.currentPreset = source; // '' = not a named preset (e.g. pasted code)
  syncCode();
}

/** Name of the preset whose bands are exactly these (compared via the share-code bytes), or ''. */
function presetNameFor(bands) {
  const code = encodeEqCode(bands);
  const p = state.presets.find((x) => {
    try { return encodeEqCode(presetBands(x)) === code; } catch { return false; }
  });
  return p ? p.name : '';
}

function syncCode() {
  const errs = validateBands(state.bands);
  $('bandErrors').textContent = errs.join(' · ');
  $('txtCode').value = encodeEqCode(state.bands);
  // The editor's preset name always follows its bands (edited away from a preset -> unnamed).
  state.currentPreset = presetNameFor(state.bands);
  if ($('selPreset').options.length) $('selPreset').value = state.currentPreset;
  renderSlots(); // write buttons depend on validity
}

function renderBands() {
  const tb = $('bandRows');
  tb.replaceChildren();
  state.bands.forEach((b, i) => {
    const num = (key, step, [min, max]) =>
      el('input', {
        type: 'number', step, min, max, value: b[key], 'aria-label': `Band ${i + 1} ${key}`,
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) {
            b[key] = v;
            renderGraph();
            syncCode();
          }
        },
      });
    const sel = el('select', {
      'aria-label': `Band ${i + 1} type`,
      onchange: (e) => {
        b.type = Number(e.target.value);
        renderGraph();
        syncCode();
      },
    }, FILTER_LABELS.map((l, t) => el('option', { value: t, selected: t === b.type }, l)));
    tb.append(
      el('tr', {},
        el('td', {}, i + 1),
        el('td', {}, sel),
        el('td', {}, num('freq', 1, LIMITS.freq)),
        el('td', {}, num('gain', 0.5, LIMITS.gain)),
        el('td', {}, num('q', 0.1, LIMITS.q)),
        el('td', {}, el('button', { class: 'btn small ghost', title: 'Remove band', onclick: () => { state.bands.splice(i, 1); renderBands(); renderGraph(); syncCode(); } }, '✕')),
      ),
    );
  });
  $('btnAddBand').disabled = state.bands.length >= MAX_BANDS;
}

const FREQS = logFreqs(360);
function renderGraph() {
  const cv = $('graph');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight || 260;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const pad = { l: 38, r: 10, t: 10, b: 22 };
  const DB = 15;
  const x = (f) => pad.l + ((Math.log10(f) - Math.log10(20)) / 3) * (w - pad.l - pad.r);
  const y = (db) => pad.t + ((DB - db) / (2 * DB)) * (h - pad.t - pad.b);
  g.clearRect(0, 0, w, h);
  g.font = '11px Segoe UI, sans-serif';
  g.fillStyle = col('--muted');
  g.strokeStyle = col('--line');
  g.lineWidth = 1;
  for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    g.beginPath(); g.moveTo(x(f), pad.t); g.lineTo(x(f), h - pad.b); g.stroke();
    g.fillText(f >= 1000 ? `${f / 1000}k` : f, x(f) - 8, h - 6);
  }
  for (let db = -DB; db <= DB; db += 5) {
    g.beginPath(); g.moveTo(pad.l, y(db)); g.lineTo(w - pad.r, y(db)); g.stroke();
    g.fillText(`${db > 0 ? '+' : ''}${db}`, 6, y(db) + 4);
  }
  // per band
  g.strokeStyle = col('--band');
  g.setLineDash([4, 3]);
  for (const b of state.bands) {
    const c = coefficients(b.type, b.freq, b.gain, b.q, 48000);
    g.beginPath();
    FREQS.forEach((f, i) => { const v = Math.max(-DB, Math.min(DB, magnitudeDb(c, f, 48000))); i ? g.lineTo(x(f), y(v)) : g.moveTo(x(f), y(v)); });
    g.stroke();
  }
  g.setLineDash([]);
  // total
  const tot = responseDb(state.bands, FREQS);
  g.strokeStyle = col('--curve');
  g.lineWidth = 2.5;
  g.beginPath();
  tot.forEach((v, i) => { const c = Math.max(-DB, Math.min(DB, v)); i ? g.lineTo(x(FREQS[i]), y(c)) : g.moveTo(x(FREQS[i]), y(c)); });
  g.stroke();

  const peak = Math.max(...tot);
  const warn = $('clipWarn');
  if (peak > 0.5) {
    warn.textContent = `Peak boost +${peak.toFixed(1)} dB. Positive EQ gain can make loud music clip (sound distorted) if the headset DSP has no headroom. Listen for crackle at high volume.`;
    warn.classList.remove('hidden');
  } else warn.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------
function renderPresets() {
  const sel = $('selPreset');
  sel.replaceChildren(
    el('option', { value: '' }, '— Presets —'),
    ...state.presets.map((p) => el('option', { value: p.name, selected: p.name === state.currentPreset }, p.builtin ? p.name : `★ ${p.name}`)),
  );
}
function saveUserPresets() {
  store.set('scape.presets', state.presets.filter((p) => !p.builtin));
}
function presetBands(p) {
  return p.code ? decodeEqCode(p.code) : p.bands;
}

$('selPreset').addEventListener('change', (e) => {
  const p = state.presets.find((x) => x.name === e.target.value);
  if (p) setBands(presetBands(p), p.name);
});
/** Ask for a name in an in-app dialog (Electron doesn't implement window.prompt). Resolves '' if cancelled. */
function askName(initial) {
  const dlg = $('dlgName');
  const inp = $('txtPresetName');
  inp.value = initial;
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? inp.value.trim() : ''), { once: true });
    dlg.returnValue = 'cancel';
    dlg.showModal();
    inp.select();
  });
}

$('btnSavePreset').addEventListener('click', async () => {
  const errs = validateBands(state.bands);
  if (errs.length) return toast(errs[0], true);
  const code = encodeEqCode(state.bands);
  const builtinMatch = BUILTIN.find((b) => encodeEqCode(presetBands(b)) === code);
  if (builtinMatch) return toast(`These bands are already the built-in preset “${builtinMatch.name}”`, true);
  const name = await askName(state.currentPreset);
  if (!name) return;
  if (BUILTIN.some((b) => b.name === name)) return toast('That name is a built-in preset', true);
  // one name per EQ: replace any user preset with the same name or identical bands
  state.presets = state.presets.filter((p) => p.builtin || (p.name !== name && encodeEqCode(presetBands(p)) !== code));
  state.presets.push({ name, code });
  saveUserPresets();
  renderPresets();
  syncCode();
  renderSlots();
  toast(`Saved preset “${name}”`);
});
$('btnDeletePreset').addEventListener('click', () => {
  const p = state.presets.find((x) => x.name === $('selPreset').value);
  if (!p || p.builtin) return toast('Pick one of your own presets (★) to delete', true);
  if (!confirm(`Delete preset “${p.name}”?`)) return;
  state.presets = state.presets.filter((x) => x !== p);
  saveUserPresets();
  renderPresets();
  syncCode(); // names in the editor and slot buttons follow the preset list
});
$('btnExport').addEventListener('click', () => {
  const data = {
    app: 'scape-local',
    version: 1,
    exported: new Date().toISOString(),
    presets: state.presets.map((p) => {
      const bands = presetBands(p);
      return { name: p.name, code: encodeEqCode(bands), bands: bands.map((b) => ({ type: b.type, freq: b.freq, gain: tidy(b.gain, 3), q: tidy(b.q, 3) })) };
    }),
  };
  const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'scape-presets.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('fileImport').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const list = Array.isArray(j) ? j : j.presets || [j];
    let n = 0;
    for (const p of list) {
      const bands = p.code ? decodeEqCode(p.code) : p.bands;
      if (!p.name || !Array.isArray(bands)) continue;
      const errs = validateBands(bands);
      if (errs.length) throw new Error(`${p.name}: ${errs[0]}`);
      if (BUILTIN.some((b) => b.name === p.name)) continue;
      state.presets = state.presets.filter((x) => x.name !== p.name);
      state.presets.push({ name: p.name, code: encodeEqCode(bands) });
      n++;
    }
    saveUserPresets();
    renderPresets();
    syncCode();
    toast(`Imported ${n} preset${n === 1 ? '' : 's'}`);
  } catch (err) {
    toast(`Import failed: ${err.message}`, true);
  }
});

// code box
$('btnDecode').addEventListener('click', () => {
  const msg = $('codeMsg');
  try {
    const bands = decodeEqCode($('txtCode').value);
    setBands(bands, '');
    msg.textContent = `Decoded ${bands.length} band${bands.length === 1 ? '' : 's'}: ${describeBands(bands)}`;
    msg.className = 'msg ok';
    renderPresets();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg err';
  }
});
$('txtCode').addEventListener('keydown', (e) => e.key === 'Enter' && $('btnDecode').click());
$('btnCopy').addEventListener('click', async () => {
  try {
    if (host?.copyText) await host.copyText($('txtCode').value);
    else await navigator.clipboard.writeText($('txtCode').value);
    toast('EQ code copied');
  } catch {
    $('txtCode').select();
  }
});
$('btnAddBand').addEventListener('click', () => {
  if (state.bands.length >= MAX_BANDS) return;
  state.bands.push({ type: 0, freq: 1000, gain: 0, q: 1 });
  renderBands();
  renderGraph();
  syncCode();
});
$('btnFlat').addEventListener('click', () => setBands([], 'Flat'));

// ---------------------------------------------------------------------------
// device: connect + read
// ---------------------------------------------------------------------------
let connecting = false;
/** Find a permitted Scape and connect, once (HID 'connect' fires per interface, so calls can overlap). */
async function autoConnect() {
  if (state.device || connecting) return;
  connecting = true;
  try {
    const d = await ScapeDevice.findPermitted();
    if (d) await connect(d);
  } catch {} finally {
    connecting = false;
  }
}

async function connect(device) {
  if (!device) return;
  if (state.device) await disconnect();
  state.device = device;
  state.readDone = false;
  device.writeHook = (packets, label) => confirmPackets(packets, label);
  device.addEventListener('log', (e) => appendLog(e.detail));
  $('connLabel').textContent = device.name;
  $('btnConnect').textContent = 'Disconnect';
  try {
    setBusy(true);
    await device.open();
    await readEverything();
    if (state.enforce && state.hs) await applyDefaults({ auto: true });
  } catch (err) {
    toast(`Read failed: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function disconnect() {
  const d = state.device;
  state.device = null;
  state.info = state.hs = null;
  state.light = null;
  state.slots = [];
  state.readDone = false;
  if (d) await d.close();
  $('connLabel').textContent = 'Not connected';
  $('btnConnect').textContent = 'Connect';
  $('battery').classList.add('hidden');
  renderDevice();
  renderDefaults();
  renderSlots();
  setBusy(false);
  pushStatus();
}

async function readEverything() {
  const d = state.device;
  const { info, state: hs, slots } = await d.readAll();
  state.info = info;
  state.hs = hs;
  state.slots = slots;
  state.light = null;
  if (hs) {
    try {
      state.light = await d.readLighting();
    } catch {} // older firmware may not answer; lighting still works
  }
  state.readDone = true;
  renderDevice();
  renderDefaults();
  renderSlots();
  pushStatus();
}

async function refreshState() {
  if (!state.device || state.busy) return;
  try {
    state.hs = await state.device.readState();
  } catch {
    // Over the dongle this usually means the headset was switched off: stop showing stale values.
    // The next poll sees headsetLinked === false and re-reads everything once it's back.
    if (state.device?.isDongle && state.info) {
      state.info.headsetLinked = false;
      state.hs = null;
      state.slots = [];
    } else return;
  }
  renderDevice();
  renderDefaults();
  renderSlots();
  pushStatus();
}

function renderDevice() {
  const dl = $('deviceInfo');
  const { info, hs } = state;
  if (!info) {
    dl.classList.add('hidden');
    $('deviceHint').classList.remove('hidden');
    return;
  }
  $('deviceHint').classList.add('hidden');
  dl.classList.remove('hidden');
  const rows = [['Connection', info.connection]];
  if (info.dongleFw) rows.push(['Dongle firmware', info.dongleFw]);
  if (info.headsetLinked === false) rows.push(['Headset', 'Not linked to dongle (turn the headset on)']);
  if (info.firmware) rows.push(['Headset firmware', info.firmware], ['Serial', info.serial || '—'], ['Edition', info.edition]);
  if (hs) {
    rows.push(
      ['Battery', `${hs.battery}%`],
      ['Active EQ slot', hs.eqSlot],
      ['Boom mic', hs.boomMic ? 'Connected' : 'Not connected'],
      ['Mic muted', hs.muted ? 'Yes' : 'No'],
      ['Docked (hall sensor)', hs.hallSensor],
    );
    const b = $('battery');
    b.textContent = `🔋 ${hs.battery}%`;
    b.classList.remove('hidden');
  }
  dl.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
}

function renderDefaults() {
  const hs = state.hs;
  $('valLights').textContent = hs ? (hs.lightsOn ? `On (effect slot ${hs.lightSlot})` : 'Off') : '—';
  $('valSidetone').textContent = hs ? (hs.sidetonePct != null ? `${hs.sidetonePct}%` : `raw ${hs.sidetoneRaw}`) + (hs.sidetoneOn ? '' : ' (disabled)') : '—';
  $('valEnc').textContent = hs ? (hs.encOn ? 'On' : 'Off') : '—';
  // Filled button = the headset's current state (read back after every change).
  const mark = (sel, isActive) =>
    document.querySelectorAll(sel).forEach((b) => {
      const a = !!hs && isActive(b);
      b.classList.toggle('is-active', a);
      b.setAttribute('aria-pressed', String(a));
    });
  mark('[data-act=lights]', (b) => (b.dataset.on === '1') === hs.lightsOn);
  mark('[data-act=enc]', (b) => (b.dataset.on === '1') === hs.encOn);
  mark('[data-act=sidetone0]', () => hs.sidetoneRaw === 0);
  $('chkEnforce').checked = state.enforce;
  updateWriteButtons();
  lighting?.render();
}

function renderSlots() {
  const box = $('slots');
  renderQuickEq();
  if (!state.slots.length) {
    box.replaceChildren(el('p', { class: 'muted' }, state.device ? 'Reading…' : 'Connect to read the three slots.'));
    return;
  }
  box.replaceChildren(
    ...state.slots.map((s) => {
      const active = state.hs && state.hs.eqSlot === s.slot;
      return el('div', { class: `slot${active ? ' active' : ''}` },
        el('div', { class: 'title' }, `Slot ${s.slot}${active ? ' · active' : ''}`, el('span', { class: 'muted small', title: `Stored id: ${s.name || '(none)'}` }, slotDisplayName(s))),
        el('div', { class: 'desc' }, describeBands(s.bands)),
        el('code', {}, encodeEqCode(s.bands)),
        el('div', { class: 'actions' },
          el('button', { class: 'btn small ghost', onclick: () => { setBands(s.bands, ''); toast(`Loaded slot ${s.slot} into the editor`); } }, 'Load into editor'),
          el('button', { class: 'btn small ghost', 'data-write': 'eq', title: 'Play the editor EQ on this slot without saving', onclick: () => writeSlot(s.slot, 1) }, 'Preview'),
          el('button', { class: 'btn small', 'data-write': 'eq', onclick: () => writeSlot(s.slot, 2) }, 'Write editor EQ'),
          active ? null : el('button', { class: 'btn small ghost', 'data-write': 'select', onclick: () => selectSlot(s.slot) }, 'Make active'),
        ),
      );
    }),
  );
  updateWriteButtons();
  renderBoost();
}

// ---------------------------------------------------------------------------
// device: writes
// ---------------------------------------------------------------------------
async function guarded(fn) {
  if (!state.device || !state.readDone || state.busy) return;
  setBusy(true);
  try {
    await fn(state.device);
  } catch (err) {
    toast(err instanceof BlockedCommandError ? err.message : `Error: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function writeSlot(slot, mode) {
  const errs = validateBands(state.bands);
  if (errs.length) return toast(errs[0], true);
  await guarded(async (d) => {
    // 1. fresh backup of what's on the device right now
    const before = await d.readSlot(slot);
    const name = (state.currentPreset || 'Local').slice(0, 36);
    const packets = buildEqWrite(slot, state.bands, { mode, name });
    let label = mode === 2
      ? `Write slot ${slot} (save): ${describeBands(state.bands)}`
      : `Preview on slot ${slot} (not saved): ${describeBands(state.bands)}`;
    const boostedHere = mode === 2 && boost.headset?.slot === slot;
    if (boostedHere) label += ' (this replaces the slot’s headset Boost; Boost will be off)';
    if (mode === 2) addBackup(before);
    const res = await d.write(packets, label, { confirm: mode === 2 }); // overwriting a saved slot still asks
    if (res.cancelled) return toast('Cancelled; nothing sent');
    if (boostedHere) {
      // The boosted EQ was just overwritten; turning Boost "off" later must not restore the old EQ over this one.
      boost.headset = null;
      store.set('scape.boostHeadset', null);
    }
    // 2. read back and verify
    const after = await d.readSlot(slot);
    state.slots = state.slots.map((s) => (s.slot === slot ? after : s));
    renderSlots();
    const same = encodeEqCode(after.bands) === encodeEqCode(state.bands);
    toast(same ? `Slot ${slot} ${mode === 2 ? 'written' : 'previewing'} and verified ✓` : `Slot ${slot} sent, but the read-back differs: check the log`, !same);
  });
}

async function selectSlot(slot) {
  await guarded(async (d) => {
    const res = await d.write([cmd.selectEqSlot(slot)], `Make slot ${slot} the active EQ`);
    if (res.cancelled) return;
    if (state.hs) state.hs.eqSlot = slot; // instant feedback; confirmed by the read below
    renderQuickEq();
    await new Promise((r) => setTimeout(r, 300));
    state.hs = await d.readState();
    renderDevice();
    renderSlots();
  });
}

function addBackup(slotData) {
  state.backups.unshift({
    time: new Date().toISOString(),
    slot: slotData.slot,
    name: slotData.name,
    code: encodeEqCode(slotData.bands),
    serial: state.info?.serial || '',
  });
  state.backups = state.backups.slice(0, 100);
  store.set('scape.backups', state.backups);
  renderBackups();
}

function renderBackups() {
  $('backupCount').textContent = state.backups.length ? `(${state.backups.length})` : '';
  $('backupList').replaceChildren(
    ...(state.backups.length
      ? state.backups.map((b) =>
          el('div', { class: 'backup' },
            el('span', {}, `${b.time.replace('T', ' ').slice(0, 19)} · slot ${b.slot} · ${b.name || '(no name)'}`),
            el('code', {}, b.code),
            el('button', { class: 'btn small ghost', onclick: () => { setBands(decodeEqCode(b.code), b.name); toast('Backup loaded into the editor. Use “Write editor EQ” to restore it.'); } }, 'Load into editor'),
          ))
      : [el('p', { class: 'muted small' }, 'A backup of the slot is saved automatically before every write.')]),
  );
}

async function sidetoneToZero(d, packetsSent) {
  for (let i = 0; i < 3; i++) {
    const r = parse.sidetone(await d.send(cmd.sidetone(SIDETONE.VOL_DOWN, 50)));
    packetsSent.push('F1 34 03 32');
    if (r.raw === 0) return true;
  }
  return false;
}

/** Lighting off, sidetone 0, ENC off. Only sends what differs from the current state. */
async function applyDefaults({ auto = false } = {}) {
  const run = async (d) => {
    const hs = await d.readState();
    const plan = [];
    if (hs.lightsOn) plan.push(cmd.lights(false));
    if (hs.encOn) plan.push(cmd.enc(false));
    const needSidetone = hs.sidetoneRaw !== 0;
    if (needSidetone) plan.push(cmd.sidetone(SIDETONE.VOL_DOWN, 50));
    if (!plan.length) {
      if (!auto) toast('Already at your defaults. Nothing to send.');
      return;
    }
    const sent = [];
    for (const p of plan) {
      if (p[0] === 0xf1 && p[1] === 0x34) await sidetoneToZero(d, sent);
      else {
        await d.send(p);
        sent.push(hex(p));
      }
    }
    await new Promise((r) => setTimeout(r, 300));
    state.hs = await d.readState();
    renderDevice();
    renderDefaults();
    pushStatus();
    const okAll = !state.hs.lightsOn && !state.hs.encOn && state.hs.sidetoneRaw === 0;
    toast(okAll ? `Defaults applied ✓ (${sent.length} packet${sent.length === 1 ? '' : 's'})` : 'Defaults sent but not all verified: see the log', !okAll);
  };
  if (auto) {
    // already inside connect()'s busy section
    try { await run(state.device); } catch (err) { toast(`Auto-apply failed: ${err.message}`, true); }
  } else await guarded(run);
}

document.querySelectorAll('[data-act]').forEach((b) =>
  b.addEventListener('click', () => {
    const act = b.dataset.act;
    const on = b.dataset.on === '1';
    if (b.classList.contains('is-active')) return; // already in that state: nothing to send
    guarded(async (d) => {
      let res;
      if (act === 'lights') res = await d.write([cmd.lights(on)], `Turn headset lighting ${on ? 'on' : 'off'}`);
      else if (act === 'enc') res = await d.write([cmd.enc(on)], `Turn mic noise cancellation ${on ? 'on' : 'off'}`);
      else if (act === 'sidetoneUp' || act === 'sidetoneDown') {
        const raw = (await d.readState()).sidetoneRaw;
        const plan = sidetoneStepPlan(raw, act === 'sidetoneUp' ? 1 : -1);
        if (plan.target === raw) return;
        if (plan.target === 0) await sidetoneToZero(d, []);
        else await d.write(plan.packets, `Sidetone → ${sidetonePercent(plan.target)}%`);
        res = { cancelled: false };
      } else if (act === 'sidetone0') {
        await sidetoneToZero(d, []);
        res = { cancelled: false };
      }
      if (!res || res.cancelled) return;
      await new Promise((r) => setTimeout(r, 300));
      state.hs = await d.readState();
      renderDevice();
      renderDefaults();
    });
  }),
);

$('btnApplyDefaults').addEventListener('click', () => applyDefaults());
$('chkEnforce').addEventListener('change', async (e) => {
  state.enforce = e.target.checked;
  store.set('scape.enforceDefaults', state.enforce);
  if (state.enforce) guarded(() => applyDefaults({ auto: true })); // no-op if not connected/busy
});

// ---------------------------------------------------------------------------
// Simple EQ picker (home view) + view switching
// ---------------------------------------------------------------------------
/** Friendly slot name: match the slot's bands (minus any boost band) to a preset, else the stored name. */
function slotDisplayName(s) {
  const preset = presetNameFor(stripHeadsetBoost(s.bands));
  if (preset) return preset;
  if (s.factory) return 'Factory default';
  // Adjust Pro stores random ids (21-char nanoid / UUID); only show names that look human
  if (s.name && !/^[A-Za-z0-9_-]{21}$|^[0-9a-f-]{36}$/i.test(s.name)) return s.name;
  return `Custom ${s.slot}`;
}

function renderQuickEq() {
  const box = $('quickEq');
  if (!state.slots.length) {
    box.replaceChildren(...[1, 2, 3].map((n) => el('button', { class: 'qbtn', disabled: true }, el('span', { class: 'n' }, '—'), el('span', { class: 's' }, `Slot ${n}`))));
    if (!state.device) box.append(el('p', { class: 'muted small span-all' }, 'Connect the headset to switch EQ.'));
    return;
  }
  const busy = state.busy || !state.readDone;
  box.replaceChildren(
    ...state.slots.map((s) => {
      const active = state.hs?.eqSlot === s.slot;
      const boosted = s.bands.length && isBoostBand(s.bands.at(-1));
      return el('button', {
        class: `qbtn${active ? ' active' : ''}`,
        disabled: busy,
        'aria-pressed': active ? 'true' : 'false',
        onclick: () => !active && selectSlot(s.slot),
      },
        el('span', { class: 'n' }, slotDisplayName(s)),
        el('span', { class: 's' }, `Slot ${s.slot}${boosted ? ' · boosted' : ''}${active ? ' · active' : ''}`),
      );
    }),
  );
}

function setView(v) {
  document.body.dataset.view = v;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  store.set('scape.view', v);
  if (v === 'editor') renderGraph(); // canvas needs a size once visible
}
document.querySelectorAll('[data-view].tab, [data-goto]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view || b.dataset.goto)));
setView(['home', 'lighting', 'editor'].includes(store.get('scape.view')) ? store.get('scape.view') : 'home');

// ---------------------------------------------------------------------------
// Boost (PC via Equalizer APO, or headset EQ band)
// ---------------------------------------------------------------------------
const boost = {
  where: store.get('scape.boostWhere', 'pc'),
  level: store.get('scape.boostLevel', 6),
  headset: store.get('scape.boostHeadset', null), // {slot, level, originalCode, originalName} while on
  apo: null, // last APO status from the main process
};

function boostActiveLevel() {
  if (boost.headset) return boost.headset.level;
  if (boost.apo?.active) return boost.apo.level;
  return null;
}
function boostLabel() {
  const lv = boostActiveLevel();
  if (lv == null) return null;
  return `+${lv} dB (${boost.headset ? 'headset' : 'PC'})`;
}

async function refreshApo() {
  if (!host?.apoStatus) return;
  try { boost.apo = await host.apoStatus(); } catch (err) { boost.apo = { error: err.message }; }
  renderBoost();
}

function renderBoost() {
  const lv = boostActiveLevel();
  const on = lv != null;
  // badge
  const badge = $('boostBadge');
  badge.textContent = on ? `BOOST +${lv} dB` : '';
  badge.classList.toggle('hidden', !on);
  $('chkBoost').checked = on;
  $('boostState').textContent = on ? `On · +${lv} dB (${boost.headset ? 'headset EQ' : 'PC'})` : 'Off';
  // where (locked while on)
  document.querySelectorAll('input[name=boostWhere]').forEach((r) => {
    r.checked = r.value === (boost.headset ? 'headset' : on ? 'pc' : boost.where);
    r.disabled = on;
  });
  const where = on ? (boost.headset ? 'headset' : 'pc') : boost.where;
  // levels
  const rng = $('rngBoost');
  rng.max = where === 'headset' ? HEADSET_MAX_DB : 14;
  if (!sliderDragging) rng.value = Math.min(lv ?? boost.level, Number(rng.max));
  showSliderValue(Number(rng.value));
  // hints / setup
  const setup = $('boostSetup');
  const conflict = $('boostConflict');
  setup.classList.add('hidden');
  conflict.classList.add('hidden');
  let canEnable = true;
  if (where === 'pc') {
    $('boostWhereHint').textContent = 'Windows only: adds a preamp for the Scape’s playback device in Equalizer APO. Works with every preset. Doesn’t apply to a console or another PC.';
    const a = boost.apo;
    if (!host) {
      canEnable = false;
      setup.replaceChildren(el('span', {}, 'PC Boost needs the desktop app (not available in the browser).'));
      setup.classList.remove('hidden');
    } else if (!a) canEnable = false;
    else if (!a.installed || !a.attached) {
      canEnable = on; // allow turning off
      setup.replaceChildren(
        el('strong', {}, !a.installed ? 'Equalizer APO is not installed' : 'Equalizer APO is not attached to the Scape yet'),
        el('ol', {},
          !a.installed ? el('li', {}, 'Download Equalizer APO from its official SourceForge page and install it.') : null,
          el('li', {}, 'In the Configurator (Start menu → Equalizer APO → Configurator), tick only ', el('code', {}, a.endpoints?.[0] ? `${a.endpoints[0].name} (${a.endpoints[0].iface})` : 'the Scape’s playback device'), '.'),
          el('li', {}, 'Restart Windows when asked, then reopen this panel.'),
        ),
        el('div', { class: 'actions' }, el('button', { class: 'btn small ghost', onclick: refreshApo }, 'Check again')),
      );
      setup.classList.remove('hidden');
    } else if (!a.writable) {
      canEnable = false;
      setup.replaceChildren(el('span', {}, `Can’t write to ${a.configDir}.`));
      setup.classList.remove('hidden');
    }
    if (a?.conflicts?.length) {
      conflict.replaceChildren(
        el('strong', {}, 'Other Equalizer APO settings apply to ALL devices, including the Scape: '),
        a.conflicts.join('; '),
        '. That is probably an old Peace preset. Before attaching APO to the Scape, set Peace to your other device only (or turn it off), or the headset will get those boosts too.',
      );
      conflict.classList.remove('hidden');
    }
  } else {
    $('boostWhereHint').textContent = `Headset EQ: adds a +X dB high-shelf band at 20 Hz to the active slot. Works everywhere (any PC or console, app closed) but max +${HEADSET_MAX_DB} dB and only for presets with 4 or fewer bands.`;
    if (!state.device || !state.readDone) canEnable = on;
    else if (!on) {
      const slot = state.slots.find((s) => s.slot === state.hs?.eqSlot);
      const why = slot && headsetBoostBlocker(slot.bands);
      if (why) {
        canEnable = false;
        setup.replaceChildren(el('span', {}, `Active slot ${slot.slot}: ${why}`));
        setup.classList.remove('hidden');
      }
    }
  }
  $('chkBoost').disabled = !canEnable || state.busy;
  pushStatus();
}

async function hearingNoteOk() {
  if (store.get('scape.boostNoteShown', false)) return true;
  const ok = confirm('Hearing safety: Boost can make audio much louder. Lower the volume before turning it on, then raise it gradually.');
  if (ok) store.set('scape.boostNoteShown', true);
  return ok;
}

async function headsetBoostOn(level) {
  await guarded(async (d) => {
    const slotNo = (await d.readState()).eqSlot;
    const cur = await d.readSlot(slotNo);
    const boosted = applyHeadsetBoost(cur.bands, level); // throws if no room
    const record = { slot: slotNo, level, originalCode: encodeEqCode(cur.bands), originalName: cur.factory ? 'Default' : cur.name };
    addBackup(cur);
    const res = await d.write(buildEqWrite(slotNo, boosted, { name: record.originalName }), `Boost ON: add +${level} dB high shelf @20 Hz to slot ${slotNo}`);
    if (res.cancelled) return toast('Cancelled; nothing sent');
    boost.headset = record;
    store.set('scape.boostHeadset', record);
    const after = await d.readSlot(slotNo);
    state.slots = state.slots.map((s) => (s.slot === slotNo ? after : s));
    renderSlots();
    const ok = isBoostOf(after.bands, cur.bands);
    toast(ok ? `Boost +${level} dB on (slot ${slotNo}) ✓` : 'Boost sent but read-back differs: check the log', !ok);
  });
}

async function headsetBoostOff() {
  const rec = boost.headset;
  await guarded(async (d) => {
    const original = decodeEqCode(rec.originalCode);
    const res = await d.write(buildEqWrite(rec.slot, original, { name: rec.originalName }), `Boost OFF: restore slot ${rec.slot} to its exact previous EQ`);
    if (res.cancelled) return toast('Cancelled; Boost is still on');
    const after = await d.readSlot(rec.slot);
    state.slots = state.slots.map((s) => (s.slot === rec.slot ? after : s));
    renderSlots();
    const exact = encodeEqCode(after.bands) === rec.originalCode;
    if (exact) {
      boost.headset = null;
      store.set('scape.boostHeadset', null);
    }
    toast(exact ? `Boost off: slot ${rec.slot} restored exactly ✓` : 'Restore sent but read-back differs. Boost kept as on; check the log', !exact);
  });
}

/** Headset boost already on: rewrite the slot as original + boost band at the new level (one write). */
async function headsetBoostLevel(level) {
  const rec = boost.headset;
  if (rec.level === level) return;
  await guarded(async (d) => {
    const original = decodeEqCode(rec.originalCode);
    const res = await d.write(buildEqWrite(rec.slot, applyHeadsetBoost(original, level), { name: rec.originalName }), `Boost level → +${level} dB on slot ${rec.slot}`);
    if (res.cancelled) return toast(`Cancelled; Boost stays at +${rec.level} dB`);
    const after = await d.readSlot(rec.slot);
    state.slots = state.slots.map((s) => (s.slot === rec.slot ? after : s));
    renderSlots();
    if (!isBoostOf(after.bands, original)) return toast('Level sent but read-back differs: check the log', true);
    boost.headset = { ...rec, level };
    store.set('scape.boostHeadset', boost.headset);
    toast(`Boost +${level} dB (slot ${rec.slot}) ✓`);
  });
}

// ---- slider ----
let sliderDragging = false;
let apoTimer = null;
let apoChain = Promise.resolve();

function showSliderValue(db) {
  const out = $('boostValue');
  out.textContent = `+${db} dB · ${dbToPercent(db)}%`;
  out.classList.toggle('hot', db > 9);
}

/** PC boost is on and the slider moved: rewrite the APO file (debounced, writes kept in order). */
function livePcLevel(db) {
  clearTimeout(apoTimer);
  apoTimer = setTimeout(() => {
    apoChain = apoChain.then(async () => {
      if (!boost.apo?.active) return; // Boost was turned off meanwhile
      try {
        boost.apo = await host.apoSet(db);
        const lv = boostActiveLevel();
        $('boostBadge').textContent = `BOOST +${lv} dB`;
        $('boostState').textContent = `On · +${lv} dB (PC)`;
        pushStatus();
      } catch (err) {
        toast(`Boost: ${err.message}`, true);
      }
    });
  }, 120);
}

async function setBoost(on, level) {
  const where = boost.headset ? 'headset' : boostActiveLevel() != null ? 'pc' : boost.where;
  try {
    if (where === 'pc') {
      if (on && !(await hearingNoteOk())) return;
      clearTimeout(apoTimer); // drop a pending slider write so it can't re-enable Boost after "off"
      const p = apoChain.then(() => host.apoSet(on ? level : 0));
      apoChain = p.catch(() => {});
      boost.apo = await p;
      toast(on ? `PC Boost +${level} dB on` : 'PC Boost off (APO config restored)');
    } else if (on) {
      if (level > HEADSET_MAX_DB) return toast(`Headset Boost is limited to +${HEADSET_MAX_DB} dB`, true);
      if (boost.headset) await headsetBoostLevel(level);
      else {
        if (!(await hearingNoteOk())) return;
        await headsetBoostOn(level);
      }
    } else await headsetBoostOff();
  } catch (err) {
    toast(`Boost: ${err.message}`, true);
  } finally {
    renderBoost();
  }
}

$('chkBoost').addEventListener('change', (e) => {
  const on = e.target.checked;
  e.target.checked = !on; // reflect real state only after it succeeded
  setBoost(on, Number($('rngBoost').value));
});
const rng = $('rngBoost');
rng.addEventListener('pointerdown', () => (sliderDragging = true));
rng.addEventListener('input', () => {
  const lv = Number(rng.value);
  showSliderValue(lv);
  // PC: follow the slider live. Headset: wait for release (each change is a confirmed device write).
  if (boost.apo?.active && !boost.headset) livePcLevel(lv);
});
rng.addEventListener('change', () => {
  sliderDragging = false;
  const lv = Number(rng.value);
  boost.level = lv;
  store.set('scape.boostLevel', lv);
  if (boost.headset) setBoost(true, lv);
  else if (boost.apo?.active) livePcLevel(lv);
});
document.querySelectorAll('input[name=boostWhere]').forEach((r) =>
  r.addEventListener('change', () => {
    boost.where = r.value;
    store.set('scape.boostWhere', r.value);
    if (r.value === 'headset' && boost.level > HEADSET_MAX_DB) boost.level = HEADSET_MAX_DB;
    renderBoost();
  }),
);

// ---------------------------------------------------------------------------
// log, connect button, autostart, startup
// ---------------------------------------------------------------------------
function appendLog(e) {
  const pre = $('log');
  pre.textContent += `${e.t} ${e.dir} ${e.note.padEnd(18)} ${e.hex}\n`;
  if (pre.textContent.length > 60000) pre.textContent = pre.textContent.slice(-40000);
  pre.scrollTop = pre.scrollHeight;
}

$('btnConnect').addEventListener('click', async () => {
  if (state.device) return disconnect();
  if (!ScapeDevice.supported()) return toast('WebHID is not available. Use Chrome/Edge or the desktop app.', true);
  try {
    const d = (await ScapeDevice.findPermitted()) || (await ScapeDevice.request());
    if (!d) return toast('No Scape headset or dongle found', true);
    await connect(d);
  } catch (err) {
    if (err.name !== 'NotFoundError') toast(err.message, true);
  }
});
$('btnRefresh').addEventListener('click', async () => {
  if (!state.device) return;
  setBusy(true);
  try { await readEverything(); } catch (err) { toast(err.message, true); } finally { setBusy(false); }
});

if (ScapeDevice.supported()) {
  navigator.hid.addEventListener('connect', autoConnect);
  navigator.hid.addEventListener('disconnect', (e) => {
    if (state.device && e.device === state.device.dev) {
      disconnect();
      toast('Headset disconnected');
    }
  });
}

// battery / state poll (read-only), and re-check the dongle link if the headset was off
setInterval(async () => {
  if (!state.device || state.busy) return;
  if (state.info && state.info.headsetLinked === false) {
    setBusy(true);
    try {
      await readEverything();
      if (state.enforce && state.hs) await applyDefaults({ auto: true });
    } catch {} finally { setBusy(false); }
  } else refreshState();
}, 60000);

if (host) {
  document.querySelector('.host-only').classList.remove('hidden');
  host.getAutostart().then((on) => ($('chkAutostart').checked = on));
  $('chkAutostart').addEventListener('change', async (e) => {
    e.target.checked = await host.setAutostart(e.target.checked);
  });
}

window.addEventListener('resize', renderGraph);

// boot
lighting = initLighting({
  $, el, state, store, toast, guarded,
  canWrite: () => !!state.device && state.readDone && !state.busy && !!state.hs,
  afterWrite: async (d) => {
    await new Promise((r) => setTimeout(r, 300));
    state.hs = await d.readState();
    renderDevice();
    renderDefaults();
  },
});
renderPresets();
setBands(presetBands(BUILTIN.find((p) => p.name === state.currentPreset)), state.currentPreset);
renderBackups();
renderDefaults();
renderBoost();
refreshApo();
pushStatus();
if (ScapeDevice.supported()) autoConnect();
