// Fractal Scape HID protocol: packet builders, reply parsers and the send guard.
// Everything here is pure (no I/O) so it can be unit-tested in Node. See PROTOCOL.md.

import { coefficients, RATES } from './biquad.js';

export const VID = 0x36bc;
export const PID_HEADSET = 0x2001;
export const PID_DONGLE = 0x0001;
export const REPORT_ID = 2;
export const USAGE_PAGE = 0xff00;
export const USAGE = 0x01;

export const HID_FILTERS = [
  { vendorId: VID, productId: PID_HEADSET, usagePage: USAGE_PAGE, usage: USAGE },
  { vendorId: VID, productId: PID_DONGLE, usagePage: USAGE_PAGE, usage: USAGE },
];

const G = { FACTORY_HS: 0xf1, FACTORY_DONGLE: 0x11, EQ: 0xa7, EFFECT: 0xa4 };

// ---------------------------------------------------------------------------
// Send guard: an ALLOWLIST. Anything not listed here can never be sent.
// key = (group << 8) | command
// ---------------------------------------------------------------------------
const k = (g, c) => (g << 8) | c;
export const ALLOWED = new Map([
  // reads
  [k(G.FACTORY_HS, 0x01), { name: 'GET_FW_VERSION', write: false, reply: true }],
  [k(G.FACTORY_HS, 0x02), { name: 'GET_SERIAL', write: false, reply: true }],
  [k(G.FACTORY_HS, 0x04), { name: 'GET_EDITION', write: false, reply: true }],
  [k(G.FACTORY_HS, 0x05), { name: 'GET_BT_ADDR', write: false, reply: true }],
  [k(G.FACTORY_HS, 0x21), { name: 'GET_DEVICE_STATE', write: false, reply: true }],
  [k(G.FACTORY_DONGLE, 0x01), { name: 'DONGLE_GET_FW_VERSION', write: false, reply: true }],
  [k(G.FACTORY_DONGLE, 0x02), { name: 'DONGLE_GET_SERIAL', write: false, reply: true }],
  [k(G.FACTORY_DONGLE, 0x21), { name: 'DONGLE_GET_STATE', write: false, reply: true }],
  [k(G.EQ, 0x04), { name: 'GET_EQ_SETTINGS', write: false, reply: true }],
  [k(G.EQ, 0x05), { name: 'GET_EQ_COEF', write: false, reply: true }],
  // writes
  [k(G.EQ, 0x01), { name: 'SET_EQ_SETTINGS', write: true, reply: true }],
  [k(G.EQ, 0x02), { name: 'SET_EQ_COEF', write: true, reply: true }],
  [k(G.EQ, 0x03), { name: 'COMMIT_EQ', write: true, reply: true }],
  [k(G.EQ, 0x07), { name: 'SELECT_EQ_SLOT', write: true, reply: false }],
  [k(G.EFFECT, 0x04), { name: 'SELECT_EFFECT_SLOT', write: true, reply: true }],
  // lighting effect upload (effect slot 1 only; see lighting.js and PROTOCOL.md §6)
  [k(G.EFFECT, 0x01), { name: 'SET_EFFECT', write: true, reply: true }],
  [k(G.EFFECT, 0x02), { name: 'SEND_EFFECT', write: true, reply: true }],
  [k(G.EFFECT, 0x03), { name: 'COMMIT_EFFECT', write: true, reply: true }],
  [k(G.EFFECT, 0x05), { name: 'READ_EFFECT', write: false, reply: true }],
  [k(G.FACTORY_HS, 0x34), { name: 'SIDETONE_CONTROL', write: true, reply: true }],
  [k(G.FACTORY_HS, 0x36), { name: 'ENC_CONTROL', write: true, reply: true }],
]);

export class BlockedCommandError extends Error {}

/** Largest effect package: 48-byte header + 255 frames x 12 LEDs x RGB. */
export const MAX_EFFECT_PACKAGE = 48 + 255 * 36;

/** Throws unless the packet is on the allowlist and its arguments are in range. */
export function checkPacket(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) throw new BlockedCommandError('Malformed packet');
  const info = ALLOWED.get(k(bytes[0], bytes[1]));
  if (!info) throw new BlockedCommandError(`Blocked: ${hex(bytes.slice(0, 2))} is not on the allowlist`);
  // argument sanity for writes
  if (bytes[0] === G.EQ && [0x03, 0x07].includes(bytes[1]) && !(bytes[2] >= 1 && bytes[2] <= 3))
    throw new BlockedCommandError(`Blocked: EQ slot ${bytes[2]} out of range`);
  if (bytes[0] === G.EQ && bytes[1] === 0x03 && !(bytes[3] === 1 || bytes[3] === 2))
    throw new BlockedCommandError('Blocked: only LiveUpdate(1)/Save(2) commit modes are allowed');
  if (bytes[0] === G.EQ && bytes[1] === 0x01 && !((bytes[2] >> 4) >= 1 && (bytes[2] >> 4) <= 3 && bytes.length === 63))
    throw new BlockedCommandError('Blocked: EQ settings slot out of range or wrong length');
  if (bytes[0] === G.EQ && bytes[1] === 0x02 && !(bytes[2] >= 1 && bytes[2] <= 3 && [1, 2, 4].includes(bytes[3]) && bytes[4] <= 4 && bytes.length === 25))
    throw new BlockedCommandError('Blocked: EQ coefficient packet has an invalid slot/rate/point');
  if (bytes[0] === G.EQ && bytes[1] === 0x04 && !(bytes[2] >= 1 && bytes[2] <= 5 && bytes[3] <= 1))
    throw new BlockedCommandError('Blocked: EQ read slot out of range');
  if (bytes[0] === G.EFFECT && bytes[1] === 0x04 && bytes[2] > 3) throw new BlockedCommandError('Blocked: effect slot > 3');
  if (bytes[0] === G.EFFECT && bytes[1] === 0x01) {
    const len = bytes[4] | (bytes[5] << 8);
    // Length 0 would clear the slot; only real effect packages (header + at least one frame) are allowed.
    if (!(bytes.length === 6 && bytes[2] === 1 && len >= 48 + 36 && len <= MAX_EFFECT_PACKAGE))
      throw new BlockedCommandError('Blocked: SET_EFFECT must target effect slot 1 with a valid package length');
  }
  if (bytes[0] === G.EFFECT && bytes[1] === 0x02 && !(bytes.length === 63 && bytes[2] >= 1 && bytes[2] <= 60))
    throw new BlockedCommandError('Blocked: SEND_EFFECT chunk must be 1–60 bytes in a 63-byte packet');
  if (bytes[0] === G.EFFECT && bytes[1] === 0x03 && bytes.length !== 2)
    throw new BlockedCommandError('Blocked: COMMIT_EFFECT takes no arguments (frame-based commit only)');
  if (bytes[0] === G.EFFECT && bytes[1] === 0x05 && !(bytes.length === 5 && bytes[2] === 1))
    throw new BlockedCommandError('Blocked: READ_EFFECT is only allowed for effect slot 1');
  if (bytes[0] === G.FACTORY_HS && bytes[1] === 0x34 && !(bytes[2] >= 2 && bytes[2] <= 3 && bytes[3] >= 1 && bytes[3] <= 50))
    throw new BlockedCommandError('Blocked: sidetone action must be VolUp/VolDown with 1–50 steps');
  if (bytes[0] === G.FACTORY_HS && bytes[1] === 0x36 && bytes[2] > 1) throw new BlockedCommandError('Blocked: ENC value must be 0/1');
  return info;
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export const cmd = {
  fwVersion: (dongle = false) => new Uint8Array([dongle ? G.FACTORY_DONGLE : G.FACTORY_HS, 0x01]),
  serial: (dongle = false) => new Uint8Array([dongle ? G.FACTORY_DONGLE : G.FACTORY_HS, 0x02]),
  edition: () => new Uint8Array([G.FACTORY_HS, 0x04]),
  btAddr: () => new Uint8Array([G.FACTORY_HS, 0x05]),
  deviceState: (dongle = false) => new Uint8Array([dongle ? G.FACTORY_DONGLE : G.FACTORY_HS, 0x21]),
  eqData: (slot) => new Uint8Array([G.EQ, 0x04, slot, 0x00]),
  eqMeta: (slot) => new Uint8Array([G.EQ, 0x04, slot, 0x01]),
  // writes
  selectEqSlot: (slot) => new Uint8Array([G.EQ, 0x07, slot]),
  lights: (on) => new Uint8Array([G.EFFECT, 0x04, on ? 1 : 0]),
  enc: (on) => new Uint8Array([G.FACTORY_HS, 0x36, on ? 1 : 0]),
  sidetone: (action, steps) => new Uint8Array([G.FACTORY_HS, 0x34, action, steps]),
};
export const SIDETONE = { ENABLE: 1, VOL_UP: 2, VOL_DOWN: 3 };

/** A reply is valid if it echoes group+command and (except GET_EQ_SETTINGS) has status 0. */
export function replyMatches(sent, reply) {
  if (reply[0] !== sent[0] || reply[1] !== sent[1]) return false;
  if (sent[0] === G.EQ && sent[1] === 0x04) return true;
  return reply[2] === 0;
}

const nib = (b) => `${b >> 4}${b & 15}`;
export const parse = {
  fwVersion: (r) => `${nib(r[3])}.${nib(r[4])}.${nib(r[5])}`,
  serial: (r) => {
    let s = '';
    for (let i = 6; i < 6 + 17 && r[i]; i++) s += String.fromCharCode(r[i]);
    return s;
  },
  edition: (r) => r[3].toString(16).padStart(2, '0'),
  btAddr: (r) => Array.from(r.slice(3, 9), (b) => b.toString(16).padStart(2, '0')).join(':'),
  deviceState: (r) => ({
    boomMic: r[3] === 0,
    muted: r[4] === 0,
    eqSlot: r[5],
    lightSlot: r[6],
    lightsOn: r[6] !== 0,
    chatVol: r[7],
    gameVol: r[9],
    volumeState: r[11],
    btMode: r[12],
    hallSensor: r[13],
    battery: r[14],
    sidetoneOn: r[15] === 1,
    sidetoneRaw: r[16],
    sidetonePct: sidetonePercent(r[16]),
    btConnected: r[18] === 1,
    encOn: r[19] === 1,
    powerOn: r[20] === 1,
    // Windows Dynamic Lighting: opt-in switch (byte 40) and whether Windows currently drives the LEDs (byte 33 == 0).
    wdlOptIn: r[40] === 1,
    wdlActive: r[40] === 1 && r[33] === 0,
  }),
  dongleState: (r) => ({ headsetLinked: r[3] === 1 }),
  /** GET_EQ_SETTINGS data: returns {slot, rateMask, empty, bands} */
  eqData: (r) => {
    const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
    const bands = [];
    for (let i = 0; i < 5; i++) {
      const o = 3 + 12 * i;
      if (o + 12 > r.length) break;
      if (r[o] === 0) continue;
      const freq = r[o + 2] | (r[o + 3] << 8);
      if (freq > 20000) continue; // flat-slot placeholder (22000 Hz)
      bands.push({ type: r[o + 1], freq, gain: dv.getFloat32(o + 4, true), q: dv.getFloat32(o + 8, true) });
    }
    return { slot: r[2] >> 4, rateMask: r[2] & 15, empty: r[3] === 0, bands };
  },
  eqMeta: (r) => {
    const len = r[3];
    return len ? new TextDecoder().decode(r.slice(4, 4 + len)) : '';
  },
  sidetone: (r) => ({ on: r[3] === 1, raw: r[4], pct: sidetonePercent(r[4]) }),
};

/**
 * Sidetone ±10 % step. The headset's usable raw levels are 0 (off) and 55..100 (10..100 %, 5 units per 10 %),
 * so going up from 0 jumps to 55 and going down from 55 drops to 0 (same as Adjust Pro).
 * Returns {target, packets}; target 0 should be reached with repeated VolDown 50 (see sidetoneToZero).
 */
export function sidetoneStepPlan(raw, dir) {
  const target = dir > 0 ? (raw < 55 ? 55 : Math.min(100, raw + 5)) : raw <= 55 ? 0 : raw - 5;
  const packets = [];
  if (target !== 0) {
    let diff = target - raw;
    while (diff !== 0) {
      const n = Math.min(50, Math.abs(diff));
      packets.push(cmd.sidetone(diff > 0 ? SIDETONE.VOL_UP : SIDETONE.VOL_DOWN, n));
      diff -= Math.sign(diff) * n;
    }
  }
  return { target, packets };
}

/**
 * Packets to move sidetone from `raw` to `pct` percent (10..100; 0 is handled by sidetoneToZero).
 * Levels: 10 % = raw 55 … 100 % = raw 100 (5 units per 10 %). Volume steps are relative, ≤ 50 per packet.
 */
export function sidetonePlanTo(raw, pct) {
  const target = pct <= 0 ? 0 : Math.min(100, 50 + Math.round(pct / 10) * 5);
  const packets = [];
  if (target !== 0) {
    let diff = target - raw;
    while (diff !== 0) {
      const n = Math.min(50, Math.abs(diff));
      packets.push(cmd.sidetone(diff > 0 ? SIDETONE.VOL_UP : SIDETONE.VOL_DOWN, n));
      diff -= Math.sign(diff) * n;
    }
  }
  return { target, packets };
}

/** Raw sidetone volume -> percent. Table from Adjust Pro: 0 -> 0 %, 55..100 -> 10..100 %. */
export function sidetonePercent(raw) {
  if (raw === 0) return 0;
  if (raw >= 55 && raw <= 100) return Math.round((raw - 50) * 2);
  return null; // value Adjust Pro wouldn't display
}

// ---------------------------------------------------------------------------
// EQ slot write (SET_EQ_SETTINGS -> SET_EQ_COEF x N -> COMMIT_EQ)
// ---------------------------------------------------------------------------
const f32 = (x) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, x, true);
  return b;
};

// Adjust Pro's hard-coded identity coefficients for a flat slot (b = [1, a1, a2], a = [a1, a2]).
const FLAT_A = [
  [-1.8620659642666344, 0.8668224138200578],
  [-1.8732044159841226, 0.8772236960156046],
  [-1.935598177861599, 0.9366350765352853],
];

/**
 * Build every packet needed to write `bands` into `slot` (1..3).
 * mode: 2 = save to flash, 1 = live preview (not saved).
 * name: stored on the device as the slot's preset id (≤ 36 bytes UTF-8).
 */
export function buildEqWrite(slot, bands, { mode = 2, name = 'Local' } = {}) {
  if (!(slot >= 1 && slot <= 3)) throw new Error('slot must be 1..3');
  if (bands.length > 5) throw new Error('max 5 bands');
  const nameBytes = new TextEncoder().encode(name).slice(0, 36);

  // 1. SET_EQ_SETTINGS (63 bytes)
  const s = [0xa7, 0x01, (slot << 4) | 0x07];
  const point = (enabled, type, freq, gain, q) => [enabled, type, freq & 0xff, (freq >> 8) & 0xff, ...f32(gain), ...f32(q)];
  bands.forEach((b) => s.push(...point(1, b.type, Math.round(b.freq), b.gain, b.q)));
  let used = bands.length;
  if (used === 0) {
    s.push(...point(1, 0, 22000, 0, 0.5));
    used = 1;
  }
  for (let i = used; i < 5; i++) s.push(...point(0, 0, 32, 0, 0.5));
  const packets = [new Uint8Array(s)];

  // 2. SET_EQ_COEF
  if (bands.length === 0) {
    RATES.forEach((r, t) => {
      const [a1, a2] = FLAT_A[t];
      packets.push(new Uint8Array([0xa7, 0x02, slot, r.code, 0, ...f32(1), ...f32(a1), ...f32(a2), ...f32(a1), ...f32(a2)]));
    });
  } else {
    bands.forEach((b, idx) => {
      for (const r of RATES) {
        const c = coefficients(b.type, b.freq, b.gain, b.q, r.hz);
        packets.push(new Uint8Array([0xa7, 0x02, slot, r.code, idx, ...f32(c.b[0]), ...f32(c.b[1]), ...f32(c.b[2]), ...f32(c.a[0]), ...f32(c.a[1])]));
      }
    });
  }

  // 3. COMMIT_EQ
  packets.push(new Uint8Array([0xa7, 0x03, slot, mode, ...f32(0), nameBytes.length, ...nameBytes]));
  return packets;
}
