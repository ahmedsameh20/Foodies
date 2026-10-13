-- PostgreSQL equivalent of SQLite migration 006_menu_bilingual_stock_extras.sql (kept in step; tests/postgres.test.js checks parity).
-- Purely additive: no row is rewritten, no data is translated. See the SQLite file for the meaning of each column.

ALTER TABLE products ADD COLUMN name_ar TEXT;
ALTER TABLE products ADD COLUMN name_en TEXT;
ALTER TABLE products ADD COLUMN description_ar TEXT;
ALTER TABLE products ADD COLUMN description_en TEXT;
ALTER TABLE categories ADD COLUMN name_ar TEXT;
ALTER TABLE categories ADD COLUMN name_en TEXT;
ALTER TABLE option_groups ADD COLUMN name_ar TEXT;
ALTER TABLE option_groups ADD COLUMN name_en TEXT;
ALTER TABLE options ADD COLUMN name_ar TEXT;
ALTER TABLE options ADD COLUMN name_en TEXT;

ALTER TABLE products ADD COLUMN original_price_cents BIGINT
  CHECK (original_price_cents IS NULL OR (price_cents > 0 AND original_price_cents > price_cents));

ALTER TABLE products ADD COLUMN track_stock BIGINT NOT NULL DEFAULT 0 CHECK (track_stock IN (0,1));
ALTER TABLE products ADD COLUMN stock_quantity BIGINT NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0);

ALTER TABLE options ADD COLUMN max_quantity BIGINT NOT NULL DEFAULT 1 CHECK (max_quantity BETWEEN 1 AND 20);

ALTER TABLE order_items ADD COLUMN product_name_ar TEXT;
ALTER TABLE order_items ADD COLUMN product_name_en TEXT;
ALTER TABLE order_items ADD COLUMN instructions TEXT;
ALTER TABLE order_items ADD COLUMN base_unit_price_cents BIGINT CHECK (base_unit_price_cents IS NULL OR base_unit_price_cents >= 0);
ALTER TABLE order_items ADD COLUMN original_unit_price_cents BIGINT CHECK (original_unit_price_cents IS NULL OR original_unit_price_cents >= 0);
ALTER TABLE order_items ADD COLUMN stock_deducted BIGINT NOT NULL DEFAULT 0 CHECK (stock_deducted >= 0);

ALTER TABLE order_item_options ADD COLUMN quantity BIGINT NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 20);
ALTER TABLE order_item_options ADD COLUMN group_name_ar TEXT;
ALTER TABLE order_item_options ADD COLUMN group_name_en TEXT;
ALTER TABLE order_item_options ADD COLUMN option_name_ar TEXT;
ALTER TABLE order_item_options ADD COLUMN option_name_en TEXT;
