import { randomBytes } from 'node:crypto';

/**
 * A faithful-enough PayPal simulator so Verdict runs end to end with zero keys.
 * It implements the same REST paths and response shapes the real client uses.
 * Only mounted when PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not configured.
 */
const id = (prefix, n = 17) => prefix + randomBytes(n).toString('hex').toUpperCase().slice(0, n);

export function createPayPalSimulator() {
  const orders = new Map();
  const auths = new Map();
  const payouts = new Map();
  const idem = new Map();
  const tokens = new Set();

  const json = (status, body, headers = {}) => ({ status, body, headers: { 'paypal-debug-id': id('sim', 13).toLowerCase(), ...headers } });
  const error = (status, name, issue, description) =>
    json(status, { name, message: description, details: [{ issue, description }] });

  function authed(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') && tokens.has(h.slice(7));
  }

  function withIdempotency(req, fn) {
    const key = req.headers['paypal-request-id'];
    if (key && idem.has(key)) return idem.get(key);
    const result = fn();
    if (key && result.status < 400) idem.set(key, result);
    return result;
  }

  /** Returns {status, body, headers} or null when the path is not a simulator path. */
  function handle(req, path, body) {
    const m = req.method;

    if (m === 'POST' && path === '/v1/oauth2/token') {
      const t = id('A21', 40);
      tokens.add(t);
      return json(200, { access_token: t, token_type: 'Bearer', expires_in: 32400, app_id: 'APP-SIMULATED' });
    }

    // Used by the UI in simulated mode to stand in for the PayPal approval popup.
    let mm = path.match(/^\/simulate\/approve\/([\w-]+)$/);
    if (m === 'POST' && mm) {
      const order = orders.get(mm[1]);
      if (!order) return error(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Order not found.');
      order.status = 'APPROVED';
      order.payer = { email_address: 'client-buyer@personal.example.com', payer_id: id('PAYER', 13) };
      return json(200, { id: order.id, status: order.status });
    }

    if (!authed(req)) return json(401, { name: 'AUTHENTICATION_FAILURE', message: 'Authentication failed due to invalid authentication credentials.' });

    if (m === 'POST' && path === '/v2/checkout/orders') {
      return withIdempotency(req, () => {
        if (body?.intent !== 'AUTHORIZE' && body?.intent !== 'CAPTURE') return error(400, 'INVALID_REQUEST', 'INVALID_PARAMETER_VALUE', 'intent is invalid.');
        const order = { id: id('SIM', 17), intent: body.intent, status: 'CREATED', purchase_units: body.purchase_units, create_time: new Date().toISOString() };
        orders.set(order.id, order);
        return json(201, {
          ...order,
          links: [{ rel: 'approve', href: `simulated://approve/${order.id}`, method: 'GET' }],
        });
      });
    }

    mm = path.match(/^\/v2\/checkout\/orders\/([\w-]+)$/);
    if (m === 'GET' && mm) {
      const order = orders.get(mm[1]);
      if (!order) return error(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Specified resource ID does not exist.');
      return json(200, order);
    }

    mm = path.match(/^\/v2\/checkout\/orders\/([\w-]+)\/authorize$/);
    if (m === 'POST' && mm) {
      return withIdempotency(req, () => {
        const order = orders.get(mm[1]);
        if (!order) return error(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Specified resource ID does not exist.');
        if (order.status === 'COMPLETED') return error(422, 'UNPROCESSABLE_ENTITY', 'ORDER_ALREADY_AUTHORIZED', 'Order already authorized.');
        if (order.status !== 'APPROVED') return error(422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED', 'Payer has not yet approved the Order for payment.');
        const unit = order.purchase_units[0];
        const auth = {
          id: id('SIMAUTH', 17),
          status: 'CREATED',
          amount: unit.amount,
          custom_id: unit.custom_id,
          expiration_time: new Date(Date.now() + 29 * 24 * 3600 * 1000).toISOString(),
          create_time: new Date().toISOString(),
        };
        auths.set(auth.id, auth);
        order.status = 'COMPLETED';
        order.purchase_units = [{ ...unit, payments: { authorizations: [auth] } }];
        return json(201, order);
      });
    }

    mm = path.match(/^\/v2\/payments\/authorizations\/([\w-]+)(\/(capture|void))?$/);
    if (mm) {
      const auth = auths.get(mm[1]);
      if (!auth) return error(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Specified resource ID does not exist.');
      const action = mm[3];
      if (m === 'GET' && !action) return json(200, auth);
      if (m === 'POST' && action === 'capture') {
        return withIdempotency(req, () => {
          if (auth.status === 'CAPTURED') return error(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_ALREADY_CAPTURED', 'Authorization has been previously captured.');
          if (auth.status === 'VOIDED') return error(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_VOIDED', 'A voided authorization cannot be captured.');
          auth.status = 'CAPTURED';
          return json(201, { id: id('SIMCAP', 17), status: 'COMPLETED', amount: auth.amount, final_capture: true, invoice_id: body?.invoice_id });
        });
      }
      if (m === 'POST' && action === 'void') {
        return withIdempotency(req, () => {
          if (auth.status === 'CAPTURED') return error(422, 'UNPROCESSABLE_ENTITY', 'PREVIOUSLY_CAPTURED', 'Authorization has been previously captured.');
          auth.status = 'VOIDED';
          return json(200, { id: auth.id, status: 'VOIDED' });
        });
      }
    }

    if (m === 'POST' && path === '/v1/payments/payouts') {
      return withIdempotency(req, () => {
        const sid = body?.sender_batch_header?.sender_batch_id;
        if (!sid || !body.items?.length) return error(400, 'VALIDATION_ERROR', 'MISSING_REQUIRED_PARAMETER', 'Invalid request.');
        if ([...payouts.values()].some((p) => p.sender_batch_id === sid)) {
          return error(400, 'USER_BUSINESS_ERROR', 'SENDER_BATCH_ID_ALREADY_EXISTS', 'Batch with given sender_batch_id already exists.');
        }
        const batch = { payout_batch_id: id('SIMPO', 13), batch_status: 'PENDING', sender_batch_id: sid, items: body.items };
        payouts.set(batch.payout_batch_id, batch);
        // Real payouts settle asynchronously; the simulator flips to SUCCESS shortly after.
        setTimeout(() => (batch.batch_status = 'SUCCESS'), 300).unref?.();
        return json(201, { batch_header: { payout_batch_id: batch.payout_batch_id, batch_status: 'PENDING', sender_batch_header: body.sender_batch_header } });
      });
    }

    mm = path.match(/^\/v1\/payments\/payouts\/([\w-]+)$/);
    if (m === 'GET' && mm) {
      const batch = payouts.get(mm[1]);
      if (!batch) return error(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Batch not found.');
      return json(200, {
        batch_header: { payout_batch_id: batch.payout_batch_id, batch_status: batch.batch_status },
        items: batch.items.map((it) => ({ transaction_status: batch.batch_status === 'SUCCESS' ? 'SUCCESS' : 'PENDING', payout_item: it })),
      });
    }

    return error(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', `No simulator route for ${m} ${path}`);
  }

  return { handle };
}
