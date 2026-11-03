/**
 * Minimal PayPal REST client for the three primitives Verdict is built on:
 *   1. Orders v2 with intent=AUTHORIZE  -> the client's money is held, not charged
 *   2. Payments v2 capture / void       -> release or cancel that hold
 *   3. Payouts v1                       -> pay the freelancer
 *
 * Works against the PayPal sandbox (https://api-m.sandbox.paypal.com) or the
 * built-in simulator (src/paypal-sim.js), which implements the same endpoints.
 */
export class PayPalError extends Error {
  constructor(message, { status, name, debugId, details } = {}) {
    super(message);
    this.status = status;
    this.paypalName = name;
    this.debugId = debugId;
    this.details = details;
  }
}

export function createPayPalClient({ getApiBase, clientId, clientSecret, currency = 'USD' }) {
  let token = null;
  let tokenExpiresAt = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExpiresAt - 60_000) return token;
    const res = await fetch(`${getApiBase()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new PayPalError(`PayPal authentication failed (${res.status}). Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.`, {
        status: res.status,
        name: data.error,
      });
    }
    token = data.access_token;
    tokenExpiresAt = Date.now() + Number(data.expires_in || 3000) * 1000;
    return token;
  }

  async function call(method, path, body, { requestId } = {}) {
    const headers = {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    // PayPal-Request-Id makes the call idempotent: a retried capture or payout can never double-charge.
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    const res = await fetch(`${getApiBase()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const debugId = res.headers.get('paypal-debug-id') || undefined;
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const issue = data.details?.[0];
      const message = issue ? `${issue.issue}: ${issue.description || data.message}` : data.message || `PayPal returned ${res.status}`;
      throw new PayPalError(message, { status: res.status, name: data.name, debugId, details: data.details });
    }
    return { data, debugId };
  }

  return {
    /** Create an order whose funds will be authorized (held) rather than captured. */
    async createAuthorizeOrder({ dealId, title, amount }) {
      const { data, debugId } = await call(
        'POST',
        '/v2/checkout/orders',
        {
          intent: 'AUTHORIZE',
          purchase_units: [
            {
              reference_id: dealId,
              custom_id: dealId,
              description: `Verdict: ${title}`.slice(0, 127),
              amount: { currency_code: currency, value: amount },
            },
          ],
        },
        { requestId: `order-${dealId}-${Date.now()}` },
      );
      const approveUrl = data.links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action')?.href;
      return { orderId: data.id, status: data.status, approveUrl, debugId };
    },

    /** After the buyer approves, place the hold. Returns the authorization. */
    async authorizeOrder(orderId) {
      const { data, debugId } = await call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {}, {
        requestId: `authorize-${orderId}`,
      });
      const auth = data.purchase_units?.[0]?.payments?.authorizations?.[0];
      if (!auth) throw new PayPalError('PayPal did not return an authorization for this order.', { debugId });
      return {
        authorizationId: auth.id,
        status: auth.status,
        amount: auth.amount,
        expiresAt: auth.expiration_time || null,
        payerEmail: data.payer?.email_address || null,
        debugId,
      };
    },

    async getOrder(orderId) {
      const { data } = await call('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
      return data;
    },

    /** Same hold, but with return URLs so the approval link works outside the JS SDK (used by scripts/sandbox-check.js). */
    async createAuthorizeOrderWithRedirect({ dealId, title, amount, returnUrl, cancelUrl }) {
      const { data, debugId } = await call(
        'POST',
        '/v2/checkout/orders',
        {
          intent: 'AUTHORIZE',
          purchase_units: [{ reference_id: dealId, custom_id: dealId, description: `Verdict: ${title}`.slice(0, 127), amount: { currency_code: currency, value: amount } }],
          payment_source: {
            paypal: { experience_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'CONTINUE', shipping_preference: 'NO_SHIPPING', brand_name: 'Verdict' } },
          },
        },
        { requestId: `order-${dealId}-${Date.now()}` },
      );
      const approveUrl = data.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
      return { orderId: data.id, status: data.status, approveUrl, debugId };
    },

    async getAuthorization(authorizationId) {
      const { data } = await call('GET', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`);
      return data;
    },

    /** Release the hold: move the money to the platform account. */
    async captureAuthorization(authorizationId, { dealId }) {
      const { data, debugId } = await call(
        'POST',
        `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
        { final_capture: true, invoice_id: `VERDICT-${dealId}`, note_to_payer: 'Released by Verdict after all acceptance criteria passed.' },
        { requestId: `capture-${dealId}` },
      );
      return { captureId: data.id, status: data.status, debugId };
    },

    /** Cancel the hold: the client is never charged. */
    async voidAuthorization(authorizationId, { dealId }) {
      const { data, debugId } = await call('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, undefined, {
        requestId: `void-${dealId}`,
      });
      return { status: data.status || 'VOIDED', debugId };
    },

    /** Pay the freelancer from the platform balance. */
    async createPayout({ dealId, attempt, receiverEmail, amount, note }) {
      const { data, debugId } = await call(
        'POST',
        '/v1/payments/payouts',
        {
          sender_batch_header: {
            sender_batch_id: `verdict-${dealId}-${attempt}`,
            email_subject: 'You got paid through Verdict',
            email_message: 'Your work passed every acceptance criterion. The payment has been released.',
          },
          items: [
            {
              recipient_type: 'EMAIL',
              receiver: receiverEmail,
              amount: { value: amount, currency },
              note: note.slice(0, 4000),
              sender_item_id: `${dealId}-${attempt}`,
            },
          ],
        },
        { requestId: `payout-${dealId}-${attempt}` },
      );
      return { payoutBatchId: data.batch_header?.payout_batch_id, batchStatus: data.batch_header?.batch_status, debugId };
    },

    async getPayout(payoutBatchId) {
      const { data } = await call('GET', `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`);
      return { batchStatus: data.batch_header?.batch_status, items: data.items || [] };
    },
  };
}
