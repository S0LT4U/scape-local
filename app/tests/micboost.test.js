import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoostFile, buildBoostFileFor, parseBoostFile, MIC_MAX_DB } from '../lib/apo.mjs';

const SPK = { guid: '{1BFF3E25-F65A-4322-AE0C-F8E396CFD9E8}', name: 'Headset Earphone', iface: 'Fractal Scape Dongle' };
const MIC = { guid: '{9E5BC244-9D79-498A-9938-07C937812CBF}', name: 'Headset Microphone', iface: 'Fractal Scape Dongle' };
const EPS = { render: [SPK], capture: [MIC] };

test('mic-only boost file is scoped to the Scape microphone', () => {
  const f = buildBoostFileFor({ speakers: 0, mic: 6 }, EPS);
  assert.match(f, /^Device: Fractal Scape Dongle Headset Microphone \{9e5bc244-9d79-498a-9938-07c937812cbf\}\r$/m);
  assert.doesNotMatch(f, /Earphone/);
  assert.equal((f.match(/^Preamp:/gm) || []).length, 1);
  assert.deepEqual(parseBoostFile(f), { speakers: 0, mic: 6 });
});

test('speakers + mic: each section has its own device and level', () => {
  const f = buildBoostFileFor({ speakers: 9, mic: 4 }, EPS);
  const lines = f.split('\r\n');
  const spkDev = lines.findIndex((l) => l.includes('Headset Earphone {'));
  const micDev = lines.findIndex((l) => l.includes('Headset Microphone {'));
  assert.ok(spkDev >= 0 && micDev > spkDev);
  assert.ok(lines.slice(spkDev, micDev).includes('Preamp: 9 dB'));
  assert.ok(lines.slice(micDev).includes('Preamp: 4 dB'));
  assert.deepEqual(parseBoostFile(f), { speakers: 9, mic: 4 });
});

test('speaker-only file from the new builder parses as speakers only', () => {
  assert.deepEqual(parseBoostFile(buildBoostFileFor({ speakers: 14 }, EPS)), { speakers: 14, mic: 0 });
});

test('0.2.x boost files (no section tags) are read as speaker Boost', () => {
  assert.deepEqual(parseBoostFile(buildBoostFile(3, [SPK])), { speakers: 3, mic: 0 });
  assert.deepEqual(parseBoostFile(null), { speakers: 0, mic: 0 });
});

test('mic boost validation', () => {
  assert.equal(MIC_MAX_DB, 12);
  assert.throws(() => buildBoostFileFor({ mic: 13 }, EPS));
  assert.throws(() => buildBoostFileFor({ mic: -1 }, EPS));
  assert.throws(() => buildBoostFileFor({ mic: 6 }, { render: [SPK], capture: [] }), /microphone/);
  assert.throws(() => buildBoostFileFor({ speakers: 0, mic: 0 }, EPS));
});
