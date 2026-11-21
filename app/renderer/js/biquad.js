// RBJ Audio-EQ-Cookbook biquads, matching Adjust Pro's implementation (PROTOCOL.md §5.2).
// Returns normalised coefficients {b: [b0, b1, b2], a: [a1, a2]} (a0 = 1).

// Device sample-rate codes -> Hz. NOTE: Adjust Pro uses 44000 (not 44100) for the
// 44.1 kHz set; we copy that so our coefficients match what the official app writes.
export const RATES = [
  { code: 1, hz: 44000, label: '44.1k' },
  { code: 2, hz: 48000, label: '48k' },
  { code: 4, hz: 96000, label: '96k' },
];

export function coefficients(type, freq, gain, q, fs) {
  const w0 = (2 * Math.PI * freq) / fs;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const A = Math.pow(10, gain / 40);
  const sqA = Math.sqrt(A);
  let b, a; // un-normalised, a[0] = a0
  switch (type) {
    case 0: // peaking
      b = [1 + alpha * A, -2 * cos, 1 - alpha * A];
      a = [1 + alpha / A, -2 * cos, 1 - alpha / A];
      break;
    case 1: // low shelf
      b = [A * (A + 1 - (A - 1) * cos + 2 * sqA * alpha), 2 * A * (A - 1 - (A + 1) * cos), A * (A + 1 - (A - 1) * cos - 2 * sqA * alpha)];
      a = [A + 1 + (A - 1) * cos + 2 * sqA * alpha, -2 * (A - 1 + (A + 1) * cos), A + 1 + (A - 1) * cos - 2 * sqA * alpha];
      break;
    case 2: // high shelf
      b = [A * (A + 1 + (A - 1) * cos + 2 * sqA * alpha), -2 * A * (A - 1 + (A + 1) * cos), A * (A + 1 + (A - 1) * cos - 2 * sqA * alpha)];
      a = [1 + A - (A - 1) * cos + 2 * sqA * alpha, 2 * (A - 1 - (A + 1) * cos), 1 + A - (A - 1) * cos - 2 * sqA * alpha];
      break;
    case 3: // low pass
      b = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
      a = [1 + alpha, -2 * cos, 1 - alpha];
      break;
    case 4: // high pass
      b = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
      a = [1 + alpha, -2 * cos, 1 - alpha];
      break;
    case 5: // notch
      b = [1, -2 * cos, 1];
      a = [1 + alpha, -2 * cos, 1 - alpha];
      break;
    case 6: // band pass (constant 0 dB peak gain)
      b = [sin / 2, 0, -sin / 2];
      a = [1 + alpha, -2 * cos, 1 - alpha];
      break;
    default:
      throw new Error(`Unknown filter type ${type}`);
  }
  const a0 = a[0];
  return {
    b: b.map((x) => Math.fround(x / a0)),
    a: [Math.fround(a[1] / a0), Math.fround(a[2] / a0)],
  };
}

/** Magnitude in dB of one biquad at frequency f. */
export function magnitudeDb({ b, a }, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b[0] + b[1] * c1 + b[2] * c2, ni = -(b[1] * s1 + b[2] * s2);
  const dr = 1 + a[0] * c1 + a[1] * c2, di = -(a[0] * s1 + a[1] * s2);
  const mag2 = (nr * nr + ni * ni) / (dr * dr + di * di);
  return 10 * Math.log10(mag2);
}

/** Total response in dB of a band list at each frequency in freqs. */
export function responseDb(bands, freqs, fs = 48000) {
  const filters = bands.map((bd) => coefficients(bd.type, bd.freq, bd.gain, bd.q, fs));
  return freqs.map((f) => filters.reduce((s, flt) => s + magnitudeDb(flt, f, fs), 0));
}

export function logFreqs(n = 300, lo = 20, hi = 20000) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(lo * Math.pow(hi / lo, i / (n - 1)));
  return out;
}
