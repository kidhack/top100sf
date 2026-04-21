/**
 * Load repo-root `.env` into `process.env` (does not override existing vars).
 * Shared by dev server, dist build, and deploy inject.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function applyDotEnvFromRoot(rootDir) {
  const envPath = join(rootDir, '.env');
  if (!existsSync(envPath)) return;
  let text = readFileSync(envPath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const line of text.split(/\r?\n/)) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.toLowerCase().startsWith('export ')) trimmed = trimmed.slice(7).trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"'))
      || (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Put the Places browser key into index.html. Supports common meta attribute orders.
 */
export function injectGooglePlacesMetaContent(html, keyOverride) {
  const key = String(keyOverride ?? process.env.GOOGLE_PLACES_API_KEY ?? '').trim();
  if (!key) return html;
  const v = escAttr(key);
  const replacement = `<meta name="google-places-api-key" content="${v}">`;
  const patterns = [
    /<meta\s+name=["']google-places-api-key["']\s+content=["'][^"']*["']\s*\/?>/i,
    /<meta\s+content=["'][^"']*["']\s+name=["']google-places-api-key["']\s*\/?>/i,
  ];
  for (const re of patterns) {
    if (re.test(html)) return html.replace(re, replacement);
  }
  return html;
}
