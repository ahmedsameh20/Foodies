// Payment provider factory and the provider-neutral interface.
//
// The application talks ONLY to this interface. A provider adapter (today: Tap) implements what its official API
// documents; everything it does not implement throws a ProviderError whose code says WHY ('capability_not_verified' or
// 'not_supported'), so a missing capability can never be mistaken for a successful operation.
//
//   createCheckout(args)      hosted checkout for a payment  (adapter: createCharge)
//   verifyPayment(id)/getPayment(id)   authoritative re-fetch  (adapter: retrieveCharge)
//   refundPayment(args)       full / partial refund          (adapter: createRefund)
//   handleWebhook(h, body)    signature verification         (adapter: verifyWebhook)
//   getConnectedAccount(id)   restaurant sub-merchant lookup (adapter: retrieveDestination)
//   createConnectedAccount / getOnboardingLink / getAccountStatus   restaurant onboarding
//   createPayout / getPayout  restaurant payouts initiated by the platform
//   createSubscription / cancelSubscription / getRefund
//
// With PAYMENT_PROVIDER=none card payment is unavailable (cash on delivery only). There is no "fake success" provider in
// production code; test doubles live under tests/ and are injected only by the test harness.
const config = require('../config');
const { createTapProvider } = require('./tap');

class ProviderError extends Error {
  constructor(message, { status, code, retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const INTERFACE = ['listPayouts', 'chargeSavedCard', 'createCheckout', 'verifyPayment', 'getPayment', 'refundPayment', 'handleWebhook', 'getConnectedAccount',
  'createConnectedAccount', 'getOnboardingLink', 'getAccountStatus', 'createPayout', 'getPayout', 'createSubscription', 'cancelSubscription', 'getRefund'];

// Capability levels. Nothing is ever "VERIFIED" in code: that is only established by running the provider's sandbox
// (see docs/PAYMENTS.md for the checklist and the recorded status).
//   IMPLEMENTED_UNVERIFIED  coded from official docs, never run against the provider
//   NOT_VERIFIED            the official documentation did not confirm it; not implemented
//   NOT_SUPPORTED           the provider does not offer it
const ALIASES = {
  createCheckout: 'createCharge', verifyPayment: 'retrieveCharge', getPayment: 'retrieveCharge', refundPayment: 'createRefund',
  handleWebhook: 'verifyWebhook', getConnectedAccount: 'retrieveDestination',
};

function withInterface(adapter, capabilities) {
  const out = { ...adapter, capabilities };
  for (const m of INTERFACE) {
    if (typeof out[m] === 'function') continue;
    if (ALIASES[m] && typeof adapter[ALIASES[m]] === 'function') { out[m] = adapter[ALIASES[m]].bind(adapter); continue; }
    const level = capabilities[m] || 'NOT_VERIFIED';
    out[m] = async () => {
      throw new ProviderError(`${m} is ${level} for provider "${adapter.name}"`, { code: level === 'NOT_SUPPORTED' ? 'not_supported' : 'capability_not_verified' });
    };
  }
  return out;
}

const NONE_ERR = () => new ProviderError('No payment provider is configured', { code: 'provider_disabled' });
function disabledProvider(reason) {
  return withInterface({
    name: 'none', enabled: false, misconfigured: reason || null,
    async createCharge() { throw NONE_ERR(); },
    async chargeSavedCard() { throw NONE_ERR(); },
    async listPayouts() { throw NONE_ERR(); },
    async retrieveCharge() { throw NONE_ERR(); },
    async createRefund() { throw NONE_ERR(); },
    async retrieveDestination() { throw NONE_ERR(); },
    verifyWebhook() { return false; },
  }, {});
}

// Capability levels for Tap, from its official documentation (docs/PAYMENTS.md). Nothing is VERIFIED until the sandbox runner passes.
//   IMPLEMENTED_UNVERIFIED  documented and coded, never run against Tap
//   NOT_SUPPORTED           the documentation shows Tap does NOT offer it (do not build around it)
//   NOT_VERIFIED            not documented / could not be confirmed
const TAP_CAPABILITIES = {
  createCheckout: 'IMPLEMENTED_UNVERIFIED', verifyPayment: 'IMPLEMENTED_UNVERIFIED', getPayment: 'IMPLEMENTED_UNVERIFIED',
  refundPayment: 'IMPLEMENTED_UNVERIFIED', handleWebhook: 'IMPLEMENTED_UNVERIFIED', splitPayments: 'IMPLEMENTED_UNVERIFIED',
  getConnectedAccount: 'IMPLEMENTED_UNVERIFIED',              // GET /destination/{id}: identifiers only
  getAccountStatus: 'NOT_SUPPORTED',                          // TAP KYC STATUS IS NOT AVAILABLE VIA API (destination has no status field)
  accountStatusWebhooks: 'NOT_SUPPORTED',                     // no onboarding/KYC/destination webhook is documented
  createConnectedAccount: 'NOT_VERIFIED',                     // Business/Lead APIs exist but need KYC documents + IBAN; onboarding is done by an admin at Tap
  getOnboardingLink: 'NOT_VERIFIED',                          // no hosted onboarding link is documented
  createPayout: 'NOT_SUPPORTED',                              // settlement is made by Tap (automatic, or from Tap's dashboard); no create-payout API
  getPayout: 'IMPLEMENTED_UNVERIFIED', listPayouts: 'IMPLEMENTED_UNVERIFIED', // POST /payouts/list/ (read-only)
  payoutWebhooks: 'NOT_SUPPORTED',                            // no payout/settlement webhook is documented
  chargeSavedCard: 'IMPLEMENTED_UNVERIFIED',                  // card-on-file merchant-initiated charge (documented flow)
  createSubscription: 'NOT_SUPPORTED', cancelSubscription: 'NOT_SUPPORTED', // no Tap-side scheduler documented: WE schedule renewals
  getRefund: 'NOT_VERIFIED',
  applePay: 'NOT_VERIFIED',   // documented for KSA/SAR but must be enabled by Tap on the merchant account
  googlePay: 'NOT_VERIFIED',  // documented coverage does not list KSA
  mada: 'NOT_VERIFIED',       // source id src_sa.mada documented; enablement per merchant account
  stcPay: 'NOT_VERIFIED',     // SAR/KSA only, no recurring, needs account activation and an OTP step
  usdSettlement: 'NOT_VERIFIED',
};

// What is missing for card payments + marketplace payouts to work, WITHOUT revealing any value.
function paymentConfigStatus(cfg = config) {
  const missing = [];
  const out = (state) => ({ state, provider: cfg.paymentProvider, environment: cfg.paymentEnv, missing });
  if (cfg.paymentProvider === 'none') {
    missing.push('PAYMENT_PROVIDER');
    return out(cfg.isProd ? 'MISCONFIGURED' : 'DISABLED');
  }
  if (!cfg.payment.secretKey) missing.push('TAP_SECRET_KEY');
  if (!cfg.payment.merchantId) missing.push('TAP_MERCHANT_ID');  // merchant.id on charges
  if (!/^https:\/\//.test(cfg.appUrl) && cfg.isProd) missing.push('APP_URL (https)');
  return out(missing.length ? 'MISCONFIGURED' : 'CONFIGURED');
}

function createProvider(cfg = config) {
  if (cfg.paymentProvider === 'tap') {
    // In production a marketplace needs the merchant id; without it card payments stay OFF instead of half-working.
    const st = paymentConfigStatus(cfg);
    if (cfg.isProd && st.state === 'MISCONFIGURED') return disabledProvider(`missing: ${st.missing.join(', ')}`);
    return withInterface(createTapProvider(cfg, ProviderError), TAP_CAPABILITIES);
  }
  return disabledProvider(cfg.isProd ? 'PAYMENT_PROVIDER is not set' : null);
}

module.exports = { createProvider, ProviderError, paymentConfigStatus, INTERFACE, TAP_CAPABILITIES };
