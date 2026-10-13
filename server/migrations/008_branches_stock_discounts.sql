-- Branch locations, per-branch inventory, discount rules and dish import support.
--
-- Everything here is ADDITIVE and backward compatible: no existing row is rewritten or removed.
--
-- branches            + Arabic / English name, map location (latitude / longitude), structured address, active flag.
-- branch_stock        Stock of a dish AT ONE BRANCH (one row per branch and dish; UNIQUE (branch_id, product_id)).
-- branch_extra_stock  Same for general extras.
--                     products.stock_quantity / restaurant_extras.stock_quantity stay in place and keep their meaning for a restaurant that has
--                     NO active branch (it then behaves exactly as before). Once a restaurant has branches, the branch rows are authoritative.
--                     Existing stock is copied to the branch ONLY when the restaurant has exactly one branch (unambiguous). With several
--                     branches nothing is assigned silently: the dashboard lists the dishes still holding "unassigned" legacy stock.
-- orders.branch_id    The branch that fulfils the order (NULL for restaurants without branches and for orders placed before this migration).
-- discount_rules      Restaurant-wide / category / dish discount rules (percentage or fixed amount) evaluated at pricing time,
--                     so a rule change reaches every eligible dish without editing each dish. See docs/MENU.md for the precedence policy.
-- order_items         + the rule that produced the line price (snapshot id + name).

ALTER TABLE branches ADD COLUMN name_ar TEXT;
ALTER TABLE branches ADD COLUMN name_en TEXT;
ALTER TABLE branches ADD COLUMN latitude REAL CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90);
ALTER TABLE branches ADD COLUMN longitude REAL CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
ALTER TABLE branches ADD COLUMN address_components TEXT;   -- JSON object of structured address parts (road, suburb, city, postcode ...)
ALTER TABLE branches ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1));
CREATE UNIQUE INDEX uq_branches_id_restaurant ON branches(id, restaurant_id);

CREATE TABLE branch_stock (
  id                   INTEGER PRIMARY KEY,
  restaurant_id        INTEGER NOT NULL,
  branch_id            INTEGER NOT NULL,
  product_id           INTEGER NOT NULL,
  quantity             INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  low_stock_threshold  INTEGER CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),  -- NULL = the default (5)
  is_available         INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0,1)),                 -- the dish can be switched off at one branch only
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (branch_id, product_id),
  FOREIGN KEY (branch_id, restaurant_id) REFERENCES branches(id, restaurant_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, restaurant_id) REFERENCES products(id, restaurant_id) ON DELETE CASCADE
);
CREATE INDEX idx_branch_stock_product ON branch_stock(product_id);

CREATE TABLE branch_extra_stock (
  id                   INTEGER PRIMARY KEY,
  restaurant_id        INTEGER NOT NULL,
  branch_id            INTEGER NOT NULL,
  extra_id             INTEGER NOT NULL,
  quantity             INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  low_stock_threshold  INTEGER CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
  is_available         INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0,1)),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (branch_id, extra_id),
  FOREIGN KEY (branch_id, restaurant_id) REFERENCES branches(id, restaurant_id) ON DELETE CASCADE,
  FOREIGN KEY (extra_id, restaurant_id) REFERENCES restaurant_extras(id, restaurant_id) ON DELETE CASCADE
);
CREATE INDEX idx_branch_extra_stock_extra ON branch_extra_stock(extra_id);

-- Unambiguous legacy stock: restaurants with exactly ONE branch get that branch's rows from the existing quantities.
INSERT INTO branch_stock (restaurant_id, branch_id, product_id, quantity)
  SELECT p.restaurant_id, b.id, p.id, p.stock_quantity
  FROM products p JOIN branches b ON b.restaurant_id = p.restaurant_id
  WHERE p.track_stock = 1 AND (SELECT COUNT(*) FROM branches x WHERE x.restaurant_id = p.restaurant_id) = 1;
INSERT INTO branch_extra_stock (restaurant_id, branch_id, extra_id, quantity)
  SELECT e.restaurant_id, b.id, e.id, e.stock_quantity
  FROM restaurant_extras e JOIN branches b ON b.restaurant_id = e.restaurant_id
  WHERE e.track_stock = 1 AND (SELECT COUNT(*) FROM branches x WHERE x.restaurant_id = e.restaurant_id) = 1;

ALTER TABLE orders ADD COLUMN branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL;
CREATE INDEX idx_orders_branch ON orders(branch_id);

CREATE TABLE discount_rules (
  id              INTEGER PRIMARY KEY,
  restaurant_id   INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name_ar         TEXT NOT NULL,
  name_en         TEXT NOT NULL,
  description_ar  TEXT,
  description_en  TEXT,
  scope           TEXT NOT NULL CHECK (scope IN ('product','category','restaurant')),
  kind            TEXT NOT NULL CHECK (kind IN ('percent','fixed')),
  value           INTEGER NOT NULL CHECK (value > 0),               -- percent: basis points (2000 = 20 %, at most 9000); fixed: amount in cents
  category_id     INTEGER,                                          -- scope 'category'
  starts_at       TEXT,                                             -- ISO instants, NULL = no bound
  ends_at         TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  usage_limit     INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),   -- orders that may use the rule, NULL = unlimited
  used_count      INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, restaurant_id),
  CHECK ((scope = 'category') = (category_id IS NOT NULL)),
  CHECK (kind != 'percent' OR value <= 9000),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at),
  FOREIGN KEY (category_id, restaurant_id) REFERENCES categories(id, restaurant_id) ON DELETE CASCADE
);
CREATE INDEX idx_discount_rules_rest ON discount_rules(restaurant_id, is_active);

CREATE TABLE discount_rule_products (
  rule_id        INTEGER NOT NULL,
  restaurant_id  INTEGER NOT NULL,
  product_id     INTEGER NOT NULL,
  PRIMARY KEY (rule_id, product_id),
  FOREIGN KEY (rule_id, restaurant_id) REFERENCES discount_rules(id, restaurant_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, restaurant_id) REFERENCES products(id, restaurant_id) ON DELETE CASCADE
);
CREATE INDEX idx_discount_rule_products_product ON discount_rule_products(product_id);

ALTER TABLE order_items ADD COLUMN discount_rule_id INTEGER REFERENCES discount_rules(id) ON DELETE SET NULL;
ALTER TABLE order_items ADD COLUMN discount_rule_name TEXT;
