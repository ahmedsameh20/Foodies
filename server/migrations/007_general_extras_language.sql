-- General (order-level) extras and a per-account language preference.
--
-- Everything here is ADDITIVE and backward compatible: no table is rebuilt, no row is rewritten, nothing is translated.
--
-- restaurant_extras   Items a customer can add to an order WITHOUT choosing a dish (bottled water, fries, sauces ...).
--                     They belong to the restaurant, not to a dish, and are completely separate from the dish-specific extras
--                     (option_groups / options), which are untouched.
-- order_items         An order line is now either a dish (item_kind = 'dish', every pre-existing row) or a general extra
--                     (item_kind = 'extra', product_id NULL, extra_id set). The name and prices are snapshotted on the line exactly like
--                     a dish, so renaming / re-pricing / deleting an extra later never rewrites a past order.
-- users.preferred_lang  The language the person last chose (NULL = never chose), so it follows them across devices.

CREATE TABLE restaurant_extras (
  id              INTEGER PRIMARY KEY,
  restaurant_id   INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,                       -- canonical / fallback text (the English text when both are provided)
  name_ar         TEXT,
  name_en         TEXT,
  description_ar  TEXT,
  description_en  TEXT,
  category        TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('drinks','sides','sauces','other')),
  price_cents     INTEGER NOT NULL CHECK (price_cents >= 0),
  image_url       TEXT,
  is_available    INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0,1)),
  track_stock     INTEGER NOT NULL DEFAULT 0 CHECK (track_stock IN (0,1)),      -- 0 = unlimited
  stock_quantity  INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  max_quantity    INTEGER NOT NULL DEFAULT 20 CHECK (max_quantity BETWEEN 1 AND 50),  -- most a customer may add to one order
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, restaurant_id)
);
CREATE INDEX idx_restaurant_extras_rest ON restaurant_extras(restaurant_id, category, sort_order);

ALTER TABLE order_items ADD COLUMN item_kind TEXT NOT NULL DEFAULT 'dish' CHECK (item_kind IN ('dish','extra'));
ALTER TABLE order_items ADD COLUMN extra_id INTEGER REFERENCES restaurant_extras(id) ON DELETE SET NULL;
ALTER TABLE order_items ADD COLUMN extra_category TEXT;   -- snapshot of the extra's category at order time

ALTER TABLE users ADD COLUMN preferred_lang TEXT CHECK (preferred_lang IS NULL OR preferred_lang IN ('ar','en'));

-- Restaurant name / description in Arabic and English (optional; NULL = not provided, `name` / `description` stay the canonical text and fallback).
ALTER TABLE restaurants ADD COLUMN name_ar TEXT;
ALTER TABLE restaurants ADD COLUMN name_en TEXT;
ALTER TABLE restaurants ADD COLUMN description_ar TEXT;
ALTER TABLE restaurants ADD COLUMN description_en TEXT;
