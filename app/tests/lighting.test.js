import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  THEMES, MODE, PATTERNS, renderEffect, buildPackage, buildEffectUpload, checksum, parseEffectMeta,
  readEffectMeta, mix, normalizeEffect, CUSTOM_PRESET_ID,
} from '../renderer/js/lighting.js';
import { checkPacket, parse, BlockedCommandError } from '../renderer/js/protocol.js';

// Deterministic stand-in for Math.random (Lava lamp is random by design).
const prng = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const sha = (b) => createHash('sha256').update(b).digest('hex');

// Package hashes for every Fractal theme. These were cross-checked byte for byte against Adjust Pro's own
// effect renderers (run locally, not published), so a change here means the headset would look different.
const GOLDEN = {
  'Northern lights': [5016, '87e6a76e3dfaec77f3d98cc40ee4f24f251b49d064a6508851fc5b3f5f61c99e'],
  'Summer sky': [5880, '9bea366e0bf5781ccdc48cf357cd8aa8a06accc7f823a9236feb22d2b30bc364'],
  Sunset: [2856, 'd9f339a4de953d63b087a90865303f43af7f0a30b86336c4dae77a4705f2c720'],
  Starfall: [7248, '1faa462a727f17b9b499df16e4e27d3f81b16f697e55261cae29c97576bad46a'],
  'Glistening ice': [6564, '4670f239d479ce1843a5001002bd7ffc66ce33f7b1b4c05b8360e4145c178310'],
  'Pink sapphire': [2928, 'f4f3c0eb01c9c67c673694e3a314842529475409707c9d0b76fbb2715792e655'],
  'Lunar mist': [2928, '509993b8ee64d5463147988a1f77094ec2329a9e03dc7ffa737fc6a5c1012879'],
  'Mystic night': [3720, '07ef649993f09c939a5b44de919a557a52a920e097d33741ed34a5eb9bfb285a'],
  Campfire: [4044, 'f408b98bb274cae9388f1653e9a7545dafb730e043f71c517349bae6efca9fca'],
  'Radiant dawn': [5016, 'a7c4c16e9b807a6179955e197bb6449df09d3a4f2727aae81cdb6d15beaf405c'],
};

test('there are 10 Fractal themes, all with golden vectors', () => {
  assert.equal(THEMES.length, 10);
  assert.deepEqual(THEMES.map((t) => t.name).sort(), Object.keys(GOLDEN).sort());
});

for (const t of THEMES) {
  test(`theme ${t.name} renders byte-identical to Adjust Pro`, () => {
    const pkg = buildPackage(renderEffect({ ...t, presetId: t.id }, { random: prng(7) }));
    assert.deepEqual([pkg.length, sha(pkg)], GOLDEN[t.name]);
    assert.deepEqual([...pkg.slice(0, 2)], [0xa5, 0x5a]);
    assert.equal(pkg[3], 0xff);
    assert.equal(pkg[4], 20); // fps
    assert.equal(pkg[6], t.id); // preset id is the first metadata byte
    assert.equal((pkg.length - 48) / 36, pkg[2]); // frame count
  });
}

test('upload packets: SET -> SEND x N -> COMMIT -> SELECT, all pass the allowlist', () => {
  const { packets, package: pkg } = buildEffectUpload({ ...THEMES[0], presetId: 0 });
  const [set, ...rest] = packets;
  assert.deepEqual([...set], [0xa4, 0x01, 0x01, checksum(pkg), pkg.length & 255, pkg.length >> 8]);
  const sends = rest.slice(0, -2);
  assert.equal(sends.length, Math.ceil(pkg.length / 60));
  const joined = [];
  for (const p of sends) {
    assert.equal(p.length, 63);
    assert.deepEqual([p[0], p[1]], [0xa4, 0x02]);
    joined.push(...p.slice(3, 3 + p[2]));
  }
  assert.deepEqual(new Uint8Array(joined), pkg);
  assert.deepEqual([...rest.at(-2)], [0xa4, 0x03]);
  assert.deepEqual([...rest.at(-1)], [0xa4, 0x04, 0x01]);
  for (const p of packets) checkPacket(p);
});

test('every pattern and speed extreme produces a valid upload', () => {
  for (const p of PATTERNS) {
    const colors = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#00FFFF', '#FF00FF'].slice(0, p.colors);
    for (const speed of [1, 50, 100])
      for (const brightness of [0, 100]) {
        const { packets } = buildEffectUpload({ mode: p.mode, colors, speed, brightness }, { random: prng(1) });
        for (const pk of packets) checkPacket(pk);
      }
  }
});

test('allowlist blocks dangerous effect packets', () => {
  const blocked = [
    [0xa4, 0x01, 0x01, 0x00, 0x00, 0x00], // length 0 = clear slot
    [0xa4, 0x01, 0x00, 0x00, 0x00, 0x10], // boot-effect slot 0
    [0xa4, 0x01, 0x02, 0x00, 0x00, 0x10], // other slot
    [0xa4, 0x01, 0x01, 0x00, 0xff, 0xff], // too long
    [0xa4, 0x03, 0x01], // commit with args
    [0xa4, 0x05, 0x00, 0x00, 0x00], // read other slot
    [0xa4, 0x11, 0, 0, 0, 0], // timestamp effect (hub)
    [0xa4, 0x13], // timestamp commit
    [0xa4, 0x78], // stop loading
    [0xf1, 0x15, 0x01], // Windows Dynamic Lighting switch (headset re-enumerates; not supported)
    [0xa5, 0x01, 0, 0], // RGB streaming
  ];
  for (const b of blocked) assert.throws(() => checkPacket(new Uint8Array(b)), BlockedCommandError, b.join(' '));
  const shortSend = new Uint8Array(20);
  shortSend.set([0xa4, 0x02, 10]);
  assert.throws(() => checkPacket(shortSend), BlockedCommandError);
  checkPacket(readEffectMeta());
});

test('metadata round trip through a READ_EFFECT reply', () => {
  const cases = [
    { ...THEMES.find((t) => t.name === 'Starfall'), presetId: 13 },
    { mode: MODE.TWO_COLOR_FADE, colors: ['#112233', '#445566'], speed: 42, brightness: 80 },
    { mode: MODE.STILL, colors: ['#ABCDEF'], speed: 100, brightness: 25 },
  ];
  for (const spec of cases) {
    const pkg = buildPackage(renderEffect(spec));
    const reply = new Uint8Array(64);
    reply.set([0xa4, 0x05, 0x00, 0x00]);
    reply.set(pkg.slice(0, 60), 4);
    const m = parseEffectMeta(reply);
    const n = normalizeEffect(spec);
    assert.equal(m.mode, n.mode);
    assert.equal(m.speed, n.speed);
    assert.equal(m.brightness, n.brightness);
    assert.equal(m.presetId, spec.presetId ?? CUSTOM_PRESET_ID);
    assert.deepEqual(m.colors, spec.colors.map((c) => c.toUpperCase()));
    if (spec.wave) assert.deepEqual(m.wave, spec.wave);
  }
  assert.equal(parseEffectMeta(new Uint8Array(64)), null);
});

test('validation rejects bad specs', () => {
  assert.throws(() => normalizeEffect({ mode: MODE.SHIFT, colors: ['#000000'], speed: 50 }));
  assert.throws(() => normalizeEffect({ mode: MODE.STILL, colors: ['red'], speed: 50 }));
  assert.throws(() => normalizeEffect({ mode: MODE.BREATHE, colors: ['#000000', '#FFFFFF'], speed: 0 }));
  assert.throws(() => normalizeEffect({ mode: MODE.BREATHE, colors: ['#000000', '#FFFFFF'], speed: 50, brightness: 101 }));
  assert.throws(() => normalizeEffect({ mode: 3, colors: ['#000000'], speed: 50 })); // Meshify: not a headset pattern
});

test('mix matches tinycolor semantics', () => {
  assert.deepEqual(mix([0, 0, 0], [255, 255, 255], 50), [128, 128, 128]);
  assert.deepEqual(mix([10, 20, 30], [200, 100, 0], 0), [10, 20, 30]);
  assert.deepEqual(mix([10, 20, 30], [200, 100, 0], 100), [200, 100, 0]);
});

test('device state exposes Windows Dynamic Lighting status (read-only)', () => {
  const r = new Uint8Array(64);
  r.set([0xf1, 0x21, 0x00]);
  r[40] = 1;
  assert.equal(parse.deviceState(r).wdlOptIn, true);
  assert.equal(parse.deviceState(r).wdlActive, true);
  r[33] = 1;
  assert.equal(parse.deviceState(r).wdlActive, false);
});
