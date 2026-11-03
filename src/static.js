import { brotliCompressSync, gzipSync, constants as zlib } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest']);

function compress(buf, ext) {
  if (!COMPRESSIBLE.has(ext) || buf.length < 512) return { raw: buf };
  return {
    raw: buf,
    br: brotliCompressSync(buf, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: buf.length } }),
    gzip: gzipSync(buf, { level: 9 }),
  };
}

const hashOf = (buf) => createHash('sha256').update(buf).digest('base64url').slice(0, 12);

/**
 * Serves /public from memory: precompressed (brotli, gzip), ETags, and content-hashed
 * asset URLs cached for a year. index.html gets the hashed URLs and the app config inlined,
 * so the first paint needs no extra round trip. Files are reloaded if they change on disk.
 */
export function createStatic(dir, { getConfig }) {
  let files = new Map();
  let signature = '';
  let pageCache = { key: '', entry: null };

  function scan() {
    const names = readdirSync(dir).filter((n) => !n.startsWith('.'));
    return names.map((n) => `${n}:${statSync(join(dir, n)).mtimeMs}`).join('|');
  }

  function load() {
    const sig = scan();
    if (sig === signature) return;
    signature = sig;
    const next = new Map();
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'index.html') continue;
      const buf = readFileSync(join(dir, name));
      const ext = extname(name);
      next.set(`/${name}`, { type: MIME[ext] || 'application/octet-stream', hash: hashOf(buf), ...compress(buf, ext) });
    }
    let html = readFileSync(join(dir, 'index.html'), 'utf8');
    for (const [path, f] of next) html = html.split(`"${path}"`).join(`"${path}?v=${f.hash}"`);
    next.set('/index.html', { template: html });
    files = next;
    pageCache = { key: '', entry: null };
  }

  function page() {
    const json = JSON.stringify(getConfig()).replace(/</g, '\\u003c');
    const key = signature + json;
    if (pageCache.key !== key) {
      const html = files.get('/index.html').template.replace('<!--CONFIG-->', `<script>window.__VERDICT_CONFIG__=${json}</script>`);
      const buf = Buffer.from(html);
      pageCache = { key, entry: { type: MIME['.html'], hash: hashOf(buf), ...compress(buf, '.html') } };
    }
    return pageCache.entry;
  }

  load();

  /** Returns true if it handled the request. */
  return function serve(req, res, pathname, { fallbackToIndex }) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    try {
      load();
    } catch {
      /* keep serving the last good copy */
    }
    let entry;
    let immutable = false;
    if (pathname === '/' || pathname === '/index.html') entry = page();
    else if (files.has(pathname)) {
      entry = files.get(pathname);
      immutable = new URL(req.url, 'http://x').searchParams.get('v') === entry.hash;
    } else if (fallbackToIndex) entry = page();
    else return false;

    const etag = `"${entry.hash}"`;
    const headers = {
      'Content-Type': entry.type,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: etag,
      Vary: 'Accept-Encoding',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const accept = String(req.headers['accept-encoding'] || '');
    let body = entry.raw;
    if (entry.br && /\bbr\b/.test(accept)) {
      body = entry.br;
      headers['Content-Encoding'] = 'br';
    } else if (entry.gzip && /\bgzip\b/.test(accept)) {
      body = entry.gzip;
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
