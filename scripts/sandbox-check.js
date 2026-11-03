#!/usr/bin/env node
/**
 * Verify Verdict's whole PayPal integration against the REAL PayPal sandbox, in one command:
 *
 *   npm run sandbox-check -- --payout-email <freelancer sandbox email>
 *
 * Steps: OAuth -> create AUTHORIZE order -> you approve it as the sandbox buyer (link printed)
 *        -> authorize (hold) -> capture (release) -> Payouts to the freelancer -> payout status.
 * Add --void to test the cancel path instead of capture + payout.
 * Add --simulate to dry-run the script against the built-in simulator (no keys needed).
 */
import { loadConfig } from '../src/config.js';
import { createPayPalClient } from '../src/paypal.js';
import { createApp } from '../src/server.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const amount = Number(opt('amount', '1.00')).toFixed(2);
const payoutEmail = opt('payout-email', '');
const testVoid = flag('void');
const simulate = flag('simulate');

const ok = (msg, extra = '') => console.log(`  ✓ ${msg}${extra ? `  ${extra}` : ''}`);
const step = (msg) => console.log(`\n${msg}`);
const fail = (msg) => {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
};

let app;
let client;
if (simulate) {
  app = createApp({ env: { PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '', DATA_FILE: `/tmp/verdict-check-${Date.now()}.json` } });
  const port = await app.listen(0, '127.0.0.1');
  client = createPayPalClient({ getApiBase: () => `http://127.0.0.1:${port}/paypal-sim`, clientId: 'sim', clientSecret: 'sim' });
  console.log('Running against the built-in PayPal simulator (--simulate).');
} else {
  const config = loadConfig();
  if (config.paypal.mode !== 'sandbox') fail('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set. Put your sandbox app keys in .env first (see README).');
  client = createPayPalClient({ getApiBase: () => config.paypal.apiBase, clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret });
  console.log(`Checking Verdict against ${config.paypal.apiBase}`);
}
if (!testVoid && !payoutEmail) fail('Pass --payout-email <email of a sandbox Personal account> so the payout has somewhere to go.');

const ref = `check-${Date.now().toString(36)}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  step('1. Create an order with intent AUTHORIZE');
  const order = await client.createAuthorizeOrderWithRedirect({
    dealId: ref,
    title: 'Sandbox check',
    amount,
    returnUrl: 'https://example.com/verdict-approved',
    cancelUrl: 'https://example.com/verdict-cancelled',
  });
  ok('OAuth token accepted and order created', `order ${order.orderId}`);

  step('2. Approve the hold as the sandbox buyer');
  if (simulate) {
    const port = app.server.address().port;
    await fetch(`http://127.0.0.1:${port}/paypal-sim/simulate/approve/${order.orderId}`, { method: 'POST' });
    ok('Approved by the simulator');
  } else {
    console.log(`  Open this link, log in with your sandbox PERSONAL (buyer) account and approve:\n\n    ${order.approveUrl}\n`);
    console.log('  After approving, PayPal sends you to example.com. That is expected; come back here.');
    const started = Date.now();
    for (;;) {
      const o = await client.getOrder(order.orderId);
      if (o.status === 'APPROVED') break;
      if (Date.now() - started > 10 * 60_000) fail('Timed out after 10 minutes waiting for approval.');
      process.stdout.write('.');
      await wait(3000);
    }
    console.log();
    ok('Buyer approved the order');
  }

  step('3. Authorize: put the money on hold');
  const auth = await client.authorizeOrder(order.orderId);
  ok(`$${amount} on hold`, `authorization ${auth.authorizationId}, status ${auth.status}, expires ${auth.expiresAt}`);

  if (testVoid) {
    step('4. Void the hold (cancel path)');
    const v = await client.voidAuthorization(auth.authorizationId, { dealId: ref });
    ok('Hold voided; the buyer is not charged', `status ${v.status}`);
  } else {
    step('4. Capture: release the hold');
    const cap = await client.captureAuthorization(auth.authorizationId, { dealId: ref });
    ok('Captured', `capture ${cap.captureId}, status ${cap.status}`);

    step('5. Pay the freelancer with Payouts');
    const po = await client.createPayout({ dealId: ref, attempt: 1, receiverEmail: payoutEmail, amount, note: 'Verdict sandbox check' });
    ok('Payout created', `batch ${po.payoutBatchId}, status ${po.batchStatus}`);

    step('6. Wait for PayPal to confirm the payout');
    let status = po.batchStatus;
    for (let i = 0; i < 20 && !['SUCCESS', 'DENIED', 'CANCELED'].includes(status); i++) {
      await wait(3000);
      status = (await client.getPayout(po.payoutBatchId)).batchStatus;
    }
    if (status === 'SUCCESS') ok(`Payout SUCCESS: $${amount} sent to ${payoutEmail}`);
    else if (status === 'DENIED') fail('Payout DENIED. Check that Payouts is enabled for this sandbox app and the business account has balance.');
    else console.log(`  … Payout still ${status}. Sandbox payouts can take a minute; check the freelancer account at https://www.sandbox.paypal.com`);
  }

  console.log('\nAll PayPal calls Verdict depends on work with these credentials.\n');
} catch (err) {
  const hint =
    /AUTHORIZATION|authentication failed/i.test(err.message) ? '\n    Check the Client ID and Secret, and that they are the SANDBOX ones.'
    : /NOT_AUTHORIZED|PERMISSION|insufficient/i.test(err.message) ? '\n    The app may be missing a feature. In developer.paypal.com open the app and enable Payouts.'
    : '';
  fail(`${err.message}${err.debugId ? ` (PayPal debug id ${err.debugId})` : ''}${hint}`);
} finally {
  if (app) await app.close();
}
