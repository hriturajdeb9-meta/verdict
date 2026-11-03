import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { extractText, parseHTML, querySelectorAll, textOf, walkElements } from './html.js';

const MAX_BYTES = 2 * 1024 * 1024;

function isPrivateAddress(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Validate a URL submitted by a user before the server fetches it (SSRF guard). */
export async function assertFetchable(rawUrl, { allowPrivateUrls }) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`"${rawUrl}" is not a valid URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs can be reviewed.');
  if (!allowPrivateUrls) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw new Error(`Could not resolve ${url.hostname}.`);
    if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('Private or local network addresses cannot be reviewed on this server.');
  }
  return url;
}

/** Resolve a criterion path against the deliverable URL, keeping any sub-path the site lives under. */
export function resolveAgainst(baseUrl, path = '/') {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const rel = String(path || '/').replace(/^\/+/, '');
  return new URL(rel, base).toString();
}

export async function safeFetch(url, { method = 'GET', timeoutMs = 12_000, allowPrivateUrls = true, headers = {} } = {}) {
  await assertFetchable(url, { allowPrivateUrls });
  const started = performance.now();
  const res = await fetch(url, {
    method,
    headers: { 'User-Agent': 'VerdictArbiter/1.0 (+acceptance review)', Accept: '*/*', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const reader = res.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  }
  const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  return {
    url: res.url || url,
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get('content-type') || '',
    elapsedMs: Math.round(performance.now() - started),
    body,
    truncated: size > MAX_BYTES,
  };
}

/** Everything a reviewer would look at on one page. */
export function snapshotPage(fetched) {
  const { root, comments } = parseHTML(fetched.body);
  const { visible, hidden } = extractText(root);
  const titleEl = querySelectorAll(root, 'title')[0];
  const headings = querySelectorAll(root, 'h1, h2, h3').map((h) => `${h.tag}: ${textOf(h)}`).slice(0, 40);
  const forms = querySelectorAll(root, 'form').map((f) => {
    const fields = [...walkElements(f)]
      .filter((e) => ['input', 'select', 'textarea', 'button'].includes(e.tag))
      .map((e) => `${e.tag}${e.attrs.type ? `[type=${e.attrs.type}]` : ''}${e.attrs.name ? `[name=${e.attrs.name}]` : ''}`);
    return { action: f.attrs.action || '', fields };
  });
  const links = querySelectorAll(root, 'a[href]')
    .map((a) => `${textOf(a).slice(0, 40)} -> ${a.attrs.href}`)
    .slice(0, 40);
  const images = querySelectorAll(root, 'img').map((i) => ({ src: i.attrs.src || '', alt: i.attrs.alt ?? null }));
  return {
    url: fetched.url,
    status: fetched.status,
    elapsedMs: fetched.elapsedMs,
    title: titleEl ? textOf(titleEl) : '',
    headings,
    forms,
    links,
    images: images.slice(0, 30),
    imagesMissingAlt: images.filter((i) => !i.alt).length,
    visibleText: visible.slice(0, 12_000),
    hiddenText: hidden.slice(0, 4_000),
    comments: comments.slice(0, 20).map((c) => c.slice(0, 500)),
    root,
  };
}

/** Pull a compact view of a public GitHub repository: file tree, license, README and a few source files. */
export async function collectRepoEvidence(repoUrl, { githubToken } = {}) {
  const m = String(repoUrl).match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/|$)/i);
  if (!m) return { error: 'Only public GitHub repositories are inspected automatically.' };
  const [, owner, repo] = m;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'VerdictArbiter' };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  const gh = async (path) => {
    const res = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
    return res.json();
  };
  try {
    const meta = await gh(`/repos/${owner}/${repo}`);
    const tree = await gh(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(meta.default_branch)}?recursive=1`);
    const files = (tree.tree || []).filter((t) => t.type === 'blob').map((t) => t.path);
    const pick = files
      .filter((f) => /^readme(\.\w+)?$/i.test(f) || /\.(js|ts|tsx|jsx|py|html|css|json|md)$/i.test(f))
      .filter((f) => !/node_modules|dist\/|build\/|package-lock|\.min\./i.test(f))
      .slice(0, 8);
    const contents = {};
    for (const f of pick) {
      const raw = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${meta.default_branch}/${f}`, { signal: AbortSignal.timeout(15_000) });
      if (raw.ok) contents[f] = (await raw.text()).slice(0, 6_000);
    }
    return {
      owner,
      repo,
      url: meta.html_url,
      isPublic: !meta.private,
      license: meta.license?.spdx_id || null,
      defaultBranch: meta.default_branch,
      files: files.slice(0, 400),
      contents,
    };
  } catch (err) {
    return { owner, repo, error: err.message };
  }
}
