-- migrate:foreign_keys=off
-- Marketplace transformation: approval workflow, real payments, refunds, earnings ledger,
-- payouts, webhooks, idempotency, support reports, audit log.
-- All money columns are integer minor units (cents). Existing data is preserved.

------------------------------------------------------------------ users
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;   -- bump to revoke all sessions
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN updated_at TEXT;
UPDATE users SET updated_at = created_at;
UPDATE subscriptions SET provider = 'platform' WHERE provider = 'demo';  -- self-service demo billing no longer exists

------------------------------------------------------------------ restaurants
ALTER TABLE restaurants ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE restaurants ADD COLUMN whatsapp TEXT;
ALTER TABLE restaurants ADD COLUMN cover_url TEXT;
ALTER TABLE restaurants ADD COLUMN opening_hours TEXT;          -- JSON: {"mon":[{"open":"09:00","close":"22:00"}],...}; NULL = always open
ALTER TABLE restaurants ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Riyadh';
ALTER TABLE restaurants ADD COLUMN latitude REAL;
ALTER TABLE restaurants ADD COLUMN longitude REAL;
ALTER TABLE restaurants ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (approval_status IN ('pending','approved','rejected'));
ALTER TABLE restaurants ADD COLUMN rejection_reason TEXT;
ALTER TABLE restaurants ADD COLUMN commission_bp_override INTEGER CHECK (commission_bp_override IS NULL OR commission_bp_override BETWEEN 0 AND 10000);
ALTER TABLE restaurants ADD COLUMN updated_at TEXT;
UPDATE restaurants SET approval_status = 'approved', updated_at = created_at;
UPDATE restaurants SET owner_id = (SELECT u.id FROM users u WHERE u.restaurant_id = restaurants.id AND u.role = 'owner' LIMIT 1);

-- Payout destination, held at the payment provider. Only provider-safe identifiers are stored.
CREATE TABLE restaurant_payment_accounts (
  id                    INTEGER PRIMARY KEY,
  restaurant_id         INTEGER NOT NULL UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE,
  payment_provider      TEXT NOT NULL,
  connected_account_id  TEXT,                       -- provider destination / sub-merchant id
  onboarding_status     TEXT NOT NULL DEFAULT 'not_started'
                        CHECK (onboarding_status IN ('not_started','in_progress','completed','rejected')),
  verification_status   TEXT NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('unverified','pending','verified','rejected')),
  payout_account_status TEXT NOT NULL DEFAULT 'inactive'
                        CHECK (payout_account_status IN ('inactive','active','restricted')),
  payout_enabled        INTEGER NOT NULL DEFAULT 0 CHECK (payout_enabled IN (0,1)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

------------------------------------------------------------------ menu options / add-ons
CREATE TABLE option_groups (
  id             INTEGER PRIMARY KEY,
  restaurant_id  INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  product_id     INTEGER NOT NULL,
  name           TEXT NOT NULL,
  min_select     INTEGER NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select     INTEGER NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  CHECK (min_select <= max_select),
  UNIQUE (id, restaurant_id),
  FOREIGN KEY (product_id, restaurant_id) REFERENCES products(id, restaurant_id) ON DELETE CASCADE
);
CREATE INDEX idx_option_groups_product ON option_groups(product_id);

CREATE TABLE options (
  id             INTEGER PRIMARY KEY,
  restaurant_id  INTEGER NOT NULL,
  group_id       INTEGER NOT NULL,
  name           TEXT NOT NULL,
  price_cents    INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  is_available   INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0,1)),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (id, restaurant_id),
  FOREIGN KEY (group_id, restaurant_id) REFERENCES option_groups(id, restaurant_id) ON DELETE CASCADE
);
CREATE INDEX idx_options_group ON options(group_id);

------------------------------------------------------------------ orders (rebuilt: new statuses & money columns)
CREATE TABLE orders_new (
  id                    INTEGER PRIMARY KEY,
  restaurant_id         INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id           INTEGER NOT NULL REFERENCES users(id),
  order_number          INTEGER NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('awaiting_payment','pending','confirmed','preparing','ready',
                                          'out_for_delivery','delivered','cancelled','rejected')),
  order_type            TEXT NOT NULL CHECK (order_type IN ('delivery','pickup')),
  payment_method        TEXT NOT NULL DEFAULT 'cod' CHECK (payment_method IN ('card','cod')),
  payment_status        TEXT NOT NULL DEFAULT 'cod_pending'
                        CHECK (payment_status IN ('awaiting_payment','paid','failed','cancelled','cod_pending',
                                                  'cash_collected','refunded','partially_refunded')),
  customer_name         TEXT NOT NULL,
  customer_phone        TEXT NOT NULL,
  delivery_address      TEXT,
  delivery_latitude     REAL,
  delivery_longitude    REAL,
  notes                 TEXT,
  subtotal_cents        INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents        INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  tax_cents             INTEGER NOT NULL CHECK (tax_cents >= 0),
  delivery_fee_cents    INTEGER NOT NULL CHECK (delivery_fee_cents >= 0),
  platform_fee_cents    INTEGER NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),  -- customer-paid service fee, kept by the platform
  total_cents           INTEGER NOT NULL CHECK (total_cents >= 0),
  -- Snapshot of the marketplace split, fixed at order time so later setting changes never rewrite history
  commission_bp         INTEGER NOT NULL DEFAULT 0,
  commission_cents      INTEGER NOT NULL DEFAULT 0 CHECK (commission_cents >= 0),
  restaurant_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (restaurant_amount_cents >= 0),
  currency              TEXT NOT NULL,
  cancel_reason         TEXT,
  expires_at            TEXT,                         -- awaiting_payment orders are cancelled after this
  paid_at               TEXT,
  delivered_at          TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, restaurant_id),
  UNIQUE (restaurant_id, order_number),
  CHECK (total_cents = subtotal_cents - discount_cents + tax_cents + delivery_fee_cents + platform_fee_cents)
);

INSERT INTO orders_new (id, restaurant_id, customer_id, order_number, status, order_type, payment_method,
  payment_status, customer_name, customer_phone, delivery_address, notes, subtotal_cents, tax_cents,
  delivery_fee_cents, total_cents, restaurant_amount_cents, currency, delivered_at, created_at, updated_at)
SELECT id, restaurant_id, customer_id, order_number,
       CASE status WHEN 'completed' THEN 'delivered' ELSE status END,
       order_type, 'cod',
       CASE WHEN status = 'cancelled' THEN 'cancelled' WHEN payment_status = 'paid' THEN 'cash_collected' ELSE 'cod_pending' END,
       customer_name, customer_phone, delivery_address, notes, subtotal_cents, tax_cents,
       delivery_fee_cents, total_cents, total_cents, currency,
       CASE WHEN status = 'completed' THEN updated_at END, created_at, updated_at
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;
CREATE INDEX idx_orders_restaurant ON orders(restaurant_id, status, created_at);
CREATE INDEX idx_orders_customer ON orders(customer_id, created_at);
CREATE INDEX idx_orders_awaiting ON orders(status, expires_at);

CREATE TABLE order_item_options (
  id               INTEGER PRIMARY KEY,
  order_item_id    INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  restaurant_id    INTEGER NOT NULL,
  option_id        INTEGER,
  group_name       TEXT NOT NULL,
  option_name      TEXT NOT NULL,
  price_cents      INTEGER NOT NULL CHECK (price_cents >= 0),
  FOREIGN KEY (option_id, restaurant_id) REFERENCES options(id, restaurant_id) ON DELETE SET NULL
);
CREATE INDEX idx_oio_item ON order_item_options(order_item_id);

------------------------------------------------------------------ payments
CREATE TABLE payments (
  id                      INTEGER PRIMARY KEY,
  order_id                INTEGER NOT NULL,
  customer_id             INTEGER NOT NULL REFERENCES users(id),
  restaurant_id           INTEGER NOT NULL,
  provider                TEXT NOT NULL,                 -- 'tap' | 'cod'
  provider_transaction_id TEXT,
  amount_cents            INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency                TEXT NOT NULL,                 -- order/payment currency
  settlement_currency     TEXT,                          -- filled from provider data when it differs
  payment_method          TEXT NOT NULL CHECK (payment_method IN ('card','cod')),
  payment_source          TEXT,                          -- e.g. VISA, MASTERCARD, MADA, APPLE_PAY as reported by provider
  status                  TEXT NOT NULL
                          CHECK (status IN ('initiated','pending','succeeded','failed','cancelled',
                                            'cod_pending','cash_collected','refunded','partially_refunded')),
  refunded_cents          INTEGER NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  estimated_fee_cents     INTEGER NOT NULL DEFAULT 0 CHECK (estimated_fee_cents >= 0),
  failure_reason          TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (order_id),
  UNIQUE (id, restaurant_id),
  CHECK (refunded_cents <= amount_cents),
  FOREIGN KEY (order_id, restaurant_id) REFERENCES orders(id, restaurant_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_payments_provider_txn ON payments(provider, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;
CREATE INDEX idx_payments_restaurant ON payments(restaurant_id, status, created_at);

CREATE TABLE refunds (
  id                  INTEGER PRIMARY KEY,
  payment_id          INTEGER NOT NULL,
  order_id            INTEGER NOT NULL,
  restaurant_id       INTEGER NOT NULL,
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  currency            TEXT NOT NULL,
  reason              TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  provider_refund_id  TEXT,
  idempotency_key     TEXT NOT NULL UNIQUE,
  requested_by        INTEGER REFERENCES users(id),
  failure_reason      TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (payment_id, restaurant_id) REFERENCES payments(id, restaurant_id) ON DELETE CASCADE
);
CREATE INDEX idx_refunds_payment ON refunds(payment_id);

------------------------------------------------------------------ payouts & earnings ledger
CREATE TABLE payouts (
  id                  INTEGER PRIMARY KEY,
  restaurant_id       INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  amount_cents        INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency            TEXT NOT NULL,
  provider            TEXT NOT NULL,
  provider_payout_id  TEXT,
  period_start        TEXT NOT NULL,                  -- inclusive, YYYY-MM-DD (UTC Monday)
  period_end          TEXT NOT NULL,                  -- inclusive, YYYY-MM-DD (UTC Sunday)
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','processing','paid','failed','cancelled')),
  failure_reason      TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at             TEXT,
  -- one payout per restaurant per week: the duplicate-payout guard
  UNIQUE (restaurant_id, period_start)
);
CREATE UNIQUE INDEX uq_payouts_provider_ref ON payouts(provider, provider_payout_id) WHERE provider_payout_id IS NOT NULL;

-- Append-only: rows are never updated except to attach a payout / record settlement.
CREATE TABLE ledger_entries (
  id                       INTEGER PRIMARY KEY,
  restaurant_id            INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id                 INTEGER NOT NULL,
  payment_id               INTEGER,
  refund_id                INTEGER REFERENCES refunds(id),
  entry_type               TEXT NOT NULL CHECK (entry_type IN ('sale','refund','cod_commission')),
  gross_amount_cents       INTEGER NOT NULL,          -- signed: negative for refunds
  platform_commission_cents INTEGER NOT NULL,         -- signed
  platform_fee_cents       INTEGER NOT NULL DEFAULT 0, -- customer service fee retained by platform (signed)
  payment_fee_cents        INTEGER NOT NULL DEFAULT 0, -- provider fee charged to the restaurant (signed; 0 when platform bears it)
  restaurant_amount_cents  INTEGER NOT NULL,          -- signed net to restaurant (for cod_commission: the negative amount owed to platform)
  currency                 TEXT NOT NULL,
  eligible_at              TEXT,                      -- NULL until the order is delivered (refunds are eligible immediately)
  payout_id                INTEGER REFERENCES payouts(id),
  payout_status            TEXT NOT NULL DEFAULT 'unpaid' CHECK (payout_status IN ('unpaid','in_payout','paid')),
  payout_date              TEXT,
  settled_at               TEXT,                      -- cod_commission only: when the platform collected it
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (order_id, restaurant_id) REFERENCES orders(id, restaurant_id) ON DELETE CASCADE,
  CHECK (restaurant_amount_cents = gross_amount_cents - platform_commission_cents - platform_fee_cents - payment_fee_cents
         OR entry_type = 'cod_commission')
);
-- A sale/cod_commission entry exists at most once per order; a refund entry once per refund.
CREATE UNIQUE INDEX uq_ledger_sale ON ledger_entries(order_id, entry_type) WHERE entry_type IN ('sale','cod_commission');
CREATE UNIQUE INDEX uq_ledger_refund ON ledger_entries(refund_id) WHERE refund_id IS NOT NULL;
CREATE INDEX idx_ledger_restaurant ON ledger_entries(restaurant_id, payout_id, eligible_at);

------------------------------------------------------------------ webhooks, idempotency
CREATE TABLE webhook_events (
  id            INTEGER PRIMARY KEY,
  provider      TEXT NOT NULL,
  event_key     TEXT NOT NULL,                        -- provider event id, or object id + status when none is supplied
  event_type    TEXT,
  object_id     TEXT,
  payload       TEXT,
  status        TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed')),
  error         TEXT,
  received_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at  TEXT,
  UNIQUE (provider, event_key)
);

CREATE TABLE idempotency_keys (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope          TEXT NOT NULL,
  key            TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  response_status INTEGER,
  response_body  TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, scope, key)
);

------------------------------------------------------------------ support reports, audit, settings, auth tokens
CREATE TABLE reports (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id  INTEGER REFERENCES restaurants(id) ON DELETE SET NULL,
  order_id       INTEGER,
  category       TEXT NOT NULL CHECK (category IN ('restaurant','order','payment','food','account','other')),
  subject        TEXT NOT NULL,
  description    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  priority       TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  admin_response TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at    TEXT
);
CREATE INDEX idx_reports_status ON reports(status, created_at);

CREATE TABLE audit_logs (
  id           INTEGER PRIMARY KEY,
  actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_role   TEXT,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  details      TEXT,                                  -- JSON, never contains secrets
  ip           TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_created ON audit_logs(created_at);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE auth_tokens (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('password_reset','email_verify')),
  token_hash  TEXT NOT NULL UNIQUE,                   -- SHA-256 of the emailed token; the raw token is never stored
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

------------------------------------------------------------------ updated_at maintenance
CREATE TRIGGER trg_users_updated AFTER UPDATE ON users
  WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE users SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_restaurants_updated AFTER UPDATE ON restaurants
  WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE restaurants SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_orders_updated AFTER UPDATE ON orders
  WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE orders SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_payments_updated AFTER UPDATE ON payments
  WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE payments SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_refunds_updated AFTER UPDATE ON refunds
  WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE refunds SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_payouts_updated AFTER UPDATE ON payouts
  WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE payouts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_reports_updated AFTER UPDATE ON reports
  WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE reports SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_ledger_no_delete BEFORE DELETE ON ledger_entries
  BEGIN SELECT RAISE(ABORT, 'ledger entries are append-only'); END;
