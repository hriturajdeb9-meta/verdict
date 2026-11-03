/**
 * Dependency-free, forgiving HTML parser and a small CSS selector engine.
 * Enough to inspect a deliverable the way a reviewer would: visible text,
 * headings, forms, links, hidden content, and "does this element exist?".
 *
 * Supported selectors: tag, #id, .class, [attr], [attr=v], [attr*=v], [attr^=v],
 * [attr$=v], [attr~=v], descendant (space), child (>), and comma groups.
 */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const NON_VISIBLE = new Set(['script', 'style', 'template', 'noscript', 'head', 'title', 'meta', 'link']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'tr', 'table', 'form', 'label', 'button', 'aside', 'figure', 'blockquote']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s=/"'>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return attrs;
}

export function parseHTML(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  const comments = [];
  let cur = root;
  const re = /<!--([\s\S]*?)-->|<!doctype[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  let last = 0;
  let m;
  const pushText = (t) => t && cur.children.push({ tag: '#text', text: decodeEntities(t), parent: cur });

  while ((m = re.exec(html))) {
    pushText(html.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] !== undefined) {
      comments.push(m[1].trim());
      continue;
    }
    if (m[2]) {
      const tag = m[2].toLowerCase();
      // Close the nearest matching open element; ignore stray end tags.
      let n = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n && n.parent) cur = n.parent;
      continue;
    }
    if (m[3]) {
      const tag = m[3].toLowerCase();
      const rawAttrs = m[4] || '';
      // Implicitly close <p> and <li> like browsers do.
      if ((tag === 'li' && cur.tag === 'li') || (tag === 'p' && cur.tag === 'p')) cur = cur.parent;
      const el = { tag, attrs: parseAttrs(rawAttrs), children: [], parent: cur };
      cur.children.push(el);
      if (RAW.has(tag)) {
        const end = html.toLowerCase().indexOf(`</${tag}`, last);
        const stop = end === -1 ? html.length : end;
        const inner = html.slice(last, stop);
        if (inner) el.children.push({ tag: '#text', text: tag === 'title' || tag === 'textarea' ? decodeEntities(inner) : inner, parent: el });
        const close = end === -1 ? html.length : html.indexOf('>', end) + 1;
        re.lastIndex = last = close;
        continue;
      }
      if (!VOID.has(tag) && !/\/\s*$/.test(rawAttrs)) cur = el;
    }
  }
  pushText(html.slice(last));
  return { root, comments };
}

export function isHiddenElement(el) {
  if (!el.attrs) return false;
  if ('hidden' in el.attrs) return true;
  if (el.attrs['aria-hidden'] === 'true') return true;
  const style = (el.attrs.style || '').replace(/\s+/g, '').toLowerCase();
  return /display:none|visibility:hidden|font-size:0(px|em|rem)?(;|$)|opacity:0(;|$)|color:transparent|left:-\d{3,}px|text-indent:-\d{3,}px/.test(style);
}

/** Visible text and, separately, text hidden from human readers. */
export function extractText(root) {
  const visible = [];
  const hidden = [];
  (function walk(node, isHidden) {
    for (const c of node.children || []) {
      if (c.tag === '#text') {
        (isHidden ? hidden : visible).push(c.text);
        continue;
      }
      if (NON_VISIBLE.has(c.tag)) continue;
      const h = isHidden || isHiddenElement(c);
      if (BLOCK.has(c.tag)) (h ? hidden : visible).push('\n');
      walk(c, h);
      if (BLOCK.has(c.tag)) (h ? hidden : visible).push('\n');
    }
  })(root, false);
  const clean = (arr) =>
    arr
      .join(' ')
      .replace(/[ \t\r\f\v]+/g, ' ')
      .replace(/ *\n[\n ]*/g, '\n')
      .trim();
  return { visible: clean(visible), hidden: clean(hidden) };
}

export function textOf(el) {
  if (el.tag === '#text') return el.text;
  return (el.children || []).map(textOf).join(' ').replace(/\s+/g, ' ').trim();
}

export function* walkElements(node) {
  for (const c of node.children || []) {
    if (c.tag === '#text') continue;
    yield c;
    yield* walkElements(c);
  }
}

// ---------- selectors ----------

function parseCompound(s) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /^([a-zA-Z*][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*(i)?)?\s*\]/g;
  let m;
  let consumed = 0;
  while ((m = re.exec(s))) {
    if (m.index !== consumed) throw new Error(`Unsupported selector near "${s.slice(consumed)}"`);
    consumed = re.lastIndex;
    if (m[1]) out.tag = m[1] === '*' ? null : m[1].toLowerCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) out.attrs.push({ name: m[4].toLowerCase(), op: m[5] || null, value: m[6] ?? m[7] ?? m[8] ?? '', ci: !!m[9] });
  }
  if (consumed !== s.length || !s) throw new Error(`Unsupported selector "${s}"`);
  return out;
}

export function compileSelector(selector) {
  return selector.split(',').map((group) => {
    const tokens = group.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
    const steps = [];
    let combinator = ' ';
    for (const t of tokens) {
      if (t === '>') {
        combinator = '>';
        continue;
      }
      steps.push({ combinator, compound: parseCompound(t) });
      combinator = ' ';
    }
    if (!steps.length) throw new Error('Empty selector');
    return steps;
  });
}

function matchCompound(el, c) {
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id && el.attrs.id !== c.id) return false;
  if (c.classes.length) {
    const cls = (el.attrs.class || '').split(/\s+/);
    if (!c.classes.every((k) => cls.includes(k))) return false;
  }
  for (const a of c.attrs) {
    if (!(a.name in el.attrs)) return false;
    if (!a.op) continue;
    let v = el.attrs[a.name];
    let want = a.value;
    if (a.ci || a.name === 'type') {
      v = v.toLowerCase();
      want = want.toLowerCase();
    }
    const ok =
      a.op === '=' ? v === want
      : a.op === '*=' ? v.includes(want)
      : a.op === '^=' ? v.startsWith(want)
      : a.op === '$=' ? v.endsWith(want)
      : a.op === '~=' ? v.split(/\s+/).includes(want)
      : a.op === '|=' ? v === want || v.startsWith(`${want}-`)
      : false;
    if (!ok) return false;
  }
  return true;
}

function matchSteps(el, steps, i) {
  if (!matchCompound(el, steps[i].compound)) return false;
  if (i === 0) return true;
  if (steps[i].combinator === '>') return el.parent && el.parent.tag !== '#root' && matchSteps(el.parent, steps, i - 1);
  for (let p = el.parent; p && p.tag !== '#root'; p = p.parent) if (matchSteps(p, steps, i - 1)) return true;
  return false;
}

export function querySelectorAll(root, selector) {
  const groups = compileSelector(selector);
  const out = [];
  for (const el of walkElements(root)) {
    if (groups.some((steps) => matchSteps(el, steps, steps.length - 1))) out.push(el);
  }
  return out;
}

export function isSupportedSelector(selector) {
  try {
    compileSelector(selector);
    return true;
  } catch {
    return false;
  }
}

export function outerHTMLSnippet(el, max = 180) {
  const attrs = Object.entries(el.attrs || {})
    .map(([k, v]) => (v === '' ? k : `${k}="${v}"`))
    .join(' ');
  const s = `<${el.tag}${attrs ? ` ${attrs}` : ''}>${textOf(el).slice(0, 80)}`;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
