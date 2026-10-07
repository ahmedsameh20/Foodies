-- Tap model: settlement to restaurants is performed BY TAP; the platform records what Tap reports (read-only) next to its own
-- earnings ledger. Also: provider-issued saved-card ids for SaaS renewals (never card numbers / CVV).

ALTER TABLE restaurant_payment_accounts ADD COLUMN provider_wallet_id TEXT;     -- from GET /destination/{id}: wallet_id (matches Tap payouts to restaurants)
ALTER TABLE restaurant_payment_accounts ADD COLUMN provider_business_id TEXT;   -- from GET /destination/{id}: business_id
ALTER TABLE restaurant_payment_accounts ADD COLUMN provider_live_mode INTEGER;  -- destination live_mode at link time (sandbox vs live must match PAYMENT_ENV)

-- What the provider says it paid out. Informational: NEVER changes an earnings statement or marks anything paid by itself.
CREATE TABLE provider_settlements (
  id                   INTEGER PRIMARY KEY,
  provider             TEXT NOT NULL,
  provider_payout_id   TEXT NOT NULL,
  restaurant_id        INTEGER REFERENCES restaurants(id) ON DELETE SET NULL,   -- matched through the destination's wallet id; NULL = unmatched
  provider_wallet_id   TEXT,
  provider_merchant_id TEXT,
  amount_text          TEXT NOT NULL,   -- exactly as reported: the unit is not documented, so it is never used in arithmetic
  currency             TEXT,
  status_raw           TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('processing','paid','failed','unknown')),
  payout_date          TEXT,
  raw                  TEXT,            -- redacted provider JSON
  first_seen_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (provider, provider_payout_id)
);
CREATE INDEX idx_settlements_restaurant ON provider_settlements(restaurant_id, payout_date);

-- Saved card on file for SaaS renewals: ONLY identifiers issued by the provider. At most one active method per restaurant.
CREATE TABLE subscription_payment_methods (
  id                    INTEGER PRIMARY KEY,
  restaurant_id         INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL,
  provider_customer_id  TEXT NOT NULL,
  provider_card_id      TEXT NOT NULL,
  provider_agreement_id TEXT NOT NULL,
  brand                 TEXT,
  last4                 TEXT CHECK (last4 IS NULL OR last4 GLOB '[0-9][0-9][0-9][0-9]'),
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_at            TEXT,
  UNIQUE (provider, provider_card_id)
);
CREATE UNIQUE INDEX uq_sub_pm_active ON subscription_payment_methods(restaurant_id) WHERE status = 'active';

-- One row per automatic charge attempt of an invoice; UNIQUE(invoice, attempt) is the idempotency guard.
CREATE TABLE subscription_charge_attempts (
  id                 INTEGER PRIMARY KEY,
  invoice_id         INTEGER NOT NULL REFERENCES saas_invoices(id) ON DELETE CASCADE,
  restaurant_id      INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  attempt_no         INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 10),
  status             TEXT NOT NULL CHECK (status IN ('started','succeeded','failed')),
  provider_charge_id TEXT,
  failure_reason     TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (invoice_id, attempt_no)
);
