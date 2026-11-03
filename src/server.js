import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { createPayPalClient, PayPalError } from './paypal.js';
import { createPayPalSimulator } from './paypal-sim.js';
import { createAI } from './ai.js';
import { createDealService, HttpError } from './deals.js';
import { DEMO_BRIEF, serveSample } from './samples.js';
import { createStatic } from './static.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));

export function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const store = new Store(config.dataFile);
  const sim = config.paypal.mode === 'simulated' ? createPayPalSimulator() : null;
  const state = { origin: `http://127.0.0.1:${config.port}` };

  const paypal = createPayPalClient({
    getApiBase: () => (sim ? `${state.origin}/paypal-sim` : config.paypal.apiBase),
    clientId: sim ? 'simulated-client' : config.paypal.clientId,
    clientSecret: sim ? 'simulated-secret' : config.paypal.clientSecret,
    currency: config.paypal.currency,
  });
  const ai = createAI(config.ai);
  const deals = createDealService({ store, paypal, ai, config });

  // ---------------------------------------------------------------- routing
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([\\w-]+)'))}$`);
    routes.push({ method, re, keys, handler });
  };

  const loadDeal = (params) => {
    const deal = store.getDeal(params.id);
    if (!deal) throw new HttpError(404, 'Deal not found.');
    return deal;
  };
  const role = (req, deal) => deals.roleFor(deal, req.headers['x-deal-token']);

  route('GET', '/api/health', () => ({ ok: true }));

  const publicConfig = () => ({
    paypalMode: config.paypal.mode,
    paypalClientId: config.paypal.mode === 'sandbox' ? config.paypal.clientId : null,
    currency: config.paypal.currency,
    aiProvider: ai.provider,
    aiModel: ai.model,
    aiLabel: ai.label,
    platformFeePercent: config.platformFeePercent,
    maxAttempts: config.maxAttempts,
    demoBrief: { ...DEMO_BRIEF, freelancerEmail: process.env.DEMO_FREELANCER_EMAIL || '' },
  });
  route('GET', '/api/config', publicConfig);
  const serveStatic = createStatic(PUBLIC_DIR, { getConfig: publicConfig });

  route('POST', '/api/criteria/compile', async ({ body }) => {
    const description = String(body.description || '').trim();
    if (description.length < 20) throw new HttpError(400, 'Describe the job in at least a sentence or two so criteria can be drafted.');
    try {
      return await ai.compileCriteria({ title: body.title, description: description.slice(0, 6000) });
    } catch (err) {
      throw new HttpError(502, `Could not draft criteria: ${err.message}`);
    }
  });

  route('GET', '/api/deals', ({ query }) => {
    // Only deals the caller holds a token for. Tokens are sent as a comma-separated list.
    const toks = String(query.get('tokens') || '').split(',').filter(Boolean).slice(0, 50);
    return store
      .listDeals()
      .map((d) => ({ d, r: toks.map((t) => deals.roleFor(d, t)).find((r) => r !== 'viewer') }))
      .filter((x) => x.r)
      .map(({ d, r }) => ({ id: d.id, title: d.title, amount: d.amount, status: d.status, statusLabel: deals.STATUS[d.status], role: r, createdAt: d.createdAt }));
  });

  route('POST', '/api/deals', async ({ body }) => {
    const deal = await deals.createDeal(body);
    return { deal: deals.view(deal, 'client'), clientToken: deal.tokens.client, freelancerToken: deal.tokens.freelancer };
  });

  route('GET', '/api/deals/:id', async ({ req, params }) => {
    const deal = loadDeal(params);
    const r = role(req, deal);
    if (r === 'viewer') throw new HttpError(403, 'Open this deal from the link you were given.');
    await deals.refreshPayout(deal);
    return deals.view(deal, r);
  });

  const action = (path, fn) =>
    route('POST', `/api/deals/:id/${path}`, async ({ req, params, body }) => {
      const deal = loadDeal(params);
      const r = role(req, deal);
      if (r === 'viewer') throw new HttpError(403, 'Open this deal from the link you were given.');
      const out = await fn(deal, r, body, req);
      return out && out.id === deal.id ? deals.view(out, r) : out;
    });

  action('accept', (d, r) => deals.accept(d, r));
  const originOf = (req) => `${String(req.headers['x-forwarded-proto'] || 'http').split(',')[0]}://${req.headers.host}`;
  action('paypal/order', (d, r, b, req) => deals.createOrder(d, r, b.redirect ? { returnBase: originOf(req) } : {}));
  action('paypal/authorize', (d, r, b) => deals.authorize(d, r, b.orderId));
  action('submissions', (d, r, b) => deals.submit(d, r, b));
  action('escalate', (d, r, b) => deals.escalate(d, r, b.reason));
  action('resolve', (d, r, b) => deals.resolve(d, r, b));
  action('cancel', (d, r) => deals.cancel(d, r));
  action('retry-settlement', (d, r) => deals.retrySettlement(d, r));

  // ---------------------------------------------------------------- server
  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 256 * 1024) throw new HttpError(413, 'Request body too large.');
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw;
  }

  function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
    res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(body);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const { pathname } = url;
    try {
      if (sim && pathname.startsWith('/paypal-sim/')) {
        const raw = await readBody(req);
        let body = {};
        if (raw && !String(req.headers['content-type']).includes('urlencoded')) body = JSON.parse(raw);
        const out = sim.handle(req, pathname.slice('/paypal-sim'.length), body);
        return send(res, out.status, JSON.stringify(out.body), 'application/json', out.headers);
      }

      if (req.method === 'GET' && pathname === '/paypal/return') {
        const deal = store.getDeal(String(url.searchParams.get('deal') || ''));
        if (!deal) return send(res, 404, 'Deal not found', 'text/plain');
        try {
          if (!url.searchParams.get('cancelled')) await deals.authorizeReturn(deal, String(url.searchParams.get('token') || ''));
        } catch (err) {
          console.error('PayPal return:', err.message);
        }
        res.writeHead(302, { Location: `/#/deal/${deal.id}` });
        return res.end();
      }

      const sample = serveSample(pathname);
      if (sample) return send(res, sample.status, sample.body, sample.type);

      if (pathname.startsWith('/api/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = pathname.match(r.re);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
          let body = {};
          if (req.method === 'POST') {
            const raw = await readBody(req);
            try {
              body = raw ? JSON.parse(raw) : {};
            } catch {
              throw new HttpError(400, 'Request body must be JSON.');
            }
          }
          const out = await r.handler({ req, params, body, query: url.searchParams });
          return send(res, 200, JSON.stringify(out));
        }
        throw new HttpError(404, 'Not found.');
      }

      if (serveStatic(req, res, pathname, { fallbackToIndex: !extname(pathname) })) return;
      send(res, 404, 'Not found', 'text/plain');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof PayPalError ? 502 : 500;
      const message = err instanceof PayPalError ? `PayPal: ${err.message}` : status === 500 ? 'Something went wrong on the server.' : err.message;
      if (status === 500) console.error(err);
      send(res, status, JSON.stringify({ error: message, debugId: err.debugId }));
    }
  });

  return {
    config,
    store,
    deals,
    server,
    async listen(port = config.port, host = config.host) {
      await new Promise((r) => server.listen(port, host, r));
      const actual = server.address().port;
      state.origin = `http://127.0.0.1:${actual}`;
      return actual;
    },
    async close() {
      await deals.idle();
      await new Promise((r) => server.close(r));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = await app.listen();
  const c = app.config;
  console.log(`\n  Verdict is running at http://localhost:${port}`);
  console.log(`  PayPal: ${c.paypal.mode === 'sandbox' ? 'sandbox (real PayPal API)' : 'simulated (set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for the real sandbox)'}`);
  console.log(`  AI:     ${c.ai.provider === 'anthropic' ? `Claude (${c.ai.model})` : c.ai.provider === 'gemini' ? `Gemini (${c.ai.geminiModels[0]})` : 'offline heuristics (set GEMINI_API_KEY or ANTHROPIC_API_KEY)'}\n`);
}
