import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEqCode, encodeEqCode, validateBands, tidy } from '../renderer/js/eqcode.js';
import { coefficients, magnitudeDb, responseDb } from '../renderer/js/biquad.js';
import { checkPacket, buildEqWrite, cmd, parse, hex, sidetonePercent, BlockedCommandError } from '../renderer/js/protocol.js';

const P = 0, LS = 1;
const VECTORS = {
  Everyday: {
    code: 'AQMBAACAvzMzMz9kAAAAAAAAAAAAwAAAAECsDQAAAAAAAAAAwAAAQEBwFwAAAADS',
    bands: [[LS, 100, -1, 0.7], [P, 3500, -2, 2], [P, 6000, -2, 3]],
  },
  Competitive: {
    code: 'AQUBAACAwDMzMz94AAAAAAAAAAAAQAAAwD/QBwAAAAAAAAAAwAAAgD/6AAAAAAAAAAAAQAAAAECgDwAAAAAAAAAAwAAAQEBYGwAAAADw',
    bands: [[LS, 120, -4, 0.7], [P, 2000, 2, 1.5], [P, 250, -2, 1], [P, 4000, 2, 2], [P, 7000, -2, 3]],
  },
  Immersive: {
    code: 'AQMBAAAAQDMzMz88AAAAAAAAAACAPwAAgD/cBQAAAAAAAAAAwAAAAECgDwAAAACF',
    bands: [[LS, 60, 2, 0.7], [P, 1500, 1, 1], [P, 4000, -2, 2]],
  },
};
const toBands = (arr) => arr.map(([type, freq, gain, q]) => ({ type, freq, gain, q }));

for (const [name, v] of Object.entries(VECTORS)) {
  test(`decode ${name}`, () => {
    const got = decodeEqCode(v.code).map((b) => ({ ...b, gain: tidy(b.gain), q: tidy(b.q) }));
    assert.deepEqual(got, toBands(v.bands));
  });
  test(`encode ${name} (from decoded f32 values) is byte-exact`, () => {
    assert.equal(encodeEqCode(decodeEqCode(v.code)), v.code);
  });
  test(`encode ${name} (from human values) is byte-exact`, () => {
    assert.equal(encodeEqCode(toBands(v.bands)), v.code);
  });
  test(`${name} passes validation`, () => {
    assert.deepEqual(validateBands(toBands(v.bands)), []);
  });
}

test('flat preset AQAB', () => {
  assert.deepEqual(decodeEqCode('AQAB'), []);
  assert.equal(encodeEqCode([]), 'AQAB');
});

test('corrupted checksum is rejected', () => {
  const bad = VECTORS.Everyday.code.slice(0, -2) + 'AA';
  assert.throws(() => decodeEqCode(bad), /Checksum|Length/);
});

test('validation catches out-of-range values', () => {
  const errs = validateBands([{ type: 0, freq: 10, gain: 20, q: 0.1 }, ...Array(5).fill({ type: 0, freq: 100, gain: 0, q: 1 })]);
  assert.ok(errs.some((e) => /Too many bands/.test(e)));
  assert.ok(errs.some((e) => /frequency/.test(e)));
  assert.ok(errs.some((e) => /gain/.test(e)));
  assert.ok(errs.some((e) => /Q/.test(e)));
});

// ---- biquad math -------------------------------------------------------
test('peaking filter hits its gain at the centre frequency', () => {
  for (const g of [-6, 3, 12]) {
    const c = coefficients(0, 1000, g, 1, 48000);
    assert.ok(Math.abs(magnitudeDb(c, 1000, 48000) - g) < 0.01, `gain ${g}`);
  }
});

test('0 dB peak is transparent', () => {
  const c = coefficients(0, 1000, 0, 1, 48000);
  for (const f of [20, 1000, 15000]) assert.ok(Math.abs(magnitudeDb(c, f, 48000)) < 1e-4);
});

test('high shelf (type 2) at 20 Hz raises the whole audible band evenly', () => {
  const r = responseDb([{ type: 2, freq: 20, gain: 6, q: 0.7 }], [100, 1000, 10000, 18000]);
  for (const v of r) assert.ok(Math.abs(v - 6) < 0.15, `got ${v}`);
});

test('low shelf boosts lows and leaves highs', () => {
  const c = coefficients(1, 100, 6, 0.7, 48000);
  assert.ok(Math.abs(magnitudeDb(c, 20, 48000) - 6) < 0.3);
  assert.ok(Math.abs(magnitudeDb(c, 10000, 48000)) < 0.05);
});

// ---- protocol ----------------------------------------------------------
test('allowlist blocks firmware, reboot, factory reset and unknown commands', () => {
  const blocked = [
    [0xb5, 0x01], [0xb5, 0x02], [0xb5, 0x03], [0xb5, 0x04],
    [0x15, 0x01], [0x15, 0x04],
    [0xf1, 0xf2], [0x11, 0xf2], [0xf1, 0x15], [0xa7, 0x06], [0xa5, 0xf0], [0xa4, 0x01], [0xa7, 0x12],
  ];
  for (const b of blocked) assert.throws(() => checkPacket(new Uint8Array(b)), BlockedCommandError, hex(b));
});

test('allowlist rejects out-of-range write arguments', () => {
  assert.throws(() => checkPacket(new Uint8Array([0xa7, 0x07, 4])), BlockedCommandError);
  assert.throws(() => checkPacket(new Uint8Array([0xa7, 0x03, 1, 3, 0, 0, 0, 0, 0])), BlockedCommandError); // erase
  assert.throws(() => checkPacket(new Uint8Array([0xf1, 0x34, 1, 1])), BlockedCommandError); // Enable probe
  assert.throws(() => checkPacket(new Uint8Array([0xf1, 0x34, 3, 51])), BlockedCommandError);
  assert.throws(() => checkPacket(new Uint8Array([0xf1, 0x36, 2])), BlockedCommandError);
});

test('default-profile packets are allowed and exact', () => {
  assert.equal(hex(cmd.lights(false)), 'A4 04 00');
  assert.equal(hex(cmd.sidetone(3, 50)), 'F1 34 03 32');
  assert.equal(hex(cmd.enc(false)), 'F1 36 00');
  for (const p of [cmd.lights(false), cmd.sidetone(3, 50), cmd.enc(false)]) assert.ok(checkPacket(p).write);
});

test('EQ write: packet layout for Everyday in slot 2', () => {
  const pk = buildEqWrite(2, decodeEqCode(VECTORS.Everyday.code), { name: 'Everyday' });
  assert.equal(pk.length, 1 + 3 * 3 + 1);
  const s = pk[0];
  assert.equal(s.length, 63);
  assert.equal(hex(s.slice(0, 3)), 'A7 01 27');
  assert.equal(hex(s.slice(3, 7)), '01 01 64 00'); // enabled, low shelf, 100 Hz
  assert.equal(hex(s.slice(39, 43)), '00 00 20 00'); // 4th point unused (32 Hz)
  for (const c of pk.slice(1, -1)) {
    assert.equal(c.length, 25);
    assert.equal(hex(c.slice(0, 3)), 'A7 02 02');
  }
  const commit = pk.at(-1);
  assert.equal(hex(commit.slice(0, 9)), 'A7 03 02 02 00 00 00 00 08');
  assert.equal(new TextDecoder().decode(commit.slice(9)), 'Everyday');
  for (const p of pk) checkPacket(p);
});

test('EQ write round-trips through the device read parser', () => {
  const bands = decodeEqCode(VECTORS.Competitive.code);
  const settings = buildEqWrite(1, bands)[0];
  const reply = new Uint8Array(63);
  reply.set(settings); // device echoes the same layout in GET_EQ_SETTINGS
  const parsed = parse.eqData(reply);
  assert.equal(parsed.slot, 1);
  assert.equal(encodeEqCode(parsed.bands), VECTORS.Competitive.code);
});

test('flat EQ write uses the 22 kHz placeholder and identity coefficients', () => {
  const pk = buildEqWrite(3, []);
  assert.equal(pk.length, 5);
  assert.equal(hex(pk[0].slice(3, 7)), '01 00 F0 55');
  assert.deepEqual(parse.eqData(pk[0]).bands, []);
});

test('device-state parser', () => {
  const r = new Uint8Array(63);
  r.set([0xf1, 0x21, 0x00, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 87, 1, 60, 0, 1, 0, 1]);
  const s = parse.deviceState(r);
  assert.equal(s.boomMic, true);
  assert.equal(s.muted, false);
  assert.equal(s.eqSlot, 2);
  assert.equal(s.lightsOn, false);
  assert.equal(s.battery, 87);
  assert.equal(s.sidetonePct, 20);
  assert.equal(s.encOn, false);
});

test('sidetone ±10% steps follow the headset levels (0, 55..100)', async () => {
  const { sidetoneStepPlan } = await import('../renderer/js/protocol.js');
  const s = (raw, dir) => { const p = sidetoneStepPlan(raw, dir); return [p.target, p.packets.map(hex)]; };
  assert.deepEqual(s(0, 1), [55, ['F1 34 02 32', 'F1 34 02 05']]); // 0 -> 10 %: 50 + 5 steps
  assert.deepEqual(s(55, 1), [60, ['F1 34 02 05']]);
  assert.deepEqual(s(100, 1), [100, []]);
  assert.deepEqual(s(60, -1), [55, ['F1 34 03 05']]);
  assert.deepEqual(s(55, -1), [0, []]); // 10 % -> off (done with VolDown 50 loop)
  assert.deepEqual(s(0, -1), [0, []]);
  for (const raw of [0, 55, 60, 95]) for (const p of sidetoneStepPlan(raw, 1).packets) checkPacket(p);
});

test('allowlist checks EQ coefficient and read arguments', () => {
  const coef = (slot, rate, point) => new Uint8Array([0xa7, 0x02, slot, rate, point, ...new Uint8Array(20)]);
  checkPacket(coef(1, 4, 4));
  assert.throws(() => checkPacket(coef(0, 1, 0)), BlockedCommandError);
  assert.throws(() => checkPacket(coef(1, 3, 0)), BlockedCommandError);
  assert.throws(() => checkPacket(coef(1, 1, 5)), BlockedCommandError);
  assert.throws(() => checkPacket(new Uint8Array([0xa7, 0x02, 1, 1, 0])), BlockedCommandError); // truncated
  checkPacket(cmd.eqData(5)); // factory-default fallback slot
  assert.throws(() => checkPacket(cmd.eqData(6)), BlockedCommandError);
  assert.throws(() => checkPacket(new Uint8Array([0xa7, 0x01, 0x17])), BlockedCommandError); // wrong length
});

test('sidetone percent table matches Adjust Pro', () => {
  assert.equal(sidetonePercent(0), 0);
  assert.equal(sidetonePercent(55), 10);
  assert.equal(sidetonePercent(100), 100);
  assert.equal(sidetonePercent(30), null);
});

test('sidetone slider plan: percent -> relative volume packets', async () => {
  const { sidetonePlanTo } = await import('../renderer/js/protocol.js');
  const h = (p) => p.packets.map((x) => hex(x));
  assert.deepEqual(h(sidetonePlanTo(0, 10)), ['F1 34 02 32', 'F1 34 02 05']); // 0 -> raw 55 (same as verified on hardware)
  assert.equal(sidetonePlanTo(0, 10).target, 55);
  assert.deepEqual(h(sidetonePlanTo(55, 100)), ['F1 34 02 2D']); // +45
  assert.deepEqual(h(sidetonePlanTo(100, 50)), ['F1 34 03 19']); // -25 -> raw 75
  assert.deepEqual(sidetonePlanTo(75, 50).packets, []);
  assert.equal(sidetonePlanTo(80, 0).target, 0); // 0 % goes through sidetoneToZero
  for (let pct = 10; pct <= 100; pct += 10) {
    const p = sidetonePlanTo(0, pct);
    assert.equal(sidetonePercent(p.target), pct);
    for (const pk of p.packets) checkPacket(pk);
  }
});
