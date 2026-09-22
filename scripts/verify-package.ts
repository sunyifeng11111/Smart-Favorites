import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  expectedChromeZipName,
  verifyProductionManifest,
} from '../src/release/artifacts';

interface PackageMetadata {
  name: string;
  version: string;
}

const root = resolve(import.meta.dirname, '..');
const metadata = JSON.parse(
  await readFile(resolve(root, 'package.json'), 'utf8'),
) as PackageMetadata;
const unpackedPath = resolve(root, '.output/chrome-mv3');
const zipPath = resolve(
  root,
  '.output',
  expectedChromeZipName(metadata.name, metadata.version),
);

const unpackedManifest = JSON.parse(
  await readFile(resolve(unpackedPath, 'manifest.json'), 'utf8'),
) as unknown;
verifyProductionManifest(unpackedManifest);

const zipStats = await stat(zipPath);
if (!zipStats.isFile() || zipStats.size === 0) {
  throw new Error(`Versioned Chrome package is missing or empty: ${zipPath}`);
}

const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
for (const required of ['manifest.json', 'background.js', 'popup.html', 'options.html']) {
  if (!entries.includes(required)) throw new Error(`Chrome package is missing ${required}`);
}
const packagedManifest = JSON.parse(
  execFileSync('unzip', ['-p', zipPath, 'manifest.json'], { encoding: 'utf8' }),
) as unknown;
verifyProductionManifest(packagedManifest);

process.stdout.write(`${JSON.stringify({
  unpackedPath,
  zipPath,
  version: metadata.version,
  verifiedEntries: ['manifest.json', 'background.js', 'popup.html', 'options.html'],
}, null, 2)}\n`);
