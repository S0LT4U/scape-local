// Headset-side Boost: an extra high-shelf band at 20 Hz added on top of the slot's EQ.
// A high shelf at 20 Hz raises everything above it by the same amount (+X dB from ~100 Hz
// to 20 kHz; about X/2 at 20 Hz itself), so it behaves like a broadband gain.
import { MAX_BANDS, encodeEqCode } from './eqcode.js';

export const BOOST_BAND = { type: 2, freq: 20, q: 0.707 };
export const HEADSET_MAX_DB = 12;

/** Boost levels (same table as lib/apo.mjs; a test keeps them in sync). `headset: false` = PC only. */
export const dbToPercent = (db) => Math.round(Math.pow(10, db / 20) * 100);
export const LEVELS = [3, 6, 9, 12, 14].map((db) => ({ db, headset: db <= HEADSET_MAX_DB, percent: dbToPercent(db) }));

export function isBoostBand(b) {
  return b && b.type === BOOST_BAND.type && Math.round(b.freq) === BOOST_BAND.freq && Math.abs(b.q - BOOST_BAND.q) < 0.01 && b.gain > 0;
}

/** Can a boost band be added to these bands? Returns null if yes, else the reason. */
export function headsetBoostBlocker(bands) {
  if (bands.length && isBoostBand(bands[bands.length - 1])) return 'This slot already has a boost band';
  if (bands.length >= MAX_BANDS) return `This preset already uses all ${MAX_BANDS} bands the headset allows, so there is no room for the boost band. Use PC Boost instead.`;
  return null;
}

export function applyHeadsetBoost(bands, db) {
  if (!(db > 0 && db <= HEADSET_MAX_DB)) throw new Error(`Headset boost must be +1…+${HEADSET_MAX_DB} dB`);
  const why = headsetBoostBlocker(bands);
  if (why) throw new Error(why);
  return [...bands, { ...BOOST_BAND, gain: db }];
}

/** Remove a trailing boost band (if present). */
export function stripHeadsetBoost(bands) {
  return bands.length && isBoostBand(bands[bands.length - 1]) ? bands.slice(0, -1) : bands;
}

/** True if `boosted` is exactly `original` + one boost band (compared via the share-code bytes). */
export function isBoostOf(boosted, original) {
  return boosted.length === original.length + 1 && isBoostBand(boosted.at(-1)) && encodeEqCode(boosted.slice(0, -1)) === encodeEqCode(original);
}
