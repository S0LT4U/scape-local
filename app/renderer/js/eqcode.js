// EQ share-code codec, compatible with Adjust Pro's "EQ code" (see PROTOCOL.md §5.6).
//
// base64 of:
//   u8 version (=1), u8 N,
//   N x 15 bytes: u8 type, f32le gain, f32le Q, u16le freq, 4 x 0x00
//   u8 XOR of all preceding bytes

export const FILTER_TYPES = ['peak', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'notch', 'bandpass'];
export const FILTER_LABELS = ['Peak', 'Low shelf', 'High shelf', 'Low pass', 'High pass', 'Notch', 'Band pass'];

export const MAX_BANDS = 5; // device limit (MAX_EQ_POINTS)
export const LIMITS = {
  freq: [20, 20000],
  gain: [-12, 12],
  q: [0.4, 10],
};

const BAND_BYTES = 15;

function b64encode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(str) {
  const s = atob(str.trim());
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function xorAll(bytes, end) {
  let x = 0;
  for (let i = 0; i < end; i++) x ^= bytes[i];
  return x;
}

/** Decode an EQ code into bands: [{type, freq, gain, q}] (type is the numeric filter id). */
export function decodeEqCode(code) {
  let bytes;
  try {
    bytes = b64decode(code);
  } catch {
    throw new Error('Not valid base64');
  }
  if (bytes.length < 3) throw new Error('Code too short');
  if (bytes[0] !== 1) throw new Error(`Unsupported version ${bytes[0]}`);
  const n = bytes[1];
  const expected = 2 + n * BAND_BYTES + 1;
  if (bytes.length !== expected) throw new Error(`Length ${bytes.length}, expected ${expected} for ${n} bands`);
  if (xorAll(bytes, bytes.length - 1) !== bytes[bytes.length - 1]) throw new Error('Checksum mismatch');
  const dv = new DataView(bytes.buffer);
  const bands = [];
  for (let i = 0, o = 2; i < n; i++, o += BAND_BYTES) {
    bands.push({
      type: dv.getUint8(o),
      gain: dv.getFloat32(o + 1, true),
      q: dv.getFloat32(o + 5, true),
      freq: dv.getUint16(o + 9, true),
    });
  }
  return bands;
}

/** Encode bands into an EQ code (byte-identical to Adjust Pro's encoder). */
export function encodeEqCode(bands) {
  const len = 2 + bands.length * BAND_BYTES + 1;
  const bytes = new Uint8Array(len);
  const dv = new DataView(bytes.buffer);
  dv.setUint8(0, 1);
  dv.setUint8(1, bands.length);
  bands.forEach((b, i) => {
    const o = 2 + i * BAND_BYTES;
    dv.setUint8(o, b.type);
    dv.setFloat32(o + 1, Math.fround(b.gain), true);
    dv.setFloat32(o + 5, Math.fround(b.q), true);
    dv.setUint16(o + 9, Math.round(b.freq), true);
  });
  bytes[len - 1] = xorAll(bytes, len - 1);
  return b64encode(bytes);
}

/** Round floats for display / comparison (f32 artefacts like 0.699999988 -> 0.7). */
export function tidy(x, digits = 4) {
  return Number(Number(x).toFixed(digits));
}

/** Validate bands against device + safety limits. Returns a list of error strings (empty = OK). */
export function validateBands(bands) {
  const errs = [];
  if (!Array.isArray(bands)) return ['Bands must be a list'];
  if (bands.length > MAX_BANDS) errs.push(`Too many bands: ${bands.length} (device max ${MAX_BANDS})`);
  bands.forEach((b, i) => {
    const n = `Band ${i + 1}`;
    if (!Number.isInteger(b.type) || b.type < 0 || b.type >= FILTER_TYPES.length) errs.push(`${n}: unknown filter type ${b.type}`);
    if (!(b.freq >= LIMITS.freq[0] && b.freq <= LIMITS.freq[1])) errs.push(`${n}: frequency ${b.freq} Hz outside ${LIMITS.freq.join('–')}`);
    if (!(b.gain >= LIMITS.gain[0] - 1e-6 && b.gain <= LIMITS.gain[1] + 1e-6)) errs.push(`${n}: gain ${tidy(b.gain, 2)} dB outside ±${LIMITS.gain[1]}`);
    if (!(b.q >= LIMITS.q[0] - 1e-6 && b.q <= LIMITS.q[1] + 1e-6)) errs.push(`${n}: Q ${tidy(b.q, 3)} outside ${LIMITS.q.join('–')}`);
  });
  return errs;
}

export function describeBands(bands) {
  if (!bands.length) return 'Flat';
  return bands
    .map((b) => `${FILTER_LABELS[b.type] ?? '?'} ${Math.round(b.freq)} Hz ${tidy(b.gain, 2) > 0 ? '+' : ''}${tidy(b.gain, 2)} dB Q${tidy(b.q, 2)}`)
    .join(' | ');
}
