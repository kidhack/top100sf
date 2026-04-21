// Tiny static dev server with SPA fallback, mirroring the production
// .htaccess rewrite: real files pass through, everything else returns
// index.html so client-side routing (parseRoute) can handle it.
//
// Run with: npm run dev  (or: node scripts/dev-server.mjs [port])

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDotEnvFromRoot, injectGooglePlacesMetaContent } from './places-env-inject.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 8000);
const rootIndexPath = resolve(root, 'index.html');

applyDotEnvFromRoot(root);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
};

// Resolves a request path to a real file on disk, following directory ->
// index.html fallback. Returns the actual served path (not the requested
// path) so the caller can derive an accurate content-type.
async function resolveFile(absPath) {
  try {
    const s = await stat(absPath);
    if (s.isFile()) return absPath;
    if (s.isDirectory()) {
      const indexPath = join(absPath, 'index.html');
      const s2 = await stat(indexPath).catch(() => null);
      if (s2 && s2.isFile()) return indexPath;
    }
  } catch { /* fall through */ }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  // Strip leading slash and normalize, then rejoin to the root. `normalize`
  // collapses any `..` traversal attempts so requests can't escape the repo.
  const safePath = normalize(url.pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  const absPath = join(root, safePath);

  // Resolve to the actual file we'll serve so content-type reflects that
  // file's extension (not the URL's), otherwise `/` -> index.html would
  // inherit the directory's empty extension and Chrome forces a download.
  let filePath = await resolveFile(absPath);
  const looksLikeStaticAsset = /\.(js|mjs|css|json|png|jpe?g|gif|svg|ico|woff2?|map|txt)$/i.test(
    safePath,
  );
  if (!filePath && looksLikeStaticAsset) {
    res.writeHead(404, {
      'content-type': MIME[extname(safePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    // Valid empty JS so a missing optional script (e.g. config.local.js) does not break parsing.
    res.end(safePath.endsWith('.css') ? '/* not found */' : 'void 0;');
    console.log(`404 ${req.method} ${url.pathname}`);
    return;
  }
  if (!filePath) {
    // SPA fallback: serve index.html for any unknown path so the client
    // router can take over (matches production .htaccess behavior).
    filePath = await resolveFile(join(root, 'index.html'));
  }

  let status = 200;
  let body = null;
  let type = MIME['.html'];

  if (filePath) {
    if (resolve(filePath) === rootIndexPath) {
      const html = await readFile(filePath, 'utf8');
      body = Buffer.from(injectGooglePlacesMetaContent(html), 'utf8');
    } else {
      body = await readFile(filePath);
    }
    type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  } else {
    status = 500;
    body = Buffer.from('index.html missing at repo root');
    type = MIME['.txt'];
  }

  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  });
  res.end(body);
  console.log(`${status} ${req.method} ${url.pathname}`);
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    const next = Number(port) + 1;
    console.error(
      `Port ${port} is already in use.\n\n`
      + `Start on another port:\n  PORT=${next} npm run dev\n`
      + `  node scripts/dev-server.mjs ${next}\n\n`
      + `Or stop whatever is using ${port}:\n  lsof -iTCP:${port} -sTCP:LISTEN -n -P`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(port, () => {
  console.log(`Dev server ready: http://localhost:${port}/`);
  console.log('SPA fallback enabled (unknown paths -> index.html).');
  if ((process.env.GOOGLE_PLACES_API_KEY || '').trim()) {
    console.log('Local Places search: GOOGLE_PLACES_API_KEY is set (injected into index.html).');
  } else {
    console.log(
      'Local Places search: set GOOGLE_PLACES_API_KEY in the environment or in a repo-root .env file.',
    );
  }
});
