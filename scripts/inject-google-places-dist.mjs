/**
 * CI / local: inject GOOGLE_PLACES_API_KEY into dist/index.html after `npm run dist`.
 * Usage: GOOGLE_PLACES_API_KEY=... node scripts/inject-google-places-dist.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectGooglePlacesMetaContent } from './places-env-inject.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, 'dist', 'index.html');
const key = (process.env.GOOGLE_PLACES_API_KEY || '').trim();
if (!key) {
  console.log('GOOGLE_PLACES_API_KEY not set; skipping inject (meta in dist stays empty).');
  process.exit(0);
}
const html = readFileSync(path, 'utf8');
const next = injectGooglePlacesMetaContent(html, key);
if (next === html) {
  console.error('Could not find <meta name="google-places-api-key" ...> in dist/index.html');
  process.exit(1);
}
writeFileSync(path, next, 'utf8');
console.log('Injected GOOGLE_PLACES_API_KEY into dist/index.html');
