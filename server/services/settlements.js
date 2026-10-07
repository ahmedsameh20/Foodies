// Tap settlement records (read-only).
//
// In the Tap marketplace model the platform does NOT pay restaurants: Tap routes each restaurant's share to its destination
// at charge time and then settles that wallet to the restaurant's bank itself (automatically after KYC, or from Tap's dashboard
// when auto-settlement was disabled for that business). The platform's own weekly "statement" is therefore an EARNINGS
// record. What Tap actually paid out is only known from Tap, through its Payouts API (POST /payouts/list/). This service
// stores what Tap reports, matched to restaurants by wallet id, and never marks an earnings statement paid by itself.
const logger = require('../logger');
const config = require('../config');
const { audit } = require('./platform');
const { ProviderError } = require('../payments/provider');
const { HttpError } = require('../utils');

async function syncSettlements(db, provider, { actor = null } = {}) {
  if (!provider.enabled) throw new HttpError(409, 'payments_not_enabled', 'No payment provider is configured');
  let rows;
  try {
    rows = await provider.listPayouts({ merchantIds: config.payment.merchantId ? [config.payment.merchantId] : [] });
  } catch (e) {
    if (e instanceof ProviderError && ['capability_not_verified', 'not_supported'].includes(e.code)) {
      throw new HttpError(501, 'provider_capability_unavailable', e.message);
    }
    logger.error('settlements.sync_failed', { error: e });
    throw new HttpError(502, 'payment_provider_error', 'The payment provider could not list payouts');
  }
  const wallets = new Map(db.prepare('SELECT provider_wallet_id w, restaurant_id r FROM restaurant_payment_accounts WHERE provider_wallet_id IS NOT NULL').all().map((x) => [x.w, x.r]));
  const upsert = db.prepare(
    `INSERT INTO provider_settlements (provider, provider_payout_id, restaurant_id, provider_wallet_id, provider_merchant_id, amount_text, currency, status_raw, status, payout_date, raw)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(provider, provider_payout_id) DO UPDATE SET status_raw = excluded.status_raw, status = excluded.status, amount_text = excluded.amount_text,
       currency = excluded.currency, restaurant_id = COALESCE(excluded.restaurant_id, provider_settlements.restaurant_id),
       raw = excluded.raw, last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  let matched = 0;
  for (const p of rows) {
    const rid = (p.walletId && wallets.get(p.walletId)) || null;
    if (rid) matched += 1;
    upsert.run(provider.name, p.id, rid, p.walletId, p.merchantId, p.amountText, p.currency, p.statusRaw, p.status, p.date,
      JSON.stringify(logger.redact(p.raw)).slice(0, 4000));
  }
  audit(db, actor ? { user: actor } : null, 'settlements.synced', 'settlements', null, { fetched: rows.length, matched });
  return { fetched: rows.length, matched, unmatched: rows.length - matched };
}

// Settlement view shared by the restaurant dashboard (its own rows only) and the admin finance table.
function settlementsFor(db, restaurantId, limit = 50) {
  return db.prepare('SELECT * FROM provider_settlements WHERE restaurant_id = ? ORDER BY COALESCE(payout_date, first_seen_at) DESC, id DESC LIMIT ?').all(restaurantId, limit)
    .map((s) => ({ id: s.provider_payout_id, amount: s.amount_text, currency: s.currency, status: s.status, statusRaw: s.status_raw, date: s.payout_date, lastSeenAt: s.last_seen_at }));
}

// One word for the restaurant: where is the money?
function settlementState(db, restaurantId, accountStatus) {
  const last = db.prepare('SELECT status FROM provider_settlements WHERE restaurant_id = ? ORDER BY COALESCE(payout_date, first_seen_at) DESC, id DESC LIMIT 1').get(restaurantId);
  if (accountStatus !== 'VERIFIED') return 'AWAITING_ACCOUNT_VERIFICATION';
  if (!last) return 'AWAITING_TAP_SETTLEMENT';
  return { paid: 'PAID_BY_TAP', processing: 'PROCESSING', failed: 'FAILED', unknown: 'UNKNOWN' }[last.status];
}

module.exports = { syncSettlements, settlementsFor, settlementState };
