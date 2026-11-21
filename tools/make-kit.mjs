// Assemble the self-contained release kit after `electron-builder` ran:
//   dist/Scape-Local-Kit-<version>/
//     Scape-Local-Setup-<version>.exe     app installer (bundles Equalizer APO 1.4.2)
//     EqualizerAPO-x64-1.4.2.exe          standalone copy
//     EqualizerAPO-src-1.4.2.zip          GPL source for the bundled APO
//     scape-adjust-source.zip             full repo (app source, tests, Adjust Pro archive, docs)
//     INSTALL.md, SHA256SUMS.txt
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'app', 'package.json'), 'utf8'));
const kit = join(root, 'dist', `Scape-Local-Kit-${version}`);
const vendor = join(root, 'vendor', 'equalizer-apo-1.4.2');
const setup = join(root, 'dist', `build-${version}`, `Scape-Local-Setup-${version}.exe`);

if (!existsSync(setup)) throw new Error(`Missing ${setup}; run electron-builder first`);
rmSync(kit, { recursive: true, force: true });
mkdirSync(kit, { recursive: true });

copyFileSync(setup, join(kit, `Scape-Local-Setup-${version}.exe`));
for (const f of ['EqualizerAPO-x64-1.4.2.exe', 'EqualizerAPO-src-1.4.2.zip', 'SOURCE.md']) copyFileSync(join(vendor, f), join(kit, f === 'SOURCE.md' ? 'EqualizerAPO-SOURCE.md' : f));
copyFileSync(join(root, 'INSTALL.md'), join(kit, 'INSTALL.md'));
// Committed state of the repo (needs a clean or committed tree to be complete).
execFileSync('git', ['-C', root, 'archive', '--format=zip', '-o', join(kit, 'scape-adjust-source.zip'), 'HEAD']);

const sums = ['Scape-Local-Setup-' + version + '.exe', 'EqualizerAPO-x64-1.4.2.exe', 'EqualizerAPO-src-1.4.2.zip', 'scape-adjust-source.zip']
  .map((f) => `${createHash('sha256').update(readFileSync(join(kit, f))).digest('hex')}  ${f}`);
writeFileSync(join(kit, 'SHA256SUMS.txt'), sums.join('\n') + '\n');

for (const s of sums) {
  const f = s.split('  ')[1];
  console.log(`${(statSync(join(kit, f)).size / 1e6).toFixed(1).padStart(6)} MB  ${f}`);
}
console.log('kit:', kit);
