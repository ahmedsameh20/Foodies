-- migrate:foreign_keys=off
-- Payments completion: restaurant payout-account lifecycle + onboarding application, configurable fixed commission,
-- payout state machine with provider/manual confirmation provenance, payout event log, SaaS invoice refunds.

------------------------------------------------------------------ restaurant payout account (provider-side identity only)
-- Only identifiers and statuses are stored. Bank details are handled by the provider; at most a MASKED display value
-- (e.g. "****1234") supplied by the provider/admin is kept. Never card numbers, CVV, bank passwords or API keys.
ALTER TABLE restaurant_payment_accounts ADD COLUMN application_submitted_at TEXT;   -- owner asked to start onboarding
ALTER TABLE restaurant_payment_accounts ADD COLUMN legal_name TEXT;
ALTER TABLE restaurant_payment_accounts ADD COLUMN registration_number TEXT;        -- commercial registration no. (identifier, not a credential)
ALTER TABLE restaurant_payment_accounts ADD COLUMN contact_name TEXT;
ALTER TABLE restaurant_payment_accounts ADD COLUMN contact_phone TEXT;
ALTER TABLE restaurant_payment_accounts ADD COLUMN contact_email TEXT;
ALTER TABLE restaurant_payment_accounts ADD COLUMN country TEXT NOT NULL DEFAULT 'SA';
ALTER TABLE restaurant_payment_accounts ADD COLUMN settlement_currency TEXT;
ALTER TABLE restaurant_payment_accounts ADD COLUMN masked_bank TEXT;
ALTER TABLE restaurant_payment_accounts ADD COLUMN rejection_reason TEXT;
ALTER TABLE restaurant_payment_accounts ADD COLUMN last_verified_at TEXT;           -- when an admin last confirmed the destination with the provider
ALTER TABLE restaurant_payment_accounts ADD COLUMN disabled_at TEXT;
CREATE UNIQUE INDEX uq_payment_accounts_connected ON restaurant_payment_accounts(payment_provider, connected_account_id) WHERE connected_account_id IS NOT NULL;

------------------------------------------------------------------ commission: percentage + fixed, per-restaurant override
ALTER TABLE restaurants ADD COLUMN commission_fixed_override INTEGER CHECK (commission_fixed_override IS NULL OR commission_fixed_override >= 0);
ALTER TABLE orders ADD COLUMN commission_fixed_cents INTEGER NOT NULL DEFAULT 0 CHECK (commission_fixed_cents >= 0);  -- snapshot

------------------------------------------------------------------ payouts (rebuilt: wider state machine + confirmation provenance)
-- pending -> (provider) requested -> processing -> paid | failed | reversed ; pending -> manual_payout -> paid (admin_manual) ; cancelled
-- 'paid' is only storable together with a payout reference AND who confirmed it (provider or admin_manual).
CREATE TABLE payouts_new (
  id                  INTEGER PRIMARY KEY,
  restaurant_id       INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  amount_cents        INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency            TEXT NOT NULL,
  settlement_currency TEXT,
  provider            TEXT NOT NULL,
  provider_payout_id  TEXT,
  period_start        TEXT NOT NULL,
  period_end          TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','eligible','requested','processing','paid','failed','cancelled','reversed','manual_payout')),
  confirmation_source TEXT CHECK (confirmation_source IN ('provider','admin_manual')),
  failure_reason      TEXT,
  requested_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at             TEXT,
  UNIQUE (restaurant_id, period_start),
  CHECK (status != 'paid' OR (confirmation_source IS NOT NULL AND provider_payout_id IS NOT NULL))
);
INSERT INTO payouts_new (id, restaurant_id, amount_cents, currency, provider, provider_payout_id, period_start, period_end, status,
                         confirmation_source, failure_reason, created_at, updated_at, paid_at)
  SELECT id, restaurant_id, amount_cents, currency, provider, provider_payout_id, period_start, period_end, status,
         CASE WHEN status = 'paid' THEN 'admin_manual' END, failure_reason, created_at, updated_at, paid_at FROM payouts;
UPDATE payouts_new SET provider_payout_id = 'legacy-' || id WHERE status = 'paid' AND provider_payout_id IS NULL;
DROP TABLE payouts;
ALTER TABLE payouts_new RENAME TO payouts;
CREATE UNIQUE INDEX uq_payouts_provider_ref ON payouts(provider, provider_payout_id) WHERE provider_payout_id IS NOT NULL;
CREATE INDEX idx_payouts_status ON payouts(status, period_start);
CREATE TRIGGER trg_payouts_updated AFTER UPDATE ON payouts
  WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE payouts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;

-- Every payout state change, from whoever caused it. provider_event_id is unique: a provider event is applied once.
CREATE TABLE payout_events (
  id                INTEGER PRIMARY KEY,
  payout_id         INTEGER NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  from_status       TEXT,
  to_status         TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('provider','admin','system')),
  provider_event_id TEXT,
  actor_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details           TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX uq_payout_events_provider ON payout_events(provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX idx_payout_events_payout ON payout_events(payout_id, id);

------------------------------------------------------------------ SaaS invoice refunds (restaurant -> platform ledger, separate from order refunds)
CREATE TABLE saas_invoice_refunds (
  id                 INTEGER PRIMARY KEY,
  invoice_id         INTEGER NOT NULL REFERENCES saas_invoices(id) ON DELETE CASCADE,
  restaurant_id      INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  amount_cents       INTEGER NOT NULL CHECK (amount_cents > 0),
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  provider           TEXT NOT NULL,
  provider_refund_id TEXT,
  idempotency_key    TEXT NOT NULL UNIQUE,
  reason             TEXT NOT NULL,
  failure_reason     TEXT,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_saas_invoice_refunds_invoice ON saas_invoice_refunds(invoice_id, status);
