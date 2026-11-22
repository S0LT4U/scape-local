// Scape headset lighting: effect rendering and upload packets. Pure (no I/O), unit-tested in Node.
//
// The headset stores one frame-based effect in effect slot 1 and plays it in a loop. An effect is a
// "package": a 48-byte header followed by frames of 12 LEDs x RGB (36 bytes per frame), played at 20 fps.
// Upload: SET_EFFECT (A4 01) -> SEND_EFFECT (A4 02, 60 bytes each) x N -> COMMIT (A4 03) -> SELECT (A4 04 01).
// See PROTOCOL.md §6. The renderers below reproduce Adjust Pro's so the headset looks the same.

export const LED_COUNT = 12;
export const FPS = 20;
export const EFFECT_SLOT = 1;
export const CHUNK = 60;
export const META_LEN = 42;
export const HEADER_LEN = 6 + META_LEN;
export const MAX_FRAMES = 255; // the header stores the frame count in one byte
export const MAX_PACKAGE = HEADER_LEN + MAX_FRAMES * LED_COUNT * 3;

export const MODE = { SHIFT: 0, STILL: 1, BREATHE: 2, LAVA_LAMP: 6, WAVES: 7, TWO_COLOR_FADE: 8 };

/** Patterns the Scape supports, with how many colours each takes (same as Adjust Pro). */
export const PATTERNS = [
  { mode: MODE.SHIFT, name: 'Shift', colors: 6, speed: true },
  { mode: MODE.STILL, name: 'Still', colors: 1, speed: false },
  { mode: MODE.BREATHE, name: 'Breathe', colors: 2, speed: true },
  { mode: MODE.WAVES, name: 'Waves', colors: 2, speed: true },
  { mode: MODE.TWO_COLOR_FADE, name: 'Two color fade', colors: 2, speed: true },
  { mode: MODE.LAVA_LAMP, name: 'Lava lamp', colors: 6, speed: true },
];
export const patternFor = (mode) => PATTERNS.find((p) => p.mode === mode);

/** Default wave shape for Waves when none is given (Adjust Pro's defaults). */
export const WAVE_DEFAULTS = { upWave: 10, topWave: 10, downWave: 4, freq: 50 };

/** Fractal themes offered for the Scape in Adjust Pro (id = Adjust Pro preset id, stored on the headset). */
export const THEMES = [
  { id: 0, name: 'Northern lights', mode: MODE.SHIFT, speed: 40, colors: ['#0074C5', '#6E00FA', '#00FAEB', '#C940BD', '#95FDE4', '#00F03C'] },
  { id: 1, name: 'Summer sky', mode: MODE.SHIFT, speed: 35, colors: ['#FFF4A8', '#FA9A00', '#FA1500', '#B040C9', '#959EFD', '#FFFFFF'] },
  { id: 2, name: 'Sunset', mode: MODE.SHIFT, speed: 75, colors: ['#C60000', '#C60000', '#E55F00', '#E55F00', '#C10016', '#F400A3'] },
  { id: 13, name: 'Starfall', mode: MODE.WAVES, speed: 3, colors: ['#000E07', '#77FF22'], wave: { upWave: 6, topWave: 3, downWave: 6, freq: 100 } },
  { id: 12, name: 'Glistening ice', mode: MODE.LAVA_LAMP, speed: 15, colors: ['#28D0FF', '#13F3FF', '#00B7F4', '#FFFFFF', '#C1F0FF', '#0020DB'] },
  { id: 14, name: 'Pink sapphire', mode: MODE.TWO_COLOR_FADE, speed: 75, colors: ['#FF0059', '#000000'] },
  { id: 15, name: 'Lunar mist', mode: MODE.TWO_COLOR_FADE, speed: 75, colors: ['#9B9B9B', '#000000'] },
  { id: 3, name: 'Mystic night', mode: MODE.SHIFT, speed: 60, colors: ['#560055', '#9A00FA', '#FA00CC', '#431447', '#AC03D2', '#3C0042'] },
  { id: 11, name: 'Campfire', mode: MODE.LAVA_LAMP, speed: 50, colors: ['#ff0a00', '#0a0500', '#ff1e00', '#ff3200', '#ff5000', '#0a0a05'] },
  { id: 5, name: 'Radiant dawn', mode: MODE.SHIFT, speed: 45, colors: ['#FFA25B', '#FF9123', '#FF9122', '#FFC35B', '#FFA023', '#FFC35B'] },
].map((t) => ({ brightness: 100, ...t }));

/** Preset id written for custom patterns. Adjust Pro numbers user presets from 64 up. */
export const CUSTOM_PRESET_ID = 64;

// ---------------------------------------------------------------------------
// Colour helpers (match tinycolor2 1.6, which Adjust Pro uses, so frames are byte-identical)
// ---------------------------------------------------------------------------
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`Invalid colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();

const bound255 = (v) => {
  v = Math.min(255, Math.max(0, parseFloat(v)));
  return Math.abs(v - 255) < 0.000001 ? 255 : ((v % 255) / 255) * 255;
};
const norm = (c) => c.map((v) => Math.round(bound255(v)));
/** tinycolor.mix(c1, c2, amount 0..100) -> [r,g,b] */
export function mix(c1, c2, amount) {
  amount = amount === 0 ? 0 : amount || 50;
  const a = norm(c1);
  const b = norm(c2);
  const p = amount / 100;
  return [0, 1, 2].map((i) => Math.round(bound255((b[i] - a[i]) * p + a[i])));
}

const scale = (c, brightness) => c.map((v) => Math.round(v * (brightness / 100)));
const be16 = (n) => [(n >> 8) & 255, n & 255];

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------
const durationFor = (speed) => 11 - Math.floor(Math.min(100, Math.max(10, speed)) / 10);

/** Concatenate many small arrays into one Uint8Array (values are stored with Uint8Array semantics). */
function bytes(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Interpolate a timestamp list ([u16 ms-ish, 36 bytes]...) into frames (Adjust Pro's base renderer). */
function renderTimestamps(ts, durationSeconds, ledNum) {
  const step = 3 * ledNum + 2;
  const n = ts.length / step;
  const last = (ts[(n - 1) * step] << 8) + ts[(n - 1) * step + 1];
  const per = Math.ceil(last / (durationSeconds * FPS));
  const out = [];
  for (let k = 0; k < n - 1; k++) {
    const a0 = 2 + k * step;
    const b0 = 2 + (k + 1) * step;
    const ta = (ts[a0 - 2] << 8) + ts[a0 - 1];
    const tb = (ts[b0 - 2] << 8) + ts[b0 - 1];
    const count = Math.round((tb - ta) / per);
    for (let f = 0; f < count; f++) {
      const pct = Math.round((100 * f) / count);
      for (let o = 0; o < 3 * ledNum; o += 3) {
        out.push(mix([ts[a0 + o], ts[a0 + o + 1], ts[a0 + o + 2]], [ts[b0 + o], ts[b0 + o + 1], ts[b0 + o + 2]], pct));
      }
    }
  }
  return bytes(out);
}

const SHIFT_ORDER = [4, 5, 3, 0, 1, 2];
function renderShift(colors, speed, ledNum) {
  const duration = durationFor(speed);
  const ledColors = (set) => {
    const out = [];
    const per = set.length / ledNum;
    let r = 0;
    for (let o = 0; o < ledNum; o++) {
      let L = o * per - r;
      if (L > 1) {
        r++;
        L = o * per - r;
      }
      const next = r + 1 < set.length ? set[r + 1] : set[0];
      out.push(...mix(set[r], next, 100 * L));
    }
    return out;
  };
  const rotate = (set) => SHIFT_ORDER.map((i) => set[i]);
  let set = colors.slice();
  const frames = [];
  const steps = Math.round((duration * FPS) / SHIFT_ORDER.length);
  for (let s = 0; s < SHIFT_ORDER.length; s++) {
    const from = ledColors(set);
    const to = ledColors(rotate(set));
    for (let f = 0; f < steps; f++) {
      const L = f / steps;
      for (let o = 0; o < 3 * ledNum; o += 3) frames.push(mix(from.slice(o, o + 3), to.slice(o, o + 3), 100 * L));
    }
    set = rotate(set);
  }
  return { frames: bytes(frames), duration };
}

function renderStill(color, ledNum) {
  const duration = durationFor(100);
  const f = new Uint8Array(3 * ledNum * FPS * duration);
  for (let i = 0; i < f.length; i++) f[i] = color[i % 3];
  return { frames: f, duration };
}

function renderBreathe(c1, c2, speed, ledNum) {
  const duration = durationFor(speed);
  const total = FPS * duration;
  const dim1 = c1.map((v) => Math.ceil(v / 20));
  const dim2 = c2.map((v) => Math.ceil(v / 20));
  const hold = Math.round((3 * total) / 10);
  const fall = Math.round((1 * total) / 10);
  const rise = Math.round((1 * total) / 10);
  const out = [];
  const fill = (n, colorAt) => {
    for (let i = 0; i < n; i++) {
      const c = colorAt(i);
      for (let l = 0; l < ledNum; l++) out.push(c);
    }
  };
  fill(hold, () => c1);
  fill(rise, (d) => mix(dim1, c1, (100 * (rise - d)) / rise));
  fill(fall, (d) => mix(c2, dim2, (100 * (fall - d)) / fall));
  fill(hold, () => c2);
  fill(rise, (d) => mix(dim2, c2, (100 * (rise - d)) / rise));
  fill(fall, (d) => mix(c1, dim1, (100 * (fall - d)) / fall));
  return { frames: bytes(out), duration };
}

function renderWaves(c1, c2, speed, wave, ledNum) {
  const duration = durationFor(speed);
  const { upWave, topWave, downWave } = wave;
  const total = downWave + topWave + upWave;
  const shape = new Uint8Array(3 * total);
  let L = 0;
  for (; L < 3 * downWave; L += 3) shape.set(mix(c1, c2, (L / (3 * downWave)) * 100), L);
  for (; L < 3 * (downWave + topWave); L += 3) shape.set(c2, L);
  for (; L < 3 * total; L += 3) shape.set(mix(c1, c2, 100 - (L / (3 * total)) * 100), L);

  const move = (pct) => {
    const len = 3 * ledNum + 2 * shape.length;
    const r = new Uint8Array(len);
    const pos = (pct / 100) * (ledNum + (2 * shape.length) / 3);
    const at = Math.floor(pos);
    for (let s = 0; s < len; s += 3) r.set(c1, s);
    for (let s = 0; s < shape.length; s += 3) {
      r[s + 3 * at] = shape[s];
      r[s + 3 * at + 1] = shape[s + 1];
      r[s + 3 * at + 2] = shape[s + 2];
    }
    const w = Math.floor((100 * pos) % 100);
    const v = 100 - w;
    // Reads past the end are undefined -> NaN -> 0 when stored, exactly like Adjust Pro.
    for (let s = 0; s < r.length; s += 3) {
      r[s] = (r[s] * w + r[s + 3] * v) / 100;
      r[s + 1] = (r[s + 1] * w + r[s + 4] * v) / 100;
      r[s + 2] = (r[s + 2] * w + r[s + 5] * v) / 100;
    }
    return r.slice(shape.length, shape.length + 3 * ledNum);
  };
  const n = FPS * duration;
  const out = [];
  for (let i = 0; i < n; i++) out.push(move((i / n) * 100));
  return { frames: bytes(out), duration };
}

function renderTwoColorFade(c1, c2, speed, ledNum) {
  const duration = durationFor(speed);
  const base = new Uint8Array(3 * ledNum);
  for (let l = 0; l < ledNum; l++) base.set(mix(c1, c2, 100 * Math.sin((l / (ledNum - 1)) * Math.PI)), 3 * l);
  const t = bytes([base, base]);
  const n = duration * FPS;
  const w = (2 * Math.PI) / n;
  const out = [new Uint8Array(base)];
  for (let i = 1; i < n; i++) {
    const a = w * i;
    const r =
      a < Math.PI / 2
        ? Math.abs((ledNum / 4) * Math.sin(a))
        : a < Math.PI
          ? Math.abs((ledNum / 4) * (2 - Math.sin(a)))
          : a < (3 * Math.PI) / 2
            ? ledNum / 2 + Math.abs((ledNum / 4) * Math.sin(a))
            : ledNum / 2 + Math.abs((ledNum / 4) * (2 + Math.sin(a)));
    const L = Math.floor(r);
    const f = (100 * r) % 100;
    const frame = new Uint8Array(3 * ledNum);
    for (let e = 0; e < 3 * ledNum; e += 3) {
      const p = e + 3 * L;
      const q = e + 3 * (L + 1);
      for (let c = 0; c < 3; c++) frame[e + c] = Math.round((t[p + c] * (100 - f) + t[q + c] * f) / 100);
    }
    out.push(frame);
  }
  return { frames: bytes(out), duration };
}

function renderLavaLamp(colors, speed, ledNum, random) {
  const duration = durationFor(speed);
  const t = new Uint8Array(3 * ledNum);
  const step = 6 + Math.round(100 - speed);
  const randomize = () => {
    for (let o = 0; o < 3 * ledNum; o += 3) {
      const e = Math.floor(12 * random());
      const c = e < 6 ? colors[e] : colors[e - 6].map((v) => v / 2);
      t[o] = c[0];
      t[o + 1] = c[1];
      t[o + 2] = c[2];
    }
  };
  let time = 0;
  const parts = [];
  randomize();
  const first = new Uint8Array(t);
  parts.push(be16(time), first);
  time += step + Math.floor(10 * random()) - 5;
  for (let k = 1; k < 14; k++) {
    randomize();
    parts.push(be16(time), new Uint8Array(t));
    time += step + Math.floor(10 * random()) - 5;
  }
  parts.push(be16(time), first);
  return { frames: renderTimestamps(bytes(parts), duration, ledNum), duration };
}

/**
 * Validate and normalise an effect spec:
 * { mode, colors: ['#RRGGBB'...], speed 1..100, brightness 0..100, presetId?, wave? }
 */
export function normalizeEffect(spec) {
  const pattern = patternFor(spec.mode);
  if (!pattern) throw new Error(`Unsupported lighting pattern ${spec.mode}`);
  const colors = (spec.colors || []).map(hexToRgb);
  if (colors.length !== pattern.colors) throw new Error(`${pattern.name} needs ${pattern.colors} colour(s)`);
  const speed = pattern.speed ? Math.round(Number(spec.speed)) : 100;
  if (!(speed >= 1 && speed <= 100)) throw new Error('Speed must be 1–100');
  const brightness = Math.round(Number(spec.brightness ?? 100));
  if (!(brightness >= 0 && brightness <= 100)) throw new Error('Brightness must be 0–100');
  const presetId = spec.presetId ?? CUSTOM_PRESET_ID;
  if (!(Number.isInteger(presetId) && presetId >= 0 && presetId <= 254)) throw new Error('Bad preset id');
  const wave = { ...WAVE_DEFAULTS, ...(spec.wave || {}) };
  if (pattern.mode === MODE.WAVES && [wave.upWave, wave.topWave, wave.downWave, wave.freq].some((v) => !(Number.isInteger(v) && v >= 1 && v <= 100)))
    throw new Error('Bad wave shape');
  return { mode: pattern.mode, colors, speed, brightness, presetId, wave };
}

/**
 * Render an effect. Returns { frames, duration, metadata } where metadata is what Adjust Pro stores
 * (preset id first), so Adjust Pro shows the same preset when it reads the headset.
 * `random` is only used by Lava lamp (which is random by design).
 */
export function renderEffect(spec, { random = Math.random, ledNum = LED_COUNT } = {}) {
  const e = normalizeEffect(spec);
  const lit = e.colors.map((c) => scale(c, e.brightness));
  const raw = e.colors.flat();
  let r;
  let meta;
  switch (e.mode) {
    case MODE.SHIFT:
      r = renderShift(lit, e.speed, ledNum);
      meta = [e.mode, e.speed, ...raw, e.brightness];
      break;
    case MODE.STILL:
      r = renderStill(lit[0], ledNum);
      meta = [e.mode, 100, ...raw, e.brightness];
      break;
    case MODE.BREATHE:
      r = renderBreathe(lit[0], lit[1], e.speed, ledNum);
      meta = [e.mode, e.speed, ...raw, e.brightness];
      break;
    case MODE.WAVES:
      r = renderWaves(lit[0], lit[1], e.speed, e.wave, ledNum);
      meta = [e.mode, e.speed, ...raw, e.wave.upWave, e.wave.topWave, e.wave.downWave, 100 - e.wave.freq, e.brightness, ...lit[1]];
      break;
    case MODE.TWO_COLOR_FADE:
      r = renderTwoColorFade(lit[0], lit[1], e.speed, ledNum);
      meta = [e.mode, e.speed, ...raw, e.speed, e.brightness];
      break;
    case MODE.LAVA_LAMP:
      r = renderLavaLamp(lit, e.speed, ledNum, random);
      meta = [e.mode, e.speed, ...raw, e.brightness];
      break;
  }
  return { frames: r.frames, duration: r.duration, metadata: [e.presetId, ...meta] };
}

/** Header + frames, as stored on the headset. */
export function buildPackage({ frames, duration, metadata }, ledNum = LED_COUNT) {
  const frameCount = frames.length / (3 * ledNum);
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > MAX_FRAMES) throw new Error(`Bad frame count ${frameCount}`);
  if (metadata.length > META_LEN) throw new Error('Metadata too long');
  const header = new Uint8Array(HEADER_LEN);
  header.set([0xa5, 0x5a, frameCount, 0xff, FPS, duration, ...metadata]);
  return bytes([header, frames]);
}

export const checksum = (pkg) => pkg.reduce((s, b) => s + b, 0) & 255;

/** Every packet for one effect upload, in order. */
export function buildEffectUpload(spec, opts = {}) {
  const pkg = buildPackage(renderEffect(spec, opts));
  if (pkg.length > MAX_PACKAGE) throw new Error('Effect too large');
  const packets = [new Uint8Array([0xa4, 0x01, EFFECT_SLOT, checksum(pkg), pkg.length & 255, (pkg.length >> 8) & 255])];
  for (let o = 0; o < pkg.length; o += CHUNK) {
    const part = pkg.subarray(o, o + CHUNK);
    const p = new Uint8Array(3 + CHUNK);
    p.set([0xa4, 0x02, part.length]);
    p.set(part, 3);
    packets.push(p);
  }
  packets.push(new Uint8Array([0xa4, 0x03]));
  packets.push(new Uint8Array([0xa4, 0x04, EFFECT_SLOT]));
  return { packets, package: pkg };
}

/** READ_EFFECT for the metadata of effect slot 1 (A4 05 01 00 00). */
export const readEffectMeta = () => new Uint8Array([0xa4, 0x05, EFFECT_SLOT, 0x00, 0x00]);

/** Parse a READ_EFFECT reply (metadata starts at byte 10). Returns null when the slot holds nothing we understand. */
export function parseEffectMeta(reply) {
  const m = reply.slice(10, 10 + META_LEN);
  if (m.length < 6 || m.every((b) => b === 0)) return null;
  const [presetId, mode, speed] = m;
  const pattern = patternFor(mode);
  if (!pattern) return { presetId, mode, speed, unknown: true };
  const colors = [];
  for (let i = 0; i < pattern.colors; i++) colors.push(rgbToHex(Array.from(m.slice(3 + 3 * i, 6 + 3 * i))));
  const after = 3 + 3 * pattern.colors;
  let brightness;
  let wave;
  if (mode === MODE.WAVES) {
    wave = { upWave: m[after], topWave: m[after + 1], downWave: m[after + 2], freq: 100 - m[after + 3] };
    brightness = m[after + 4];
  } else if (mode === MODE.TWO_COLOR_FADE) brightness = m[after + 1];
  else brightness = m[after];
  const theme = THEMES.find((t) => t.id === presetId);
  return { presetId, mode, speed, colors, brightness, wave, theme: theme ? theme.name : null };
}
