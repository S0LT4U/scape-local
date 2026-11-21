import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEqCode, encodeEqCode, validateBands } from '../renderer/js/eqcode.js';
import { responseDb } from '../renderer/js/biquad.js';
import { applyHeadsetBoost, stripHeadsetBoost, isBoostOf, headsetBoostBlocker } from '../renderer/js/boost.js';
import { buildEqWrite, parse } from '../renderer/js/protocol.js';
import { LEVELS, dbToPercent, buildBoostFile, addBlock, removeBlock, hasBlock, findConflicts, deviceSelector } from '../lib/apo.mjs';

const CODES = {
  Everyday: 'AQMBAACAvzMzMz9kAAAAAAAAAAAAwAAAAECsDQAAAAAAAAAAwAAAQEBwFwAAAADS',
  Competitive: 'AQUBAACAwDMzMz94AAAAAAAAAAAAQAAAwD/QBwAAAAAAAAAAwAAAgD/6AAAAAAAAAAAAQAAAAECgDwAAAAAAAAAAwAAAQEBYGwAAAADw',
  Immersive: 'AQMBAAAAQDMzMz88AAAAAAAAAACAPwAAgD/cBQAAAAAAAAAAwAAAAECgDwAAAACF',
};

// ---- headset EQ boost: on -> encode -> decode -> off == original --------------
for (const name of ['Everyday', 'Immersive']) {
  for (const db of [3, 6, 9, 12]) {
    test(`headset boost +${db} on/off round-trips ${name} exactly`, () => {
      const original = decodeEqCode(CODES[name]);
      const boosted = applyHeadsetBoost(original, db);
      assert.deepEqual(validateBands(boosted), []);
      const viaCode = decodeEqCode(encodeEqCode(boosted)); // as stored / shared
      assert.ok(isBoostOf(viaCode, original));
      assert.equal(encodeEqCode(stripHeadsetBoost(viaCode)), CODES[name]);
      // and through the device packet format (SET_EQ_SETTINGS -> GET_EQ_SETTINGS parser)
      const dev = parse.eqData(buildEqWrite(1, viaCode)[0]).bands;
      assert.equal(encodeEqCode(stripHeadsetBoost(dev)), CODES[name]);
    });
  }
}

test('headset boost raises the response by the boost amount above 100 Hz', () => {
  const original = decodeEqCode(CODES.Everyday);
  const F = [100, 500, 1000, 5000, 10000, 16000];
  const a = responseDb(original, F), b = responseDb(applyHeadsetBoost(original, 6), F);
  F.forEach((_, i) => assert.ok(Math.abs(b[i] - a[i] - 6) < 0.05, `at ${F[i]} Hz`));
});

test('headset boost is refused for 5-band presets and above +12 dB', () => {
  const comp = decodeEqCode(CODES.Competitive);
  assert.match(headsetBoostBlocker(comp), /all 5 bands/);
  assert.throws(() => applyHeadsetBoost(comp, 6), /all 5 bands/);
  assert.throws(() => applyHeadsetBoost(decodeEqCode(CODES.Everyday), 14));
  assert.throws(() => applyHeadsetBoost(applyHeadsetBoost(decodeEqCode(CODES.Everyday), 3), 3), /already/);
});

// ---- PC (Equalizer APO) boost ---------------------------------------------------
const EP = { guid: '{1BFF3E25-F65A-4322-AE0C-F8E396CFD9E8}', name: 'Headset Earphone', iface: 'Fractal Scape Dongle' };

test('renderer and APO level tables match', async () => {
  const r = await import('../renderer/js/boost.js');
  assert.deepEqual(r.LEVELS, LEVELS);
});

test('level table', () => {
  assert.deepEqual(LEVELS.map((l) => [l.db, l.percent]), [[3, 141], [6, 200], [9, 282], [12, 398], [14, 501]]);
  assert.equal(dbToPercent(0), 100);
});

test('boost file is scoped to the Scape endpoint', () => {
  const f = buildBoostFile(6, [EP]);
  assert.match(f, /^Device: Fractal Scape Dongle Headset Earphone \{1bff3e25-f65a-4322-ae0c-f8e396cfd9e8\}\r$/m);
  assert.match(f, /^Preamp: 6 dB\r$/m);
  assert.equal(deviceSelector(EP), 'Fractal Scape Dongle Headset Earphone {1bff3e25-f65a-4322-ae0c-f8e396cfd9e8}');
  assert.throws(() => buildBoostFile(15, [EP]));
  assert.throws(() => buildBoostFile(6, []));
});

for (const [label, original] of [
  ['current config.txt (no trailing newline)', 'Include: peace.txt'],
  ['CRLF with trailing newline', 'Include: peace.txt\r\nPreamp: -3 dB\r\n'],
  ['LF file', 'Device: all\nPreamp: 0 dB\n'],
  ['empty file', ''],
]) {
  test(`APO on/off restores config.txt byte for byte: ${label}`, () => {
    const on = addBlock(original);
    assert.ok(hasBlock(on));
    assert.equal(addBlock(on), on, 'idempotent');
    assert.equal(removeBlock(on, original), original);
    // Without the saved original only a trailing newline may differ (it can't know whether it added it).
    assert.equal(removeBlock(on).replace(/\r?\n$/, ''), original.replace(/\r?\n$/, ''), 'fallback without saved original');
  });
}

test('APO off keeps edits someone else made meanwhile', () => {
  const original = 'Include: peace.txt';
  const edited = addBlock(original).replace('Include: peace.txt', 'Include: peace.txt\r\nPreamp: -2 dB');
  const off = removeBlock(edited, original);
  assert.ok(!hasBlock(off));
  assert.match(off, /Preamp: -2 dB/);
});

test('detects the leftover Peace preset that applies to all devices', () => {
  const files = {
    'config.txt': 'Include: peace.txt',
    'peace.txt': 'Device: all\r\nChannel: all\r\nPreamp: 15 dB\r\nFilter 1: ON PK Fc 10 Hz Gain 2 dB Q 1.41\r\n',
  };
  const issues = findConflicts(files);
  assert.ok(issues.some((i) => /Preamp: 15 dB/.test(i)));
  assert.deepEqual(findConflicts({ 'config.txt': 'Include: peace.txt', 'peace.txt': 'Device: Speakers\r\nPreamp: 15 dB' }), []);
});
