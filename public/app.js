// Verdict front end. No framework, no build step.

// ---------------------------------------------------------------- utilities
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v === null || v === undefined || v === false ? '' : esc(v));
const html = (strings, ...vals) => raw(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? fmt(vals[i]) : ''), ''));
const $ = (sel, el = document) => el.querySelector(sel);
const main = $('#main');

const money = (v) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

let toastTimer;
function toast(message, kind = '') {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), kind === 'error' ? 6000 : 3200);
}

// Each browser keeps the links (tokens) it was given. Holding both is how one person demos both sides.
const Tokens = {
  all() {
    try { return JSON.parse(localStorage.getItem('verdict.tokens') || '{}'); } catch { return {}; }
  },
  save(all) {
    try { localStorage.setItem('verdict.tokens', JSON.stringify(all)); } catch { /* private mode */ }
  },
  set(dealId, role, token) {
    const all = this.all();
    all[dealId] = { ...(all[dealId] || {}), [role]: token };
    this.save(all);
  },
  get(dealId) { return this.all()[dealId] || {}; },
  active(dealId) {
    const t = this.get(dealId);
    return t._active && t[t._active] ? t._active : t.client ? 'client' : t.freelancer ? 'freelancer' : t.unknown ? 'unknown' : null;
  },
  setActive(dealId, role) {
    const all = this.all();
    if (all[dealId]) { all[dealId]._active = role; this.save(all); }
  },
};

async function api(method, path, body, token) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Deal-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function busy(btn, fn) {
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Working'; }
  try { return await fn(); } catch (err) { toast(err.message, 'error'); return null; } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
}

// ---------------------------------------------------------------- config
let CONFIG = null;
async function loadConfig() {
  // The server inlines the config into index.html, so the first paint needs no extra request.
  CONFIG = window.__VERDICT_CONFIG__ || (await api('GET', '/api/config'));
  const pp = CONFIG.paypalMode === 'sandbox';
  const ai = CONFIG.aiProvider !== 'heuristic';
  $('#modes').innerHTML = html`
    <span class="chip ${pp ? 'live' : ''}" title="${pp ? 'Real PayPal sandbox API' : 'No PayPal keys set; using the built-in simulator'}"><span class="dot"></span>PayPal ${pp ? 'sandbox' : 'simulated'}</span>
    <span class="chip ${ai ? 'live' : ''}" title="${ai ? CONFIG.aiModel : 'No AI key set; using offline heuristics'}"><span class="dot"></span>${ai ? `${CONFIG.aiLabel} arbiter` : 'Offline arbiter'}</span>`.s;
}

// ---------------------------------------------------------------- router
let stopPolling = () => {};
let stopHero = () => {};
async function route() {
  stopPolling();
  stopHero();
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query || '');
  const parts = (path || '/').split('/').filter(Boolean);
  document.body.dataset.page = parts[0] || 'home';
  window.scrollTo(0, 0);
  if (parts[0] === 'new') return renderNew();
  if (parts[0] === 'deal' && parts[1]) {
    const t = params.get('t');
    if (t) {
      Tokens.set(parts[1], 'unknown', t);
      history.replaceState(null, '', `#/deal/${parts[1]}`);
    }
    return renderDeal(parts[1]);
  }
  return renderHome();
}

// ---------------------------------------------------------------- home
const HERO_CLAUSES = [
  ['The page loads in under 2 seconds', 'Measured'],
  ['Visitors can join with an email signup form', 'Measured'],
  ['/api/menu returns the menu as JSON', 'Measured'],
  ['The copy feels warm and friendly', 'AI judgment'],
];

function heroContract() {
  return html`
    <figure class="contract" id="hero-contract" aria-label="Example: a $250 deal held in PayPal, reviewed by Verdict, then released">
      <div class="hc-head">
        <div><div class="hc-title">Landing page for Bloom Bakery</div><div class="hc-sub">Maya hires Arjun</div></div>
        <div class="hc-amount"><div class="hc-fig">$250.00</div><div class="hc-where" id="hc-where">Waiting for the hold</div></div>
      </div>
      <div class="hc-attempt" id="hc-attempt">The contract</div>
      <ol class="hc-clauses">${HERO_CLAUSES.map(([t, k], i) => html`
        <li data-i="${i}"><span class="hc-ico" aria-hidden="true"></span><span class="hc-text">${t}</span><span class="hc-kind ${k === 'AI judgment' ? 'ai' : ''}">${k}</span></li>`)}
      </ol>
      <div class="hc-rail" aria-hidden="true">
        <span class="hc-node">Maya</span>
        <span class="hc-track"><span class="hc-mid">PayPal hold</span><span class="hc-coin" id="hc-coin">$</span></span>
        <span class="hc-node">Arjun</span>
      </div>
      <p class="hc-status" id="hc-status" aria-live="off">Both sides agree on what “done” means.</p>
      <div class="hc-stamp" id="hc-stamp"></div>
    </figure>`;
}

/** Plays the product story on the hero contract: hold, held with fixes, released and paid. */
function playHero() {
  const root = $('#hero-contract');
  if (!root) return () => {};
  const items = [...root.querySelectorAll('.hc-clauses li')];
  const $s = (id) => root.querySelector(id);
  const set = (i, state) => (items[i].className = state);
  const coin = (pos) => ($s('#hc-coin').dataset.pos = pos);
  const status = (t) => ($s('#hc-status').textContent = t);
  const where = (t, tone) => {
    const w = $s('#hc-where');
    w.textContent = t;
    w.dataset.tone = tone || '';
  };
  const stamp = (decision, n) => ($s('#hc-stamp').innerHTML = decision ? stampSVG(decision, n, true, `hero${n}${decision}`).s : '');

  const finalState = () => {
    items.forEach((_, i) => set(i, 'passed'));
    $s('#hc-attempt').textContent = 'Attempt 2';
    coin('end');
    where('Paid to Arjun', 'pass');
    status('Every criterion passed. Captured and paid out with PayPal Payouts.');
    stamp('release', 2);
  };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finalState();
    return () => {};
  }

  let timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  const run = () => {
    timers = [];
    let t = 0;
    const step = (ms, fn) => at((t += ms), fn);
    step(0, () => {
      items.forEach((_, i) => set(i, ''));
      stamp(null);
      coin('start');
      where('Waiting for the hold');
      $s('#hc-attempt').textContent = 'The contract';
      status('Both sides agree on what “done” means.');
    });
    step(1600, () => {
      coin('mid');
      where('On hold in PayPal', 'hold');
      status('Maya approves a PayPal hold. Nothing is charged yet.');
    });
    step(1700, () => {
      $s('#hc-attempt').textContent = 'Attempt 1';
      status('Arjun delivers. Verdict checks every clause.');
    });
    const first = ['passed', 'failed', 'failed', 'passed'];
    first.forEach((r, i) => {
      step(i === 0 ? 500 : 650, () => set(i, 'running'));
      step(450, () => set(i, r));
    });
    step(450, () => {
      stamp('changes_requested', 1);
      status('Held. Arjun gets two exact fix notes. The money stays put.');
    });
    step(2600, () => {
      stamp(null);
      items.forEach((_, i) => set(i, ''));
      $s('#hc-attempt').textContent = 'Attempt 2';
      status('Arjun fixes the site and resubmits.');
    });
    [0, 1, 2, 3].forEach((i) => {
      step(i === 0 ? 700 : 450, () => set(i, 'running'));
      step(350, () => set(i, 'passed'));
    });
    step(450, () => {
      stamp('release', 2);
      status('Every criterion passed. Verdict releases the money.');
    });
    step(1100, () => {
      coin('end');
      where('Paid to Arjun', 'pass');
      status('Captured and paid out with PayPal Payouts. No invoice, no chasing.');
    });
    step(4200, run);
  };
  // Start only once the hero is on screen, and pause when the tab is hidden.
  let started = false;
  const io = new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !started) {
      started = true;
      run();
    }
  });
  io.observe(root);
  return () => {
    io.disconnect();
    timers.forEach(clearTimeout);
  };
}

async function renderHome() {
  document.title = 'Verdict · Payment that releases when the work is done';
  const repo = 'https://github.com/hriturajdeb9-meta/verdict';
  main.innerHTML = html`
    <section class="band">
      <div class="hero2">
        <div class="hero-copy">
          <h1>Payment that releases itself when the work meets the brief.</h1>
          <p class="hero-lede">The client’s money is held in PayPal, not charged. When the freelancer delivers, an AI arbiter checks the work against criteria both sides agreed to. Everything passes, the money moves. Something’s missing, the freelancer gets exact fix notes.</p>
          <div class="btn-row">
            <a class="btn primary big" href="#/new?demo=1">Try the live demo</a>
            <a class="btn ghost big" href="#/new">Start a deal</a>
          </div>
          <p class="hero-proof">Runs on PayPal Orders, authorization capture and Payouts. Ruled by ${CONFIG.aiProvider === 'heuristic' ? 'Gemini or Claude' : CONFIG.aiLabel}.</p>
        </div>
        ${heroContract()}
      </div>
    </section>

    <section class="home-deals" id="home-deals" hidden>
      <div class="section-head"><h2>Your deals</h2><a class="btn quiet" href="#/new">New deal</a></div>
      <div class="deal-list" id="deal-list"></div>
    </section>

    <section class="why">
      <h2 class="why-h">Escrow holds the money. Nobody decides when the work is done.</h2>
      <div class="why-cols">
        <p><b>Freelancers</b> deliver, then chase invoices for weeks, or argue about whether “done” was done.</p>
        <p><b>Clients</b> pay up front and hope, or hold back payment and lose good people.</p>
        <p><b>Verdict</b> defines “done” before work starts, checks it the moment it arrives, and moves the money itself.</p>
      </div>
    </section>

    <section class="how">
      <h2>How it works</h2>
      <ol class="flow" aria-label="How Verdict works">
        <li><div class="n">1</div><h3>Agree</h3><p>The brief becomes measurable acceptance criteria. Both sides accept them before any money moves.</p></li>
        <li><div class="n">2</div><h3>Hold</h3><p>The client approves a PayPal authorization. The money is reserved, not captured.</p></li>
        <li><div class="n">3</div><h3>Rule</h3><p>Code measures what it can. The AI judges the rest and explains every ruling with evidence.</p></li>
        <li><div class="n">4</div><h3>Settle</h3><p>All criteria pass: the hold is captured and the freelancer is paid with PayPal Payouts.</p></li>
      </ol>
    </section>

    <section class="guards">
      <h2>Money can’t be talked out of the hold</h2>
      <dl class="ledger-list">
        <div><dt>Code measures, AI judges</dt><dd>Load time, forms and APIs are checked by code. The AI only rules on what code can’t measure, and can’t overrule a measurement.</dd></div>
        <div><dt>Prompt-injection guard</dt><dd>Text hidden in a deliverable that targets the reviewer is caught, and the money is never released automatically.</dd></div>
        <div><dt>Fails closed</dt><dd>If the AI is down, skips a criterion or PayPal errors, the money stays on hold. Every PayPal call is idempotent.</dd></div>
        <div><dt>A human always has the last word</dt><dd>The freelancer can dispute a verdict; the client can release, ask for another attempt, or void the hold.</dd></div>
      </dl>
    </section>

    <section class="under">
      <h2>Under the hood</h2>
      <table class="api-table">
        <tr><th>PayPal Orders v2, intent AUTHORIZE</th><td>Holds the client’s money without charging it</td></tr>
        <tr><th>Payments v2 capture and void</th><td>Releases the hold when the work passes, or cancels it</td></tr>
        <tr><th>Payouts v1</th><td>Pays the freelancer’s PayPal account</td></tr>
        <tr><th>${CONFIG.aiProvider === 'anthropic' ? 'Claude, structured tool use' : 'Gemini, function calling'}</th><td>Drafts the criteria and rules on the subjective ones</td></tr>
      </table>
    </section>

    <footer class="site-foot">
      <span>Verdict is open source under the MIT license.</span>
      <a href="${repo}" target="_blank" rel="noopener noreferrer">Source on GitHub</a>
    </footer>`.s;

  stopHero = playHero();

  const all = Tokens.all();
  const toks = Object.values(all).flatMap((t) => [t.client, t.freelancer, t.unknown]).filter(Boolean);
  const list = toks.length ? await api('GET', `/api/deals?tokens=${encodeURIComponent(toks.join(','))}`).catch(() => []) : [];
  const box = $('#home-deals');
  if (!box || !list.length) return;
  box.hidden = false;
  $('#deal-list').innerHTML = html`${list.map((d) => html`
      <a class="deal-row" href="#/deal/${d.id}">
        <div><div style="font-weight:600">${d.title}</div><div class="small muted">You are the ${d.role}, created ${when(d.createdAt)}</div></div>
        <div style="font-weight:700">${money(d.amount)}</div>
        <span class="status ${statusTone(d.status)}">${d.statusLabel}</span>
      </a>`)}`.s;
}

function statusTone(s) {
  return { released: 'pass', cancelled: '', changes_requested: 'fail', escalated: 'hold', settlement_failed: 'fail', funded: 'seal', in_review: 'seal', releasing: 'seal', awaiting_funding: 'hold', awaiting_agreement: 'hold' }[s] || '';
}

// ---------------------------------------------------------------- new deal
const KIND_LABEL = { page_loads: 'Measured: load time', contains_text: 'Measured: text', has_element: 'Measured: element', http_json: 'Measured: API', repo_file: 'Measured: repo file', ai_review: 'AI judgment' };
let draft = { criteria: [], source: null };

function renderNew() {
  document.title = 'New deal · Verdict';
  const demo = new URLSearchParams(location.hash.split('?')[1] || '').get('demo');
  const b = demo ? CONFIG.demoBrief : {};
  draft = { criteria: [], source: null };
  main.innerHTML = html`
    <div class="page-head">
      <h1 style="font-size:36px">Start a deal</h1>
      <p class="lede">Describe the job the way you'd brief a freelancer. Verdict drafts the criteria; you both approve them.</p>
    </div>
    <form class="compose" id="new-deal" novalidate>
      <div class="panel stack">
        <h2>The job</h2>
        <label class="field">Job title<input type="text" name="title" required maxlength="120" value="${b.title || ''}" placeholder="Landing page for my bakery"></label>
        <label class="field">Brief <span class="hint">List what "done" means. One requirement per line works best.</span>
          <textarea name="description" required>${b.description || ''}</textarea></label>
        <div class="grid2">
          <label class="field">Amount (USD)<input type="number" name="amount" min="1" max="10000" step="0.01" required value="${b.amount || ''}" placeholder="250.00"></label>
          <label class="field">Your name<input type="text" name="clientName" maxlength="80" value="${b.clientName || ''}" placeholder="Maya"></label>
        </div>
        <div class="grid2">
          <label class="field">Freelancer's name<input type="text" name="freelancerName" maxlength="80" value="${b.freelancerName || ''}" placeholder="Arjun"></label>
          <label class="field">Freelancer's PayPal email<input type="email" name="freelancerEmail" required placeholder="arjun@example.com" value="${b.freelancerEmail || ''}"></label>
        </div>
        ${CONFIG.paypalMode === 'sandbox' ? html`<p class="small muted">Use the email of a PayPal sandbox personal account so the payout lands somewhere you can check.</p>` : ''}
        <div class="btn-row"><button class="btn" type="button" data-act="compile">Draft criteria${CONFIG.aiProvider !== 'heuristic' ? ` with ${CONFIG.aiLabel}` : ''}</button></div>
      </div>
      <div class="panel stack" id="criteria-panel">
        <div><h2>Acceptance criteria</h2><p class="muted small">These decide whether the money is released. Measured criteria are checked by code; AI judgments are ruled on by the arbiter with evidence.</p></div>
        <div id="criteria-list" class="criteria-edit"><div class="empty">Write the brief, then draft criteria.</div></div>
        <div class="btn-row"><button class="btn primary" type="submit" data-act="create" disabled>Create deal and get invite link</button></div>
      </div>
    </form>`.s;
}

function renderDraftCriteria() {
  const el = $('#criteria-list');
  if (!draft.criteria.length) {
    el.innerHTML = html`<div class="empty">No criteria. Draft them from the brief.</div>`.s;
    $('[data-act=create]').disabled = true;
    return;
  }
  el.innerHTML = html`${draft.criteria.map((c, i) => html`
    <div class="crit-edit">
      <div class="crit-id">C${i + 1}</div>
      <div>
        <textarea rows="2" aria-label="Criterion C${i + 1}" data-crit-title="${i}">${c.title}</textarea>
        <div class="crit-meta">
          <span class="kind ${c.kind === 'ai_review' ? 'ai' : ''}">${KIND_LABEL[c.kind]}</span>
          ${describeParams(c)}
          <label><input type="checkbox" data-crit-req="${i}" ${c.required ? 'checked' : ''}> Required</label>
        </div>
      </div>
      <button class="btn quiet" type="button" data-act="remove-crit" data-i="${i}" aria-label="Remove C${i + 1}">Remove</button>
    </div>`)}`.s;
  $('[data-act=create]').disabled = false;
}

function describeParams(c) {
  const p = c.params || {};
  switch (c.kind) {
    case 'page_loads': return `${p.path} loads in under ${p.max_ms} ms`;
    case 'contains_text': return `“${p.text}” on ${p.path}`;
    case 'has_element': return `${p.selector} on ${p.path}`;
    case 'http_json': return `${p.path} → ${p.expect_status}${p.json_keys?.length ? ` with ${p.json_keys.join(', ')}` : ''}`;
    case 'repo_file': return `file ${p.pattern}`;
    default: return '';
  }
}

// ---------------------------------------------------------------- deal page
const D = { id: null, view: null, sig: '', seenRunning: new Set(), freshStamp: new Set() };

async function renderDeal(id, { silent } = {}) {
  D.id = id;
  const role = Tokens.active(id);
  const toks = Tokens.get(id);
  if (!role) {
    main.innerHTML = html`<div class="page-head"><h1 style="font-size:32px">This deal isn't in this browser</h1><p class="lede">Open it from the invite link you were sent.</p><p><a href="#/">Back to your deals</a></p></div>`.s;
    return;
  }
  if (!silent) main.innerHTML = html`<div class="page-head"><p class="muted">Loading deal…</p></div>`.s;
  try {
    const view = await api('GET', `/api/deals/${id}`, null, toks[role]);
    if (role === 'unknown') {
      // An invite link: learn which role this token is, then file it properly.
      const all = Tokens.all();
      delete all[id].unknown;
      Tokens.save(all);
      Tokens.set(id, view.role, toks.unknown);
      Tokens.setActive(id, view.role);
    }
    paint(view);
  } catch (err) {
    if (!silent) main.innerHTML = html`<div class="page-head"><h1 style="font-size:32px">Can't open this deal</h1><p class="lede">${err.message}</p><p><a href="#/">Back to your deals</a></p></div>`.s;
    return;
  }
  schedulePoll();
}

function schedulePoll() {
  stopPolling();
  let alive = true;
  const tick = async () => {
    if (!alive) return;
    const v = D.view;
    const fast = v && (v.status === 'in_review' || v.status === 'releasing' || (v.status === 'released' && v.paypal.payoutStatus !== 'SUCCESS'));
    const role = Tokens.active(D.id);
    const tok = Tokens.get(D.id)[role];
    if (document.visibilityState === 'visible' && tok) {
      try { paint(await api('GET', `/api/deals/${D.id}`, null, tok)); } catch { /* transient */ }
    }
    if (alive) timer = setTimeout(tick, fast ? 1000 : 4000);
  };
  let timer = setTimeout(tick, 1000);
  stopPolling = () => { alive = false; clearTimeout(timer); };
}

function paint(view) {
  const sig = JSON.stringify(view);
  if (sig === D.sig && D.view) return;
  // Stamps animate once, at the moment a running review turns into a ruling.
  for (const s of view.submissions) {
    if (s.verdict.status === 'running') D.seenRunning.add(s.id);
    else if (D.seenRunning.has(s.id)) { D.seenRunning.delete(s.id); D.freshStamp.add(s.id); }
  }
  // Keep whatever the person is typing across refreshes.
  const kept = {};
  main.querySelectorAll('[data-keep]').forEach((el) => (kept[el.dataset.keep] = el.value));
  D.sig = sig;
  D.view = view;
  document.title = `${view.title} · Verdict`;
  main.innerHTML = dealHTML(view).s;
  main.querySelectorAll('[data-keep]').forEach((el) => { if (kept[el.dataset.keep] !== undefined) el.value = kept[el.dataset.keep]; });
  D.freshStamp.clear();
  if (view.role === 'client' && view.actions.includes('fund')) mountPayPal(view);
}

function dealHTML(v) {
  const toks = Tokens.get(v.id);
  const both = toks.client && toks.freelancer;
  const held = v.paypal.authorizationId && !['CAPTURED', 'VOIDED'].includes(v.paypal.authorizationStatus);
  const where = v.status === 'released' ? `Paid to ${v.freelancer.name}` : v.status === 'cancelled' ? 'Hold voided, not charged' : held ? 'On hold in PayPal' : 'Not funded yet';
  return html`
    <div class="deal-head">
      <div>
        <span class="status ${statusTone(v.status)}">${v.statusLabel}</span>
        <h1 style="font-size:clamp(28px,4vw,40px);margin-top:12px">${v.title}</h1>
        <p class="parties">${v.client.name} hires ${v.freelancer.name}</p>
      </div>
      <div class="amount"><div class="figure">${money(v.amount)}</div><div class="where">${where}</div></div>
    </div>
    ${both ? html`<div class="rolebar"><span>Viewing as</span>
      <div class="seg" role="group" aria-label="Switch role">
        <button type="button" data-act="role" data-role="client" aria-pressed="${v.role === 'client'}">Client</button>
        <button type="button" data-act="role" data-role="freelancer" aria-pressed="${v.role === 'freelancer'}">Freelancer</button>
      </div><span class="small">This browser holds both links, so you can play both sides.</span></div>` : ''}
    <div class="layout">
      <div>
        ${actionPanel(v)}
        ${v.submissions.slice().reverse().map((s) => rulingHTML(v, s))}
        ${contractHTML(v)}
      </div>
      <aside class="side">
        ${railHTML(v)}
        ${moneyHTML(v)}
        ${ledgerHTML(v)}
      </aside>
    </div>`;
}

function railHTML(v) {
  const order = ['awaiting_agreement', 'awaiting_funding', 'funded', 'in_review', 'released'];
  const stepOf = { awaiting_agreement: 0, awaiting_funding: 1, funded: 2, in_review: 3, changes_requested: 2, escalated: 3, releasing: 4, settlement_failed: 4, released: 5, cancelled: -1 };
  const at = stepOf[v.status];
  const steps = [
    ['Agree on criteria', v.agreedAt ? `Locked ${when(v.agreedAt)}` : 'Freelancer reviews the criteria'],
    ['Hold the money', v.fundedAt ? `Held ${when(v.fundedAt)}` : 'Client approves a PayPal authorization'],
    ['Deliver the work', v.submissions.length ? `${v.submissions.length} of ${v.maxAttempts} attempts used` : 'Freelancer submits a URL'],
    ['Verdict', v.status === 'escalated' ? 'Waiting for a human decision' : 'Criteria checked with evidence'],
    ['Paid', v.releasedAt ? `Released ${when(v.releasedAt)}` : 'Capture and PayPal payout'],
  ];
  void order;
  if (v.status === 'cancelled') {
    return html`<div class="panel"><h3>Progress</h3><p class="muted small" style="margin-top:6px">Cancelled. The hold was voided, so the client was never charged.</p></div>`;
  }
  return html`<div class="panel"><h3 style="margin-bottom:14px">Progress</h3><ol class="rail">${steps.map(([t, d], i) => html`
    <li class="${i < at ? 'done' : i === at ? 'now' : ''}"><span class="mark">${i < at ? '✓' : i + 1}</span><div><div class="t">${t}</div><div class="d">${d}</div></div></li>`)}</ol></div>`;
}

function moneyHTML(v) {
  const p = v.paypal;
  const rows = [
    ['Mode', p.mode === 'sandbox' ? 'PayPal sandbox' : 'Simulated PayPal'],
    p.orderId && ['Order', raw(`<span class="code">${esc(p.orderId)}</span>`)],
    p.authorizationId && ['Authorization', raw(`<span class="code">${esc(p.authorizationId)}</span>`)],
    p.authorizationStatus && ['Hold status', p.authorizationStatus],
    p.authorizationExpiresAt && !p.captureId && p.authorizationStatus !== 'VOIDED' && ['Hold valid until', when(p.authorizationExpiresAt)],
    p.captureId && ['Capture', raw(`<span class="code">${esc(p.captureId)}</span>`)],
    p.payoutBatchId && ['Payout batch', raw(`<span class="code">${esc(p.payoutBatchId)}</span>`)],
    p.payoutStatus && ['Payout status', p.payoutStatus],
    p.payoutAmount && ['Paid to freelancer', money(p.payoutAmount)],
    p.platformFee && Number(p.platformFee) > 0 && ['Platform fee', money(p.platformFee)],
  ].filter(Boolean);
  return html`<div class="panel money"><h3>PayPal</h3>${rows.map(([k, val]) => html`<div class="row"><span>${k}</span><span>${val}</span></div>`)}</div>`;
}

function ledgerHTML(v) {
  return html`<div class="panel"><h3>Audit trail</h3><ol class="ledger">${v.events.slice().reverse().map((e) => html`
    <li><span class="who ${e.actor}">${e.actor === 'paypal' ? 'PayPal' : e.actor === 'verdict' ? 'Verdict' : e.actor === 'client' ? v.client.name : v.freelancer.name} · ${when(e.at)}</span>
      <span>${e.message}</span>
      ${e.ref ? html`<span class="ref">${Object.entries(e.ref).filter(([, x]) => x).map(([k, x]) => `${k}: ${x}`).join(' · ')}</span>` : ''}</li>`)}</ol></div>`;
}

function contractHTML(v) {
  return html`<section class="panel" aria-labelledby="contract-h">
    <h2 id="contract-h">The contract</h2>
    <p class="muted small">${v.agreedAt ? `Both sides agreed to these criteria on ${when(v.agreedAt)}. They can't be changed.` : 'Proposed by the client. The freelancer accepts them before any money is held.'}</p>
    <ol class="clauses">${v.criteria.map((c) => html`
      <li class="clause"><span class="cid">${c.id}</span><div><div class="ctext">${c.title}</div><div class="crit-meta"><span class="kind ${c.kind === 'ai_review' ? 'ai' : ''}">${KIND_LABEL[c.kind]}</span>${describeParams(c)}</div></div>${c.required ? '' : html`<span class="optional">Optional</span>`}</li>`)}</ol>
  </section>`;
}

// The memorable part: every ruling is stamped.
function stampSVG(decision, n, fresh, sid) {
  const word = { release: 'RELEASED', changes_requested: 'HELD', escalate: 'REVIEW', running: 'RULING' }[decision] || 'RULING';
  const ring = `VERDICT · ATTEMPT ${n} · VERDICT · ATTEMPT ${n} · `;
  const fid = `ink-${sid.slice(0, 8)}`;
  return raw(`<svg class="stamp ${decision} ${fresh ? 'fresh' : ''}" viewBox="0 0 140 140" aria-hidden="true">
    <defs>
      <filter id="${fid}"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${n * 7}"/><feDisplacementMap in="SourceGraphic" scale="1.6"/></filter>
      <path id="r-${fid}" d="M70,70 m-52,0 a52,52 0 1,1 104,0 a52,52 0 1,1 -104,0"/>
    </defs>
    <g filter="url(#${fid})" fill="none" stroke="currentColor">
      <circle cx="70" cy="70" r="66" stroke-width="3.5"/>
      <circle cx="70" cy="70" r="40" stroke-width="1.6"/>
      <text font-family="Schibsted Grotesk, sans-serif" font-size="10.5" font-weight="700" letter-spacing="1.6" fill="currentColor" stroke="none"><textPath href="#r-${fid}">${ring}</textPath></text>
      <text x="70" y="75" text-anchor="middle" font-family="Schibsted Grotesk, sans-serif" font-weight="700" font-size="${word.length > 6 ? 13.5 : 17}" letter-spacing="1" fill="currentColor" stroke="none">${word}</text>
    </g></svg>`);
}

function rulingHTML(v, s) {
  const vd = s.verdict;
  const running = vd.status === 'running';
  const decision = running ? 'running' : vd.decision;
  const head = running
    ? 'Verdict is reviewing this attempt'
    : { release: 'All required criteria passed', changes_requested: 'Changes requested', escalate: 'Sent to a human' }[decision] || 'Review finished';
  const fixes = (vd.fixNotes || []).filter((f) => vd.checks.find((c) => c.criterionId === f.criterionId)?.state === 'failed');
  return html`<section class="panel ruling" aria-labelledby="r-${s.id}">
    ${stampSVG(decision, s.n, D.freshStamp.has(s.id), s.id)}
    <div class="ruling-head"><div>
      <div class="small muted">Attempt ${s.n} · submitted ${when(s.createdAt)} · ${vd.aiProvider && vd.aiProvider !== 'heuristic' ? `judged with ${vd.aiModel}` : 'judged offline'}</div>
      <h2 id="r-${s.id}" style="margin-top:6px">${head}</h2>
      <p class="small" style="margin-top:6px"><a href="${s.url}" target="_blank" rel="noopener noreferrer">${s.url}</a>${s.repoUrl ? html` · <a href="${s.repoUrl}" target="_blank" rel="noopener noreferrer">repository</a>` : ''}</p>
      ${vd.summary ? html`<p class="summary">${vd.summary}</p>` : ''}
      ${vd.decisionReason ? html`<p class="reason">${vd.decisionReason}</p>` : ''}
    </div></div>
    ${vd.injection?.flagged ? html`<div class="callout fail" style="margin-top:14px"><h3>The deliverable tried to instruct the AI reviewer</h3>
      <p class="small">Measured checks can't be influenced by text, and the arbiter ignores instructions inside deliverables. Even so, Verdict never auto-releases money when this happens.</p>
      <ul class="small">${vd.injection.findings.map((f) => html`<li><b>${f.reason}</b> in ${f.where}: <span class="serif">“${f.excerpt}”</span></li>`)}</ul></div>` : ''}
    ${vd.pageError ? html`<div class="callout fail" style="margin-top:14px"><h3>The page could not be loaded</h3><p class="small">${vd.pageError}</p></div>` : ''}
    <ul class="checks">${vd.checks.map((c) => html`
      <li class="check ${c.state}">
        <span class="ico" aria-label="${c.state}">${c.state === 'passed' ? '✓' : c.state === 'failed' ? '✕' : ''}</span>
        <div>
          <div class="title">${c.criterionId} · ${c.title}</div>
          <div class="meta"><span class="kind ${c.method === 'ai' ? 'ai' : ''}">${c.method === 'ai' ? 'AI judgment' : 'Measured'}</span>${c.method === 'ai' && c.confidence !== undefined && c.state !== 'running' ? html`<span>${Math.round(c.confidence * 100)}% confidence</span>` : ''}${c.required ? '' : html`<span>Optional</span>`}${c.state === 'pending' ? html`<span>Queued</span>` : c.state === 'running' ? html`<span>Checking…</span>` : ''}</div>
          ${c.reasoning ? html`<p class="why">${c.reasoning}</p>` : ''}
          ${c.evidence ? html`<details><summary>Evidence</summary><pre>${c.evidence}</pre></details>` : ''}
        </div>
      </li>`)}</ul>
    ${fixes.length ? html`<div class="callout fail" style="margin-top:14px"><h3>What to fix</h3><ul class="fixes">${fixes.map((f) => html`<li><b>${f.criterionId}</b><span>${f.note}</span></li>`)}</ul></div>` : ''}
  </section>`;
}

function actionPanel(v) {
  const r = v.role;
  const a = v.actions;
  const p = [];
  const fl = v.freelancer.name;
  const cl = v.client.name;

  if (v.status === 'awaiting_agreement') {
    if (r === 'client') {
      const link = `${location.origin}/#/deal/${v.id}?t=${v.inviteToken}`;
      p.push(html`<div class="panel stack"><h2>Send ${fl} the invite link</h2>
        <p class="muted">${fl} reviews the criteria below and accepts them. Then you'll hold the money with PayPal.</p>
        <div class="invite"><input type="text" readonly value="${link}" aria-label="Invite link" id="invite-link"><button class="btn" type="button" data-act="copy-invite">Copy link</button></div>
        <div class="btn-row"><button class="btn danger" type="button" data-act="cancel">Cancel deal</button></div></div>`);
    } else {
      p.push(html`<div class="panel stack"><h2>Review the contract</h2>
        <p class="muted">${cl} will hold ${money(v.amount)} in PayPal. It's released to ${v.freelancer.paypalEmail} automatically when your work passes every required criterion below. Accept only if they're fair and clear.</p>
        <div class="btn-row"><button class="btn primary" type="button" data-act="accept">Accept criteria</button></div></div>`);
    }
  }

  if (v.status === 'awaiting_funding') {
    if (r === 'client') {
      p.push(html`<div class="panel stack"><h2>Hold ${money(v.amount)} with PayPal</h2>
        <p class="muted">You approve an authorization: the money is reserved in your PayPal account, not charged. It's captured only when the work passes, or when you approve it yourself. If the deal is cancelled, the hold is voided.</p>
        ${CONFIG.paypalMode === 'sandbox'
          ? html`<p class="small muted">Sign in with a PayPal sandbox personal (buyer) account.</p><div id="paypal-buttons"></div>
            <p class="small muted">PayPal window didn't open? <button class="btn quiet" type="button" data-act="pp-redirect">Continue to PayPal in this tab</button></p>`
          : html`<div class="callout seal"><h3>Simulated PayPal</h3><p class="small">No PayPal keys are configured, so the built-in simulator stands in for the PayPal approval window. Add sandbox keys to use real PayPal.</p></div>
            <div class="btn-row"><button class="btn primary" type="button" data-act="sim-fund">Approve hold with simulated PayPal</button><button class="btn danger" type="button" data-act="cancel">Cancel deal</button></div>`}
      </div>`);
    } else {
      p.push(html`<div class="panel"><h2>Waiting for ${cl} to hold the money</h2><p class="muted" style="margin-top:6px">You'll be able to submit work once ${money(v.amount)} is on hold in PayPal. Don't start before then.</p></div>`);
    }
  }

  if (a.includes('submit')) {
    const origin = location.origin;
    p.push(html`<form class="panel stack" data-form="submit">
      <h2>${v.submissions.length ? 'Submit a new attempt' : 'Submit your work'}</h2>
      <p class="muted">${money(v.amount)} is on hold. Verdict checks your work against the contract right away. ${v.attemptsLeft} of ${v.maxAttempts} attempts left.</p>
      <label class="field">Live URL of the deliverable<input type="url" name="url" required data-keep="url" placeholder="https://your-site.example.com"></label>
      <label class="field">GitHub repository <span class="hint">Optional. Lets Verdict review code and repo criteria.</span><input type="url" name="repoUrl" data-keep="repoUrl" placeholder="https://github.com/you/project"></label>
      <label class="field">Note to the client <span class="hint">Optional</span><input type="text" name="note" data-keep="note" maxlength="1000"></label>
      <div class="stack" style="gap:8px"><span class="small muted">Sample deliverables for the demo</span><div class="samples">
        <button class="btn" type="button" data-act="sample" data-url="${origin}/samples/bakery-v1/">Incomplete site</button>
        <button class="btn" type="button" data-act="sample" data-url="${origin}/samples/bakery-v2/">Finished site</button>
        <button class="btn" type="button" data-act="sample" data-url="${origin}/samples/bakery-v3/">Site that tries to trick the AI</button>
      </div></div>
      <div class="btn-row"><button class="btn primary" type="submit">Submit for review</button></div>
    </form>`);
  } else if (r === 'client' && v.status === 'funded') {
    p.push(html`<div class="panel stack"><h2>Money on hold. Waiting for ${fl}'s work</h2><p class="muted">Nothing has been charged. Verdict reviews the work the moment it's submitted.</p>
      ${a.includes('cancel') ? html`<div class="btn-row"><button class="btn danger" type="button" data-act="cancel">Cancel and void the hold</button></div>` : ''}</div>`);
  }

  if (v.status === 'in_review') p.push(html`<div class="panel"><h2>Reviewing attempt ${v.submissions.length}</h2><p class="muted" style="margin-top:6px">Measured checks run first, then the arbiter rules on the rest. This usually takes under a minute.</p></div>`);
  if (v.status === 'changes_requested' && r === 'client') p.push(html`<div class="panel"><h2>${fl} is fixing the work</h2><p class="muted" style="margin-top:6px">Your ${money(v.amount)} stays on hold. You're not charged unless the work passes.</p></div>`);

  if (a.includes('escalate')) {
    p.push(html`<form class="panel stack" data-form="escalate"><h3>Think the verdict is wrong?</h3>
      <p class="muted small">Send it to ${cl} for a human decision. The evidence goes with it.</p>
      <label class="field">Why<input type="text" name="reason" data-keep="reason" maxlength="1000" placeholder="The pricing section is there, under 'This week's bakes'."></label>
      <div class="btn-row"><button class="btn" type="submit">Ask for human review</button></div></form>`);
  }

  if (v.status === 'escalated') {
    const last = v.submissions[v.submissions.length - 1];
    if (r === 'client') {
      p.push(html`<form class="panel stack" data-form="resolve"><h2>Your decision</h2>
        <p class="muted">${v.escalation ? html`${fl} disputed the verdict: <span class="serif">“${v.escalation.reason || 'no reason given'}”</span>` : last?.verdict?.decisionReason || 'Verdict could not decide automatically.'} Read the ruling below, then decide.</p>
        <label class="field">Note <span class="hint">Optional, shown in the audit trail</span><input type="text" name="note" data-keep="rnote" maxlength="500"></label>
        <div class="btn-row">
          <button class="btn primary" type="submit" data-decision="release">Approve and release ${money(v.amount)}</button>
          ${v.attemptsLeft > 0 ? html`<button class="btn" type="submit" data-decision="allow_resubmission">Ask for another attempt</button>` : ''}
          <button class="btn danger" type="submit" data-decision="cancel">Reject and void the hold</button>
        </div></form>`);
    } else {
      p.push(html`<div class="panel"><h2>Waiting for ${cl}'s decision</h2><p class="muted" style="margin-top:6px">The money stays on hold while ${cl} reviews the ruling.</p></div>`);
    }
  }

  if (v.status === 'releasing') p.push(html`<div class="panel"><h2>Releasing payment</h2><p class="muted" style="margin-top:6px">Capturing the hold and sending the PayPal payout.</p></div>`);

  if (v.status === 'settlement_failed') {
    p.push(html`<div class="panel stack"><h2>The payment release didn't go through</h2><p class="muted">${v.settlementError}</p>
      ${r === 'client' ? html`<div class="btn-row"><button class="btn primary" type="button" data-act="retry">Retry release</button></div>` : html`<p class="muted small">${cl} can retry the release.</p>`}</div>`);
  }

  if (v.status === 'released') {
    const pay = v.paypal;
    p.push(html`<div class="panel stack"><div class="callout pass"><h3>${r === 'freelancer' ? `You've been paid ${money(pay.payoutAmount || v.amount)}` : `${fl} has been paid`}</h3>
      <p class="small">${v.releasedBy === 'verdict' ? 'Released automatically: every required criterion passed.' : `Released by ${cl} after human review.`} PayPal payout to ${v.freelancer.paypalEmail} is ${String(pay.payoutStatus || 'pending').toLowerCase()}.</p></div></div>`);
  }

  if (v.status === 'cancelled') p.push(html`<div class="panel"><h2>Deal cancelled</h2><p class="muted" style="margin-top:6px">${v.paypal.authorizationId ? 'The PayPal hold was voided. The client was never charged.' : 'No money was held.'}</p></div>`);

  return p;
}

// ---------------------------------------------------------------- PayPal JS SDK (sandbox mode)
let sdkPromise = null;
function loadPayPalSDK() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(CONFIG.paypalClientId)}&currency=${CONFIG.currency}&intent=authorize&components=buttons`;
    s.onload = () => resolve(window.paypal);
    s.onerror = () => { sdkPromise = null; reject(new Error('Could not load PayPal. Check your connection or ad blocker.')); };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

async function mountPayPal(v) {
  const host = $('#paypal-buttons');
  if (!host || CONFIG.paypalMode !== 'sandbox') return;
  const tok = Tokens.get(v.id).client;
  try {
    const paypal = await loadPayPalSDK();
    if (!host.isConnected) return;
    host.innerHTML = '';
    await paypal.Buttons({
      style: { layout: 'vertical', shape: 'rect', label: 'paypal' },
      createOrder: async () => (await api('POST', `/api/deals/${v.id}/paypal/order`, {}, tok)).orderId,
      onApprove: async (data) => {
        const view = await api('POST', `/api/deals/${v.id}/paypal/authorize`, { orderId: data.orderID }, tok);
        toast(`${money(v.amount)} is on hold in PayPal`);
        paint(view);
      },
      onCancel: () => toast('PayPal window closed. Nothing was held.'),
      onError: (err) => toast(err?.message || 'PayPal reported an error.', 'error'),
    }).render(host);
  } catch (err) {
    host.innerHTML = html`<div class="callout fail"><p class="small">${err.message}</p></div>`.s;
  }
}

// ---------------------------------------------------------------- events
main.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = D.id;
  const role = id && Tokens.active(id);
  const tok = id && Tokens.get(id)[role];
  const post = (path, body) => api('POST', `/api/deals/${id}/${path}`, body || {}, tok);

  if (act === 'compile') {
    const f = $('#new-deal');
    return busy(btn, async () => {
      const out = await api('POST', '/api/criteria/compile', { title: f.elements.title.value, description: f.elements.description.value });
      draft = { criteria: out.criteria, source: out.source };
      renderDraftCriteria();
      toast(out.notice || `Drafted ${out.criteria.length} criteria`);
    });
  }
  if (act === 'remove-crit') { draft.criteria.splice(Number(btn.dataset.i), 1); draft.source = 'edited'; return renderDraftCriteria(); }
  if (act === 'role') { Tokens.setActive(id, btn.dataset.role); D.sig = ''; return renderDeal(id, { silent: true }); }
  if (act === 'copy-invite') {
    const input = $('#invite-link');
    try { await navigator.clipboard.writeText(input.value); toast('Invite link copied'); } catch { input.select(); toast('Select the link and copy it'); }
    return;
  }
  if (act === 'sample') {
    const form = btn.closest('form');
    form.url.value = btn.dataset.url;
    form.url.focus();
    return;
  }
  if (act === 'accept') return busy(btn, async () => { paint(await post('accept')); toast('Criteria accepted. The contract is locked.'); });
  if (act === 'cancel') {
    if (!confirm('Cancel this deal? Any PayPal hold will be voided.')) return;
    return busy(btn, async () => { paint(await post('cancel')); toast('Deal cancelled'); });
  }
  if (act === 'retry') return busy(btn, async () => paint(await post('retry-settlement')));
  if (act === 'pp-redirect') {
    return busy(btn, async () => {
      const order = await post('paypal/order', { redirect: true });
      if (!order.approveUrl) throw new Error('PayPal did not return a checkout link.');
      location.href = order.approveUrl;
    });
  }
  if (act === 'sim-fund') {
    return busy(btn, async () => {
      const order = await post('paypal/order');
      // Stand-in for the buyer approving in the PayPal window.
      const r = await fetch(`/paypal-sim/simulate/approve/${encodeURIComponent(order.orderId)}`, { method: 'POST' });
      if (!r.ok) throw new Error('Simulated approval failed.');
      paint(await post('paypal/authorize', { orderId: order.orderId }));
      toast(`${money(D.view.amount)} is on hold`);
    });
  }
});

main.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.critTitle !== undefined) { draft.criteria[Number(t.dataset.critTitle)].title = t.value; draft.source = 'edited'; }
  if (t.dataset.critReq !== undefined) { draft.criteria[Number(t.dataset.critReq)].required = t.checked; draft.source = 'edited'; }
});

main.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const submitter = e.submitter;
  if (form.id === 'new-deal') {
    const f = form;
    return busy(submitter, async () => {
      const out = await api('POST', '/api/deals', {
        title: f.elements.title.value, description: f.elements.description.value, amount: f.elements.amount.value,
        clientName: f.clientName.value, freelancerName: f.freelancerName.value, freelancerEmail: f.freelancerEmail.value,
        criteria: draft.criteria, criteriaSource: draft.source,
      });
      Tokens.set(out.deal.id, 'client', out.clientToken);
      // Demo convenience: keep the freelancer link too, so one person can play both sides.
      Tokens.set(out.deal.id, 'freelancer', out.freelancerToken);
      Tokens.setActive(out.deal.id, 'client');
      location.hash = `#/deal/${out.deal.id}`;
    });
  }
  const id = D.id;
  const tok = Tokens.get(id)[Tokens.active(id)];
  const post = (path, body) => api('POST', `/api/deals/${id}/${path}`, body || {}, tok);
  if (form.dataset.form === 'submit') {
    return busy(submitter, async () => {
      paint(await post('submissions', { url: form.url.value, repoUrl: form.repoUrl.value, note: form.note.value }));
      toast('Submitted. Verdict is reviewing it now.');
    });
  }
  if (form.dataset.form === 'escalate') return busy(submitter, async () => { paint(await post('escalate', { reason: form.reason.value })); toast('Sent for human review'); });
  if (form.dataset.form === 'resolve') {
    const decision = submitter?.dataset.decision;
    if (decision === 'cancel' && !confirm('Reject the work and void the hold?')) return;
    return busy(submitter, async () => { paint(await post('resolve', { decision, note: form.note.value })); toast({ release: 'Payment released', cancel: 'Hold voided', allow_resubmission: 'Another attempt allowed' }[decision]); });
  }
});

window.addEventListener('hashchange', route);
loadConfig()
  .then(route)
  .catch((err) => { main.innerHTML = html`<div class="page-head"><h1 style="font-size:30px">Verdict can't reach its server</h1><p class="lede">${err.message}</p></div>`.s; });
