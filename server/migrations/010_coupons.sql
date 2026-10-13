-- Coupon codes entered by customers at checkout (restaurant-managed). Separate from discount_rules (automatic, price-level) so the automatic
-- pricing engine is untouched; a coupon is applied to an already-priced cart (see services/coupons.js for the precedence policy).
--   coupons              one row per code; UNIQUE(restaurant_id, code) with the code stored normalised (trimmed, upper-case)
--   coupon_products      dishes of a 'product' scope coupon
--   coupon_redemptions   one row per coupon per order (UNIQUE(coupon_id, order_id)): reserved -> redeemed | released, with the code and the
--                        discount actually granted. A coupon that has redemptions can not be deleted (disable it), so this audit trail is never lost.
--   orders.coupon_*      the code and discount actually applied, kept on the order even if the coupon is edited or deleted later
CREATE TABLE coupons (
  id                     INTEGER PRIMARY KEY,
  restaurant_id          INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  code                   TEXT NOT NULL,
  name_ar                TEXT NOT NULL,
  name_en                TEXT NOT NULL,
  description_ar         TEXT,
  description_en         TEXT,
  scope                  TEXT NOT NULL CHECK (scope IN ('order','menu','category','product')),
  kind                   TEXT NOT NULL CHECK (kind IN ('percent','fixed')),
  value                  INTEGER NOT NULL CHECK (value > 0),               -- percent: basis points (at most 9000); fixed: cents
  max_discount_cents     INTEGER CHECK (max_discount_cents IS NULL OR max_discount_cents > 0),
  min_subtotal_cents     INTEGER NOT NULL DEFAULT 0 CHECK (min_subtotal_cents >= 0),
  category_id            INTEGER,
  starts_at              TEXT,
  ends_at                TEXT,
  is_active              INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  usage_limit            INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),
  used_count             INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  max_uses_per_customer  INTEGER CHECK (max_uses_per_customer IS NULL OR max_uses_per_customer > 0),
  allow_stacking         INTEGER NOT NULL DEFAULT 0 CHECK (allow_stacking IN (0,1)),
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, restaurant_id),
  UNIQUE (restaurant_id, code),
  CHECK ((scope = 'category') = (category_id IS NOT NULL)),
  CHECK (kind != 'percent' OR value <= 9000),
  CHECK (kind = 'percent' OR max_discount_cents IS NULL),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at),
  FOREIGN KEY (category_id, restaurant_id) REFERENCES categories(id, restaurant_id) ON DELETE RESTRICT
);
CREATE INDEX idx_coupons_rest ON coupons(restaurant_id, is_active);

CREATE TABLE coupon_products (
  coupon_id      INTEGER NOT NULL,
  restaurant_id  INTEGER NOT NULL,
  product_id     INTEGER NOT NULL,
  PRIMARY KEY (coupon_id, product_id),
  FOREIGN KEY (coupon_id, restaurant_id) REFERENCES coupons(id, restaurant_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, restaurant_id) REFERENCES products(id, restaurant_id) ON DELETE CASCADE
);
CREATE INDEX idx_coupon_products_product ON coupon_products(product_id);

CREATE TABLE coupon_redemptions (
  id             INTEGER PRIMARY KEY,
  coupon_id      INTEGER NOT NULL,
  restaurant_id  INTEGER NOT NULL,
  customer_id    INTEGER NOT NULL REFERENCES users(id),
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,
  discount_cents INTEGER NOT NULL CHECK (discount_cents > 0),
  status         TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','redeemed','released')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  redeemed_at    TEXT,
  released_at    TEXT,
  UNIQUE (coupon_id, order_id),
  FOREIGN KEY (coupon_id, restaurant_id) REFERENCES coupons(id, restaurant_id)
);
CREATE INDEX idx_coupon_redemptions_customer ON coupon_redemptions(coupon_id, customer_id, status);

ALTER TABLE orders ADD COLUMN coupon_id INTEGER;
ALTER TABLE orders ADD COLUMN coupon_code TEXT;
ALTER TABLE orders ADD COLUMN coupon_discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (coupon_discount_cents >= 0);
