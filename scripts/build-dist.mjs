import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDotEnvFromRoot, injectGooglePlacesMetaContent } from './places-env-inject.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

applyDotEnvFromRoot(root);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(join(dist, 'data'), { recursive: true });

const files = [
  'index.html',
  'styles.css',
  'app.js',
  'data/restaurants.js',
  'og-top-logo.png',
  '.htaccess',
];

for (const rel of files) {
  await copyFile(join(root, rel), join(dist, rel));
}

try {
  const localCfg = join(root, 'config.local.js');
  await access(localCfg);
  await copyFile(localCfg, join(dist, 'config.local.js'));
  console.log('Copied config.local.js → dist/');
} catch {
  /* optional; file is gitignored */
}

const distIndex = join(dist, 'index.html');
let idxHtml = await readFile(distIndex, 'utf8');
const injected = injectGooglePlacesMetaContent(idxHtml);
if (injected !== idxHtml) {
  await writeFile(distIndex, injected, 'utf8');
  console.log('Injected GOOGLE_PLACES_API_KEY from env/.env into dist/index.html');
}

console.log('Wrote dist/:');
for (const rel of files) console.log('  ' + rel);
