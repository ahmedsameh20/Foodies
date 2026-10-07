-- Multi-tenant schema. Every restaurant-owned table carries restaurant_id, and
-- cross-table references use composite foreign keys (id, restaurant_id) so the
-- database itself refuses rows that mix data from two tenants.

CREATE TABLE plans (
  id                INTEGER PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  price_cents       INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  currency          TEXT NOT NULL DEFAULT 'USD',
  max_menu_items    INTEGER,              -- NULL = unlimited
  max_branches      INTEGER,
  max_staff         INTEGER,
  analytics         INTEGER NOT NULL DEFAULT 0 CHECK (analytics IN (0,1)),
  advanced_reports  INTEGER NOT NULL DEFAULT 0 CHECK (advanced_reports IN (0,1)),
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE restaurants (
  id                  INTEGER PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  logo_url            TEXT,
  phone               TEXT,
  email               TEXT,
  address             TEXT,
  city                TEXT,
  currency            TEXT NOT NULL DEFAULT 'USD',
  tax_rate_bp         INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000), -- basis points
  delivery_fee_cents  INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee_cents >= 0),
  min_order_cents     INTEGER NOT NULL DEFAULT 0 CHECK (min_order_cents >= 0),
  accepting_orders    INTEGER NOT NULL DEFAULT 1 CHECK (accepting_orders IN (0,1)),
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),  -- platform-level suspension
  is_demo             INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE users (
  id             INTEGER PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  name           TEXT NOT NULL,
  phone          TEXT,
  role           TEXT NOT NULL CHECK (role IN ('super_admin','owner','staff','customer')),
  restaurant_id  INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- staff always belong to a restaurant; customers and super admins never do
  CHECK (
    (role IN ('owner','staff') AND (restaurant_id IS NOT NULL OR role = 'owner')) OR
    (role IN ('customer','super_admin') AND restaurant_id IS NULL)
  )
);
CREATE INDEX idx_users_restaurant ON users(restaurant_id);

CREATE TABLE subscriptions (
  id                   INTEGER PRIMARY KEY,
  restaurant_id        INTEGER NOT NULL UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE,
  plan_id              INTEGER NOT NULL REFERENCES plans(id),
  status               TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','cancelled','suspended')),
  provider             TEXT NOT NULL DEFAULT 'demo',   -- 'demo' until a real gateway is wired in
  provider_ref         TEXT,
  current_period_end   TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE branches (
  id             INTEGER PRIMARY KEY,
  restaurant_id  INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  address        TEXT,
  phone          TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_branches_restaurant ON branches(restaurant_id);

CREATE TABLE categories (
  id             INTEGER PRIMARY KEY,
  restaurant_id  INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (id, restaurant_id),
  UNIQUE (restaurant_id, name)
);

CREATE TABLE products (
  id             INTEGER PRIMARY KEY,
  restaurant_id  INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id    INTEGER,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  price_cents    INTEGER NOT NULL CHECK (price_cents >= 0),
  image_url      TEXT,
  is_available   INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, restaurant_id),
  FOREIGN KEY (category_id, restaurant_id) REFERENCES categories(id, restaurant_id)
);
CREATE INDEX idx_products_restaurant ON products(restaurant_id, category_id);

CREATE TABLE orders (
  id                  INTEGER PRIMARY KEY,
  restaurant_id       INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id         INTEGER NOT NULL REFERENCES users(id),
  order_number        INTEGER NOT NULL,                -- sequential per restaurant
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','confirmed','preparing','ready','completed','cancelled')),
  order_type          TEXT NOT NULL CHECK (order_type IN ('delivery','pickup')),
  payment_method      TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash')),
  payment_status      TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid')),
  customer_name       TEXT NOT NULL,
  customer_phone      TEXT NOT NULL,
  delivery_address    TEXT,
  notes               TEXT,
  subtotal_cents      INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  tax_cents           INTEGER NOT NULL CHECK (tax_cents >= 0),
  delivery_fee_cents  INTEGER NOT NULL CHECK (delivery_fee_cents >= 0),
  total_cents         INTEGER NOT NULL CHECK (total_cents >= 0),
  currency            TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, restaurant_id),
  UNIQUE (restaurant_id, order_number)
);
CREATE INDEX idx_orders_restaurant ON orders(restaurant_id, status, created_at);
CREATE INDEX idx_orders_customer ON orders(customer_id, created_at);

-- Snapshot of what was bought: name and unit price are copied at purchase time,
-- so later menu edits never rewrite order history.
CREATE TABLE order_items (
  id                INTEGER PRIMARY KEY,
  order_id          INTEGER NOT NULL,
  restaurant_id     INTEGER NOT NULL,
  product_id        INTEGER,
  product_name      TEXT NOT NULL,
  unit_price_cents  INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  quantity          INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  line_total_cents  INTEGER NOT NULL CHECK (line_total_cents >= 0),
  FOREIGN KEY (order_id, restaurant_id) REFERENCES orders(id, restaurant_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, restaurant_id) REFERENCES products(id, restaurant_id) ON DELETE SET NULL
);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_restaurant ON order_items(restaurant_id, product_id);

CREATE TABLE order_status_history (
  id             INTEGER PRIMARY KEY,
  order_id       INTEGER NOT NULL,
  restaurant_id  INTEGER NOT NULL,
  status         TEXT NOT NULL,
  changed_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (order_id, restaurant_id) REFERENCES orders(id, restaurant_id) ON DELETE CASCADE
);

-- Restaurant-specific customer relationship (who has ordered from which tenant).
CREATE TABLE restaurant_customers (
  id               INTEGER PRIMARY KEY,
  restaurant_id    INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_order_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (restaurant_id, user_id)
);
