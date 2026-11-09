import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env without any dependency (Node >= 20.12 / 21.7 ships process.loadEnvFile).
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
}

const bool = (v, fallback) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v));

/**
 * Build the runtime configuration. Everything can be overridden (used by tests).
 * With no keys at all, Verdict runs fully offline: a simulated PayPal and heuristic AI.
 */
export function loadConfig(overrides = {}) {
  const env = { ...process.env, ...(overrides.env || {}) };
  const paypalClientId = env.PAYPAL_CLIENT_ID || '';
  const paypalSecret = env.PAYPAL_CLIENT_SECRET || '';
  const anthropicKey = env.ANTHROPIC_API_KEY || '';
  const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
  const isProd = env.NODE_ENV === 'production';

  const config = {
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    dataFile: resolve(env.DATA_FILE || './data/verdict.json'),
    platformFeePercent: Math.min(Math.max(Number(env.PLATFORM_FEE_PERCENT || 0), 0), 20),
    maxAttempts: Math.max(Number(env.MAX_REVIEW_ATTEMPTS || 3), 1),
    // Optional pause between checks so a live demo shows each criterion being decided.
    reviewStepDelayMs: Math.min(Math.max(Number(env.REVIEW_STEP_DELAY_MS || 0), 0), 5000),
    allowPrivateUrls: bool(env.ALLOW_PRIVATE_URLS, !isProd),
    paypal: {
      mode: paypalClientId && paypalSecret ? 'sandbox' : 'simulated',
      clientId: paypalClientId,
      clientSecret: paypalSecret,
      apiBase: env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com',
      currency: 'USD',
    },
    ai: {
      provider: anthropicKey ? 'anthropic' : geminiKey ? 'gemini' : 'heuristic',
      apiKey: anthropicKey,
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      apiBase: env.ANTHROPIC_API_BASE || 'https://api.anthropic.com',
      timeoutMs: Number(env.AI_TIMEOUT_MS || 90000),
      geminiKey,
      geminiApiBase: env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com',
      // Tried in order. A busy (429/503) or missing model hands off to the next one.
      geminiTimeoutMs: Number(env.GEMINI_TIMEOUT_MS || 15000),
      geminiModels: (env.GEMINI_MODEL || 'gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.8-flash,gemini-2.5-flash').split(',').map((m) => m.trim()).filter(Boolean),
    },
    github: { token: env.GITHUB_TOKEN || '' },
  };

  return deepMerge(config, overrides.config || {});
}

function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) target[k] = deepMerge(target[k] || {}, v);
    else target[k] = v;
  }
  return target;
}
