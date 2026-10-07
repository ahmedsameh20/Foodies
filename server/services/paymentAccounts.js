// Restaurant payout account: the restaurant's identity at the payment provider.
//
// Only identifiers and statuses live here (provider account id, KYC/payout status, a MASKED bank display value).
// Bank details and KYC documents are collected by the provider; this application never stores card numbers, CVV,
// bank passwords or API credentials, and refuses them if a client tries to send them.
//
// Account states (derived from the stored columns so they cannot drift):
//   NOT_ONBOARDED -> ONBOARDING (owner applied) -> PENDING_VERIFICATION (provider destination linked, KYC running)
//   -> VERIFIED (provider confirmed the destination AND payouts enabled) ; REJECTED ; SUSPENDED ; DISABLED
// "VERIFIED" is only ever written after the provider itself confirmed the destination (see routes/admin.js).
const config = require('../config');
const { HttpError, bad, str, phone } = require('../utils');
const { audit } = require('./platform');

const SENSITIVE_KEYS = /iban|account.?number|card|cvv|cvc|pan\b|password|secret|swift|sort.?code|routing/i;

function accountStatus(a) {
  if (!a) return 'NOT_ONBOARDED';
  if (a.disabled_at) return 'DISABLED';
  if (a.payout_account_status === 'restricted') return 'SUSPENDED';
  if (a.verification_status === 'rejected' || a.onboarding_status === 'rejected') return 'REJECTED';
  if (a.connected_account_id && a.verification_status === 'verified' && a.payout_enabled && a.payout_account_status === 'active') return 'VERIFIED';
  if (a.connected_account_id) return 'PENDING_VERIFICATION';
  if (a.application_submitted_at || a.onboarding_status === 'in_progress') return 'ONBOARDING';
  return 'NOT_ONBOARDED';
}

// Restaurant-facing wording of the same state.
const DISPLAY = {
  NOT_ONBOARDED: 'NOT_STARTED', ONBOARDING: 'PENDING', PENDING_VERIFICATION: 'UNDER_REVIEW',
  VERIFIED: 'VERIFIED', REJECTED: 'REJECTED', SUSPENDED: 'SUSPENDED', DISABLED: 'DISABLED',
};

function view(db, restaurantId, provider) {
  const a = db.prepare('SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(restaurantId);
  const status = accountStatus(a);
  const providerEnabled = Boolean(provider ? provider.enabled : config.paymentProvider !== 'none');
  return {
    provider: config.paymentProvider, providerEnabled, environment: config.paymentEnv,
    status, displayStatus: DISPLAY[status],
    onboardingStatus: a?.onboarding_status || 'not_started', verificationStatus: a?.verification_status || 'unverified',
    kycStatus: a?.verification_status || 'unverified',
    payoutAccountStatus: a?.payout_account_status || 'inactive', payoutEnabled: !!a?.payout_enabled,
    connected: !!a?.connected_account_id,
    onlinePaymentsEnabled: providerEnabled && status === 'VERIFIED',
    settlementCurrency: a?.settlement_currency || null, country: a?.country || 'SA',
    maskedBank: a?.masked_bank || null, payoutSchedule: 'weekly', payoutMode: config.payoutMode,
    applicationSubmittedAt: a?.application_submitted_at || null, lastVerifiedAt: a?.last_verified_at || null,
    rejectionReason: status === 'REJECTED' ? a?.rejection_reason || null : null,
    application: a?.application_submitted_at ? { legalName: a.legal_name, registrationNumber: a.registration_number, contactName: a.contact_name, contactPhone: a.contact_phone, contactEmail: a.contact_email } : null,
  };
}

// The owner asks to start the provider's onboarding. Nothing is claimed to be verified: the platform team completes the
// provider-side business registration (KYC/KYB), links the provider's destination id, and the provider confirms it.
function submitApplication(db, req, restaurant, body = {}) {
  for (const k of Object.keys(body)) {
    if (SENSITIVE_KEYS.test(k)) throw bad('Bank, card and credential details are never collected here. The payment provider collects them during its own verification.', { field: k });
  }
  if (config.paymentProvider === 'none') throw new HttpError(409, 'payments_not_enabled', 'Online payments are not enabled on this platform yet');
  const cur = db.prepare('SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?').get(restaurant.id);
  const st = accountStatus(cur);
  if (['VERIFIED', 'DISABLED', 'SUSPENDED'].includes(st)) throw new HttpError(409, 'invalid_state', `Your payment account is ${DISPLAY[st]}; contact the platform to change it`);
  const f = {
    legalName: str(body.legalName, 'legalName', { max: 150 }),
    registrationNumber: str(body.registrationNumber, 'registrationNumber', { max: 40 }),
    contactName: str(body.contactName, 'contactName', { max: 100 }),
    contactPhone: phone(body.contactPhone, 'contactPhone'),
    contactEmail: str(body.contactEmail, 'contactEmail', { max: 150 }),
  };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.contactEmail)) throw bad('contactEmail: invalid email', { field: 'contactEmail' });
  db.prepare(
    `INSERT INTO restaurant_payment_accounts (restaurant_id, payment_provider, onboarding_status, legal_name, registration_number, contact_name, contact_phone, contact_email, application_submitted_at, rejection_reason)
     VALUES (?,?,'in_progress',?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL)
     ON CONFLICT(restaurant_id) DO UPDATE SET onboarding_status = 'in_progress', legal_name = excluded.legal_name, registration_number = excluded.registration_number,
       contact_name = excluded.contact_name, contact_phone = excluded.contact_phone, contact_email = excluded.contact_email,
       application_submitted_at = excluded.application_submitted_at, rejection_reason = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(restaurant.id, config.paymentProvider, f.legalName, f.registrationNumber, f.contactName, f.contactPhone, f.contactEmail);
  audit(db, req, 'payment_account.application_submitted', 'restaurant', restaurant.id, { legalName: f.legalName });
}

module.exports = { accountStatus, DISPLAY, view, submitApplication };
