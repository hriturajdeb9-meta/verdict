import { isSupportedSelector, outerHTMLSnippet, querySelectorAll } from './html.js';
import { resolveAgainst, safeFetch, snapshotPage } from './evidence.js';

/**
 * Criterion kinds. Everything except ai_review is decided by code, never by the model,
 * so no amount of clever wording in a deliverable can flip a measurable result.
 */
export const KINDS = {
  page_loads: { label: 'Page loads', automated: true },
  contains_text: { label: 'Contains text', automated: true },
  has_element: { label: 'Has element', automated: true },
  http_json: { label: 'API returns JSON', automated: true },
  repo_file: { label: 'Repository file', automated: true },
  ai_review: { label: 'AI judgment', automated: false },
};

const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v, d, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d;
};
const cleanPath = (p) => {
  const s = str(p, 200) || '/';
  return s.startsWith('/') ? s : `/${s}`;
};

/** Normalize a criterion coming from the AI, the heuristic compiler, or a user edit. */
export function sanitizeCriterion(raw, index) {
  const title = str(raw?.title, 200) || `Criterion ${index + 1}`;
  let kind = KINDS[raw?.kind] ? raw.kind : 'ai_review';
  const p = raw?.params || {};
  let params;
  switch (kind) {
    case 'page_loads':
      params = { path: cleanPath(p.path), max_ms: num(p.max_ms, 3000, 100, 60000) };
      break;
    case 'contains_text':
      params = { path: cleanPath(p.path), text: str(p.text, 200) };
      if (!params.text) kind = 'ai_review';
      break;
    case 'has_element':
      params = { path: cleanPath(p.path), selector: str(p.selector, 200), min_count: num(p.min_count, 1, 1, 500) };
      if (!params.selector || !isSupportedSelector(params.selector)) kind = 'ai_review';
      break;
    case 'http_json':
      params = {
        path: cleanPath(p.path),
        expect_status: num(p.expect_status, 200, 100, 599),
        json_keys: Array.isArray(p.json_keys) ? p.json_keys.map((k) => str(k, 80)).filter(Boolean).slice(0, 10) : [],
        min_items: num(p.min_items, 0, 0, 1000),
      };
      break;
    case 'repo_file':
      params = { pattern: str(p.pattern, 120) };
      if (!params.pattern) kind = 'ai_review';
      break;
    default:
      break;
  }
  if (kind === 'ai_review') params = { question: str(p.question, 500) || title, path: cleanPath(p.path) };
  return { id: `C${index + 1}`, title, kind, params, required: raw?.required !== false };
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function globToRegex(pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*').replace(/\?/g, '.');
  // A bare name like "LICENSE" matches at any depth and with any extension.
  return pattern.includes('/') ? new RegExp(`^${esc}$`, 'i') : new RegExp(`(^|/)${esc}(\\.[\\w]+)?$`, 'i');
}

/** Run one automated check. Returns { passed, reasoning, evidence }. */
export async function runAutomatedCheck(criterion, ctx) {
  const { kind, params } = criterion;
  try {
    if (kind === 'repo_file') {
      if (!ctx.repo) return { passed: false, reasoning: 'No repository was submitted, so this file could not be checked.', evidence: null };
      if (ctx.repo.error) return { passed: false, reasoning: `Repository could not be read: ${ctx.repo.error}`, evidence: null };
      const re = globToRegex(params.pattern);
      const hits = ctx.repo.files.filter((f) => re.test(f));
      return {
        passed: hits.length > 0,
        reasoning: hits.length ? `Found ${hits.slice(0, 3).join(', ')} in the repository.` : `No file matching "${params.pattern}" in ${ctx.repo.files.length} repository files.`,
        evidence: hits.slice(0, 5).join('\n') || null,
      };
    }

    const url = resolveAgainst(ctx.baseUrl, params.path);

    if (kind === 'http_json') {
      const res = await ctx.fetch(url, { accept: 'application/json' });
      if (res.status !== params.expect_status) {
        return { passed: false, reasoning: `${params.path} answered HTTP ${res.status}; expected ${params.expect_status}.`, evidence: res.body.slice(0, 300) };
      }
      let data;
      try {
        data = JSON.parse(res.body);
      } catch {
        return { passed: false, reasoning: `${params.path} did not return valid JSON.`, evidence: res.body.slice(0, 300) };
      }
      const missing = params.json_keys.filter((k) => getPath(data, k) === undefined);
      if (missing.length) return { passed: false, reasoning: `JSON from ${params.path} is missing: ${missing.join(', ')}.`, evidence: JSON.stringify(data).slice(0, 300) };
      if (params.min_items) {
        const key = params.json_keys[0];
        const list = key ? getPath(data, key) : data;
        const count = Array.isArray(list) ? list.length : 0;
        if (count < params.min_items) return { passed: false, reasoning: `Expected at least ${params.min_items} items${key ? ` in "${key}"` : ''}, found ${count}.`, evidence: JSON.stringify(data).slice(0, 300) };
      }
      return { passed: true, reasoning: `${params.path} returned HTTP ${res.status} with valid JSON${params.json_keys.length ? ` containing ${params.json_keys.join(', ')}` : ''}.`, evidence: JSON.stringify(data).slice(0, 300) };
    }

    const page = await ctx.page(url);
    if (kind === 'page_loads') {
      const okStatus = page.status >= 200 && page.status < 300;
      const fast = page.elapsedMs <= params.max_ms;
      return {
        passed: okStatus && fast,
        reasoning: !okStatus ? `${params.path} answered HTTP ${page.status}.` : fast ? `Loaded in ${page.elapsedMs} ms (limit ${params.max_ms} ms).` : `Took ${page.elapsedMs} ms, over the ${params.max_ms} ms limit.`,
        evidence: `HTTP ${page.status} · ${page.elapsedMs} ms`,
      };
    }
    if (page.status >= 400) return { passed: false, reasoning: `${params.path} answered HTTP ${page.status}.`, evidence: null };

    if (kind === 'contains_text') {
      const hay = page.visibleText.toLowerCase();
      const i = hay.indexOf(params.text.toLowerCase());
      if (i === -1) {
        const inHidden = page.hiddenText.toLowerCase().includes(params.text.toLowerCase());
        return { passed: false, reasoning: inHidden ? `"${params.text}" only appears in hidden text, which visitors can't see.` : `"${params.text}" does not appear on ${params.path}.`, evidence: null };
      }
      return { passed: true, reasoning: `Found "${params.text}" in the visible page text.`, evidence: page.visibleText.slice(Math.max(0, i - 60), i + params.text.length + 60) };
    }

    if (kind === 'has_element') {
      const els = querySelectorAll(page.root, params.selector);
      return {
        passed: els.length >= params.min_count,
        reasoning: els.length >= params.min_count ? `Found ${els.length} element(s) matching ${params.selector}.` : `Expected at least ${params.min_count} element(s) matching ${params.selector}, found ${els.length}.`,
        evidence: els.slice(0, 3).map((e) => outerHTMLSnippet(e)).join('\n') || null,
      };
    }
  } catch (err) {
    return { passed: false, reasoning: `Check could not run: ${err.message}`, evidence: null };
  }
  return { passed: false, reasoning: `Unknown check kind ${kind}.`, evidence: null };
}

/** Per-review fetch cache so each URL is requested once. */
export function createFetchContext({ baseUrl, repo, allowPrivateUrls }) {
  const raw = new Map();
  const pages = new Map();
  const fetchOnce = (url, { accept } = {}) => {
    const key = `${accept || ''}|${url}`;
    if (!raw.has(key)) raw.set(key, safeFetch(url, { allowPrivateUrls, headers: accept ? { Accept: accept } : {} }));
    return raw.get(key);
  };
  return {
    baseUrl,
    repo,
    fetch: fetchOnce,
    page: async (url) => {
      if (!pages.has(url)) pages.set(url, fetchOnce(url).then(snapshotPage));
      return pages.get(url);
    },
  };
}
