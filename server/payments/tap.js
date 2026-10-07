// Tap Payments adapter (https://developers.tap.company), written against the official docs:
//   POST {base}/charges            create a charge; response.transaction.url is Tap's HOSTED checkout page,
//                                   so card numbers never touch this server
//   GET  {base}/charges/{id}       retrieve a charge (authoritative status, used to verify webhooks)
//   POST {base}/refunds            full or partial refund; reference.idempotent prevents duplicates
//   GET  {base}/destination/{id}   marketplace destination (restaurant sub-merchant)
//   Webhook header "hashstring" = HMAC-SHA256(secret key, "x_id{id}x_amount{amount}x_currency{currency}
//   x_gateway_reference{gateway}x_payment_reference{payment}x_status{status}x_created{created}")
//
//   POST {base}/tokens             token from a saved card (card-on-file, merchant-initiated renewals)
//   POST {base}/payouts/list/      READ-ONLY listing of the payouts Tap itself made to business bank accounts
//
// What Tap's official documentation says about money movement (read 2026-10-07, see docs/PAYMENTS.md):
//   * settlement to a restaurant's bank is performed BY TAP (automatic after KYC), or from Tap's dashboard when auto
//     settlement is disabled for the business. No API call creates a payout, so this adapter has no createPayout.
//   * payouts can be retrieved through the Payouts API; no payout/settlement/KYC webhook is documented.
//   * `GET /destination/{id}` returns identifiers only (no KYC or status field).
//
// UNVERIFIED against a live/sandbox Tap account (no credentials were available when this was written). Everything that
// decides money state is therefore re-checked through the authenticated API rather than trusted from a webhook body.
const crypto = require('node:crypto');
const { toDecimalString, fromDecimalString } = require('../services/money');

// Charge statuses documented/returned by Tap. Only CAPTURED means money was taken.
const SUCCESS = new Set(['CAPTURED']);
const FAILURE = new Set(['FAILED', 'DECLINED', 'CANCELLED', 'ABANDONED', 'VOID', 'RESTRICTED', 'TIMEDOUT']);

const num = (cents) => Number(toDecimalString(cents)); // 1999 -> 19.99 (exact for 2-decimal currencies)

// Tap documents these refund reasons; free text from our admins is kept in OUR database only.
const REFUND_REASONS = new Set(['duplicate', 'fraudulent', 'requested_by_customer']);

// "+966 50 123 4567" / "0501234567" -> { country_code: '966', number: '501234567' } (Saudi default)
function splitPhone(raw) {
  const d = String(raw || '').replace(/[^\d]/g, '').replace(/^00/, '');
  if (d.length < 8) return null;
  if (d.startsWith('966')) return { country_code: '966', number: d.slice(3) };
  if (d.startsWith('0')) return { country_code: '966', number: d.slice(1) };
  return { country_code: '966', number: d };
}

// Tap payout statuses are not enumerated in the documentation (only "PAID_OUT" appears in an example), so anything we
// cannot classify stays 'unknown' and is never treated as money received.
function classifyPayoutStatus(raw) {
  const v = String(raw || '').toUpperCase();
  if (v === 'PAID_OUT') return 'paid';
  if (/FAIL|REJECT|CANCEL|REVERS|RETURN/.test(v)) return 'failed';
  if (/PEND|PROCESS|INITIAT|SCHEDUL/.test(v)) return 'processing';
  return 'unknown';
}

function createTapProvider(cfg, ProviderError) {
  const { secretKey, apiBase, merchantId, webhookSecret } = cfg.payment;

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(`${apiBase}${path}`, {
        method,
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new ProviderError(`Payment provider unreachable: ${e.name}`, { retryable: true, code: 'provider_unreachable' });
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const msg = json?.errors?.[0]?.description || json?.message || `HTTP ${res.status}`;
      throw new ProviderError(`Payment provider rejected the request: ${msg}`, { status: res.status, retryable: res.status >= 500, code: 'provider_error' });
    }
    return json || {};
  }

  const amountToCents = (amount) => {
    const c = fromDecimalString(typeof amount === 'number' ? amount.toFixed(2) : String(amount));
    if (c === null) throw new ProviderError('Provider returned an unreadable amount', { code: 'provider_bad_response' });
    return c;
  };

  return {
    name: 'tap',
    enabled: Boolean(secretKey),

    // Used for BOTH customer order payments (pay_/ord_ references) and restaurant SaaS invoices (sub_/inv_ references).
    async createCharge({ paymentId, orderId, referenceTransaction, referenceOrder, amountCents, currency, customer, destination, description, returnUrl, webhookUrl, saveCard = false }) {
      const body = {
        amount: num(amountCents),
        currency,
        customer_initiated: true,
        threeDSecure: true,
        save_card: Boolean(saveCard), // card-on-file for renewals; Tap requires the customer's phone number for this
        description,
        reference: { transaction: referenceTransaction || `pay_${paymentId}`, order: referenceOrder || `ord_${orderId}` },
        receipt: { email: false, sms: false },
        customer: { first_name: customer.firstName, email: customer.email, ...(splitPhone(customer.phone) ? { phone: splitPhone(customer.phone) } : {}) },
        source: { id: 'src_all' }, // lets the customer choose any method enabled on the Tap account (cards, mada, Apple Pay, ...)
        post: { url: webhookUrl },
        redirect: { url: returnUrl },
        ...(merchantId ? { merchant: { id: merchantId } } : {}),
      };
      if (destination && destination.amountCents > 0) {
        body.destinations = { destination: [{ id: destination.id, amount: num(destination.amountCents), currency }] };
      }
      const r = await api('POST', '/charges', body);
      const url = r.transaction?.url;
      if (!r.id || !url) throw new ProviderError('Provider response did not include a checkout URL', { code: 'provider_bad_response' });
      return { providerTransactionId: r.id, redirectUrl: url, status: r.status || 'INITIATED' };
    },

    async retrieveCharge(id) {
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new ProviderError('Invalid charge id', { code: 'bad_request' });
      const r = await api('GET', `/charges/${encodeURIComponent(id)}`);
      return {
        id: r.id,
        status: String(r.status || '').toUpperCase(),
        amountCents: amountToCents(r.amount),
        currency: String(r.currency || '').toUpperCase(),
        orderRef: r.reference?.order || null,
        source: typeof r.source?.payment_method === 'string' ? r.source.payment_method : null,
        failureReason: r.response?.message || null,
        // present when the charge saved a card (documented: card.id, customer.id, payment_agreement.id)
        card: r.card?.id ? { id: r.card.id, last4: r.card.last_four || null, brand: r.card.brand || null } : null,
        customerId: r.customer?.id || null,
        agreementId: r.payment_agreement?.id || null,
        destinations: r.destinations || null,
        isSuccess: SUCCESS.has(String(r.status || '').toUpperCase()),
        isFailure: FAILURE.has(String(r.status || '').toUpperCase()),
      };
    },

    async createRefund({ providerTransactionId, amountCents, currency, reason, idempotencyKey, destination, webhookUrl }) {
      const body = {
        charge_id: providerTransactionId,
        amount: num(amountCents),
        currency,
        reason: REFUND_REASONS.has(reason) ? reason : 'requested_by_customer',
        reference: { merchant: idempotencyKey, idempotent: idempotencyKey },
        post: { url: webhookUrl },
      };
      if (destination && destination.amountCents > 0) {
        body.destinations = { destination: [{ id: destination.id, amount: num(destination.amountCents), currency }] };
      }
      const r = await api('POST', '/refunds', body);
      const st = String(r.status || '').toUpperCase();
      if (st === 'REFUNDED') return { providerRefundId: r.id, status: 'succeeded' };
      if (['FAILED', 'DECLINED', 'CANCELLED', 'RESTRICTED'].includes(st)) {
        return { providerRefundId: r.id || null, status: 'failed', failureReason: r.response?.message || st };
      }
      return { providerRefundId: r.id || null, status: 'pending' };
    },

    async retrieveDestination(id) {
      const r = await api('GET', `/destination/${encodeURIComponent(id)}`);
      // documented fields: id, display_name, business_entity_id, wallet_id, business_id, live_mode. There is NO status/KYC field.
      return { id: r.id, displayName: r.display_name || null, businessId: r.business_id || null, walletId: r.wallet_id || null, businessEntityId: r.business_entity_id || null, liveMode: Boolean(r.live_mode) };
    },

    // Merchant-initiated renewal with a saved card (documented recurring flow): token from the saved card, then a charge
    // with customer_initiated=false and the payment agreement. Only provider-issued ids are used; no card data is held.
    async chargeSavedCard({ customerId, cardId, agreementId, referenceTransaction, referenceOrder, amountCents, currency, description, webhookUrl, idempotencyKey }) {
      const tok = await api('POST', '/tokens', { saved_card: { card_id: cardId, customer_id: customerId }, client_ip: '127.0.0.1' });
      if (!tok.id) throw new ProviderError('Provider did not return a card token', { code: 'provider_bad_response' });
      const body = {
        amount: num(amountCents), currency, customer_initiated: false, threeDSecure: false, save_card: false, description,
        reference: { transaction: referenceTransaction, order: referenceOrder, idempotent: idempotencyKey },
        receipt: { email: false, sms: false }, customer: { id: customerId }, source: { id: tok.id },
        payment_agreement: { id: agreementId }, post: { url: webhookUrl },
        ...(merchantId ? { merchant: { id: merchantId } } : {}),
      };
      const r = await api('POST', '/charges', body);
      if (!r.id) throw new ProviderError('Provider response did not include a charge id', { code: 'provider_bad_response' });
      return { providerTransactionId: r.id, status: String(r.status || '').toUpperCase() };
    },

    async getPayout(id) {
      const [p] = await this.listPayouts({ merchantIds: merchantId ? [merchantId] : [], payoutIds: [id] });
      if (!p) throw new ProviderError('Payout not found', { status: 404, code: 'not_found' });
      return p;
    },

    // Read-only: the payouts Tap made to businesses' banks. Amount units are not documented, so the amount is returned as
    // reported text and never used in arithmetic.
    async listPayouts({ merchantIds = [], payoutIds = null } = {}) {
      const r = await api('POST', '/payouts/list/', { merchants: merchantIds, ...(payoutIds ? { payouts: { payout_id: payoutIds } } : {}) });
      return (r.payouts || []).map((p) => ({
        id: String(p.id), statusRaw: String(p.status || ''), status: classifyPayoutStatus(p.status), amountText: String(p.amount ?? ''),
        currency: p.currency ? String(p.currency).toUpperCase() : null, merchantId: p.merchant_id || null, walletId: p.wallet?.id || null,
        date: Number.isFinite(Number(p.date)) ? new Date(Number(p.date)).toISOString() : null, raw: p,
      }));
    },

    // Constant-time check of Tap's "hashstring" header for charge webhooks.
    verifyWebhook(headers, body) {
      const received = String(headers.hashstring || headers.Hashstring || '').trim().toLowerCase();
      if (!received || !body || typeof body !== 'object' || !webhookSecret) return false;
      let amount;
      try { amount = toDecimalString(amountToCents(body.amount)); } catch { return false; }
      const msg = `x_id${body.id}x_amount${amount}x_currency${body.currency}`
        + `x_gateway_reference${body.reference?.gateway ?? ''}x_payment_reference${body.reference?.payment ?? ''}`
        + `x_status${body.status}x_created${body.transaction?.created ?? body.created ?? ''}`;
      const expected = crypto.createHmac('sha256', webhookSecret).update(msg).digest('hex');
      const a = Buffer.from(expected);
      const b = Buffer.from(received);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}

module.exports = { createTapProvider, SUCCESS, FAILURE, classifyPayoutStatus, splitPhone };
