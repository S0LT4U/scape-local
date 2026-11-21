// Generates the app's headphone icon as PNGs (no external tools needed).
// Usage: node tools/make-icon.mjs  ->  app/assets/tray.png (32px), icon.png (256px)
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'assets');
mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shape in unit coordinates (0..1): a headband arc and two ear cups.
function inside(x, y) {
  const cx = 0.5, cy = 0.52, r = 0.34, t = 0.075;
  const d = Math.hypot(x - cx, y - cy);
  const band = y <= cy + 0.02 && d >= r - t / 2 && d <= r + t / 2;
  const cup = (px) => {
    const dx = (x - px) / 0.1, dy = (y - 0.66) / 0.17;
    return dx * dx + dy * dy <= 1;
  };
  return band || cup(cx - r) || cup(cx + r);
}

function render(size, color) {
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let i = 0; i < ss; i++)
        for (let j = 0; j < ss; j++) if (inside((x + (i + 0.5) / ss) / size, (y + (j + 0.5) / ss) / size)) hits++;
      const o = (y * size + x) * 4;
      buf[o] = color[0]; buf[o + 1] = color[1]; buf[o + 2] = color[2];
      buf[o + 3] = Math.round((255 * hits) / (ss * ss));
    }
  return png(size, buf);
}

writeFileSync(join(out, 'tray.png'), render(32, [235, 235, 235]));
writeFileSync(join(out, 'icon.png'), render(256, [94, 234, 212]));
console.log('wrote', out);
