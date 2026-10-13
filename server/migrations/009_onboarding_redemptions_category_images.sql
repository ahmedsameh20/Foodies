-- 1. Plan chosen BEFORE the restaurant exists: kept on the owner's account (server side), validated against plans.code when it is used.
-- 2. Per-customer discount limits + a redemption ledger (one row per rule per order) so limits are enforced from reliable records.
--      discount_rules.max_uses_per_customer  NULL = unlimited (every rule created before this migration keeps its behaviour); new rules default to 1.
--      discount_redemptions.status           reserved (order placed, counts) -> redeemed (delivered, counts) | released (cancelled / failed / rejected, does not count)
-- 3. Optional image on each menu category.
ALTER TABLE users ADD COLUMN pending_plan_code TEXT;

ALTER TABLE discount_rules ADD COLUMN max_uses_per_customer INTEGER CHECK (max_uses_per_customer IS NULL OR max_uses_per_customer > 0);

CREATE TABLE discount_redemptions (
  id             INTEGER PRIMARY KEY,
  rule_id        INTEGER NOT NULL,
  restaurant_id  INTEGER NOT NULL,
  customer_id    INTEGER NOT NULL REFERENCES users(id),
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','redeemed','released')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  redeemed_at    TEXT,
  released_at    TEXT,
  UNIQUE (rule_id, order_id),
  FOREIGN KEY (rule_id, restaurant_id) REFERENCES discount_rules(id, restaurant_id) ON DELETE CASCADE
);
CREATE INDEX idx_discount_redemptions_customer ON discount_redemptions(rule_id, customer_id, status);

-- history: every existing order that was priced by a rule and is still standing counts as a use (cancelled / rejected ones do not)
INSERT INTO discount_redemptions (rule_id, restaurant_id, customer_id, order_id, status, redeemed_at)
SELECT DISTINCT oi.discount_rule_id, o.restaurant_id, o.customer_id, o.id,
       CASE WHEN o.status = 'delivered' THEN 'redeemed' ELSE 'reserved' END,
       CASE WHEN o.status = 'delivered' THEN o.delivered_at ELSE NULL END
FROM order_items oi JOIN orders o ON o.id = oi.order_id
WHERE oi.discount_rule_id IS NOT NULL AND o.status NOT IN ('cancelled','rejected');

ALTER TABLE categories ADD COLUMN image_url TEXT;
