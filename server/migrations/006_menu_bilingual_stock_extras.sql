-- Menu upgrade: bilingual (Arabic / English) dishes, categories and extras; original + discounted price; optional stock tracking;
-- extras with a maximum quantity; per-line extras quantities, special instructions and price snapshots on orders.
--
-- Everything here is ADDITIVE and backward compatible: no table is rebuilt, no row is rewritten, no data is translated.
--   * products.name / description stay as the canonical, always-filled text and the fallback when a translation is missing.
--     name_ar / name_en / description_ar / description_en are the restaurant owner's own translations (NULL = not provided).
--   * products.price_cents stays THE SELLING PRICE (what a customer is charged). A discount is expressed by
--     original_price_cents (> price_cents) - NULL means "no discount", so every existing dish keeps charging exactly what it did.
--   * stock is opt-in: track_stock = 0 (the default for every existing dish) means unlimited, exactly the old behaviour.
--   * order history keeps its own snapshots, so editing the menu later never rewrites a past order.

------------------------------------------------------------------ bilingual content
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

------------------------------------------------------------------ pricing: original price + discounted selling price
-- original_price_cents IS NULL            -> no discount; price_cents is the price.
-- original_price_cents > price_cents > 0  -> discounted; price_cents is the discounted selling price.
ALTER TABLE products ADD COLUMN original_price_cents INTEGER
  CHECK (original_price_cents IS NULL OR (price_cents > 0 AND original_price_cents > price_cents));

------------------------------------------------------------------ stock
ALTER TABLE products ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 0 CHECK (track_stock IN (0,1));
ALTER TABLE products ADD COLUMN stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0);

------------------------------------------------------------------ extras: maximum quantity per extra
ALTER TABLE options ADD COLUMN max_quantity INTEGER NOT NULL DEFAULT 1 CHECK (max_quantity BETWEEN 1 AND 20);

------------------------------------------------------------------ order snapshots
ALTER TABLE order_items ADD COLUMN product_name_ar TEXT;
ALTER TABLE order_items ADD COLUMN product_name_en TEXT;
ALTER TABLE order_items ADD COLUMN instructions TEXT;                    -- customer's free-text request; never priced
ALTER TABLE order_items ADD COLUMN base_unit_price_cents INTEGER CHECK (base_unit_price_cents IS NULL OR base_unit_price_cents >= 0);      -- dish selling price at order time (no extras); NULL on pre-upgrade rows
ALTER TABLE order_items ADD COLUMN original_unit_price_cents INTEGER CHECK (original_unit_price_cents IS NULL OR original_unit_price_cents >= 0); -- pre-discount price at order time; NULL = no discount applied
ALTER TABLE order_items ADD COLUMN stock_deducted INTEGER NOT NULL DEFAULT 0 CHECK (stock_deducted >= 0);  -- units taken from stock; set back to 0 when restored, so a cancellation can never restore twice

ALTER TABLE order_item_options ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 20);
ALTER TABLE order_item_options ADD COLUMN group_name_ar TEXT;
ALTER TABLE order_item_options ADD COLUMN group_name_en TEXT;
ALTER TABLE order_item_options ADD COLUMN option_name_ar TEXT;
ALTER TABLE order_item_options ADD COLUMN option_name_en TEXT;
