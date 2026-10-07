-- migrate:foreign_keys=off
-- SaaS layer: configurable plans, real subscriptions with lifecycle, a billing ledger that is SEPARATE from order
-- payments, tenant domains, and TOTP two-factor authentication for platform admins.

------------------------------------------------------------------ plans
ALTER TABLE plans ADD COLUMN billing_interval TEXT NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month','year'));
ALTER TABLE plans ADD COLUMN trial_days INTEGER NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365);
ALTER TABLE plans ADD COLUMN max_orders_per_month INTEGER;          -- NULL = unlimited
ALTER TABLE plans ADD COLUMN features TEXT NOT NULL DEFAULT '[]';   -- JSON array of marketing bullet points

------------------------------------------------------------------ subscriptions (rebuilt: lifecycle columns + 'expired')
CREATE TABLE subscriptions_new (
  id                   INTEGER PRIMARY KEY,
  restaurant_id        INTEGER NOT NULL UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE,
  plan_id              INTEGER NOT NULL REFERENCES plans(id),
  status               TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','cancelled','expired','suspended')),
  price_cents          INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),       -- price locked in when the plan was chosen
  currency             TEXT NOT NULL DEFAULT 'USD',
  billing_interval     TEXT NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month','year')),
  start_date           TEXT,
  end_date             TEXT,                                                      -- end of the current paid/free period
  trial_end            TEXT,
  cancelled_at         TEXT,
  provider             TEXT NOT NULL DEFAULT 'platform',
  provider_ref         TEXT,
  current_period_end   TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO subscriptions_new (id, restaurant_id, plan_id, status, price_cents, currency, billing_interval, start_date, end_date,
                               provider, provider_ref, current_period_end, created_at, updated_at)
SELECT s.id, s.restaurant_id, s.plan_id, s.status, p.price_cents, p.currency, 'month', s.created_at, s.current_period_end,
       s.provider, s.provider_ref, s.current_period_end, s.created_at, s.updated_at
FROM subscriptions s JOIN plans p ON p.id = s.plan_id;
DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;
CREATE INDEX idx_subscriptions_status ON subscriptions(status, end_date);

------------------------------------------------------------------ SaaS billing ledger (restaurant pays the PLATFORM)
-- Deliberately separate from payments/refunds/ledger_entries, which only ever hold CUSTOMER order money.
CREATE TABLE saas_invoices (
  id               INTEGER PRIMARY KEY,
  restaurant_id    INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  subscription_id  INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
  plan_id          INTEGER NOT NULL REFERENCES plans(id),
  amount_cents     INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency         TEXT NOT NULL,
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month','year')),
  period_start     TEXT NOT NULL,
  period_end       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void','failed')),
  provider         TEXT,                 -- 'tap' | 'manual'
  provider_ref     TEXT,                 -- provider charge id, or the admin's reference for manual payments
  failure_reason   TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at          TEXT,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_saas_invoices_restaurant ON saas_invoices(restaurant_id, status, created_at);
CREATE UNIQUE INDEX uq_saas_invoices_provider_ref ON saas_invoices(provider, provider_ref) WHERE provider = 'tap' AND provider_ref IS NOT NULL;
-- at most one open invoice per restaurant at a time (prevents duplicate renewals)
CREATE UNIQUE INDEX uq_saas_invoices_open ON saas_invoices(restaurant_id) WHERE status = 'open';

------------------------------------------------------------------ tenant addressing
ALTER TABLE restaurants ADD COLUMN custom_domain TEXT;   -- e.g. "order.mypizza.com" (future custom domains)
CREATE UNIQUE INDEX uq_restaurants_custom_domain ON restaurants(custom_domain) WHERE custom_domain IS NOT NULL;

------------------------------------------------------------------ two-factor authentication (TOTP) for admins
ALTER TABLE users ADD COLUMN totp_secret_enc TEXT;                       -- AES-256-GCM, key derived from AUTH_SECRET
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0,1));
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;                     -- replay protection: last accepted 30s step

CREATE TABLE backup_codes (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, code_hash)
);

CREATE TRIGGER trg_saas_invoices_updated AFTER UPDATE ON saas_invoices
  WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE saas_invoices SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_subscriptions_updated AFTER UPDATE ON subscriptions
  WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE subscriptions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
