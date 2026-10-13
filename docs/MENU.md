# Menu, localization, stock, pricing and extras

This document describes how the menu works end to end: what is stored, which rules the **server** enforces, how Arabic / English is
handled, and how an order line is priced. Everything here applies to both database engines (SQLite and PostgreSQL).

## Migration (additive, backward compatible)

| Engine | File | Applied by |
|---|---|---|
| SQLite | `server/migrations/006_menu_bilingual_stock_extras.sql` | `npm run migrate` / `npm start` |
| PostgreSQL | `server/migrations/postgres/002_menu_bilingual_stock_extras.sql` | `npm run migrate` / `npm start` |
| SQLite | `server/migrations/007_general_extras_language.sql` | `npm run migrate` / `npm start` |
| PostgreSQL | `server/migrations/postgres/003_general_extras_language.sql` | `npm run migrate` / `npm start` |
| SQLite | `server/migrations/008_branches_stock_discounts.sql` | `npm run migrate` / `npm start` |
| PostgreSQL | `server/migrations/postgres/004_branches_stock_discounts.sql` | `npm run migrate` / `npm start` |

Nothing is rebuilt, deleted or rewritten, and **no text is translated**. After the migration every existing dish:

* keeps its name, description and price (`price_cents` is still the price a customer pays);
* has no discount (`original_price_cents` is `NULL`);
* is **unlimited** (`track_stock = 0`) - it is never silently treated as "out of stock";
* has no Arabic / English text of its own (`name_ar`, `name_en`, ... are `NULL`). Customers see the existing text in both languages
  until the owner writes the translation; the dashboard flags such dishes ("Missing Arabic / English").

Before changing an existing SQLite file, `npm run migrate` saves a `.pre-006_menu_bilingual_stock_extras.bak` copy next to it.
Parity between the two engines is checked by `tests/postgres.test.js` (table by table, column by column) and the upgrade of a
database that already holds data is tested on both (`tests/menu.test.js`, `tests/postgres.test.js`).

## Data model

| Table | New columns |
|---|---|
| `products` | `name_ar`, `name_en`, `description_ar`, `description_en`, `original_price_cents`, `track_stock`, `stock_quantity` |
| `categories`, `option_groups`, `options` | `name_ar`, `name_en` |
| `options` | `max_quantity` (1-20) |
| `order_items` | `product_name_ar`, `product_name_en`, `instructions`, `base_unit_price_cents`, `original_unit_price_cents`, `stock_deducted` |
| `order_item_options` | `quantity`, `group_name_ar/en`, `option_name_ar/en` |

Extras use the **existing** `option_groups` / `options` tables (a group per dish with `min_select` / `max_select`, each option with a price),
extended with bilingual names and a maximum quantity. No parallel model was created. `name` / `description` remain the canonical,
always-filled text (the English text when the owner provides both) and the fallback wherever a translation is missing.

Constraints in the database itself: `original_price_cents > price_cents > 0` when a discount exists, `stock_quantity >= 0`,
`max_quantity BETWEEN 1 AND 20`, `quantity BETWEEN 1 AND 20`.

## Pricing

```
unit price  = discounted price when a discount is active, otherwise the original price      (products.price_cents)
one dish    = unit price + sum(extra price x extra quantity)
line total  = one dish x dish quantity
subtotal    = sum of line totals;   total = subtotal + tax + delivery + service fee          (unchanged platform rules)
```

Example: Burger, original 30.00, discounted 25.00; extras cheese 5.00 x 1 and tomatoes 2.00 x 2; quantity 2
-> one burger = 25 + 5 + 4 = **34.00**, the line = **68.00**.

* The customer's request carries only ids, quantities and text. **Prices are never read from it** (a `priceCents` sent for a line or an
  extra is ignored); `priceCart()` in `server/services/orders.js` reads every amount from the database.
* The browser shows a running estimate with the same formula (`public/js/pricing.js`); `tests/frontend.test.js` checks that browser and
  server agree, including on the worked example above.
* The dish price, the pre-discount price, the extras (name, price, quantity) and the instructions are **snapshotted** on the order
  line, so editing or deleting the dish or its extras later never changes a past order.
* Discounts are validated on write: original price >= 0 (whole minor units), discounted price > 0 and lower than the original. Removing a
  discount (`discountedPriceCents: null`) returns the dish to its original price. A legacy client that sends only `priceCents` sets the
  price and clears any discount.

## Stock

Stock is **opt-in per dish** (`track_stock`). For tracked dishes a customer can order at most `stock_quantity` units in total (several
cart lines of the same dish count against the same stock).

* Checked when the order is priced **and** taken in the same transaction with a single conditional
  `UPDATE ... SET stock_quantity = stock_quantity - ? WHERE ... AND stock_quantity >= ?` (`server/services/inventory.js`). Write
  transactions are serialised (SQLite `BEGIN IMMEDIATE`, PostgreSQL advisory lock), so two orders can never both take the last unit; the
  database also refuses a negative quantity.
* Each order line records how many units it took (`stock_deducted`). Cancelling or rejecting an order, a failed or expired card payment
  and a late-payment race all call `restoreForOrder()`, which zeroes that counter as it restores - **stock goes back exactly once**.
  Delivered orders are never restored (the food was consumed).
* Card orders reserve stock while awaiting payment and give it back if the payment fails or the order expires.
* Restocking uses an atomic *add* (`PATCH /api/manage/products/:id/stock {restockBy}`) so it is safe while orders are arriving. The dish
  form only sends the quantity when the owner actually edited it.
* A dish is orderable when it is switched on **and** (stock is not tracked **or** quantity > 0). Zero stock shows "Sold out" to
  customers and "Out of stock" to the owner automatically.

Errors: `insufficient_stock` (422, with the quantity left), `out_of_stock`, `item_unavailable`.

## Localization (Arabic / English)

The whole application is bilingual: customer pages, sign-in / registration / password reset, the restaurant dashboard (every section),
the legal pages, error pages and the platform admin panel.

* `public/js/i18n.js` loads `locale-en.js` / `locale-ar.js`, which spread the feature modules in `public/js/locales/<lang>/`
  (`extras.js`, `dashboard.js`, `pages.js`, `admin.js`). `t('key', { vars })` falls back to English and then to the key itself; a third
  language is a new `locales/<lang>/` folder plus one line in `i18n.js`.
* The language is the visitor's choice (header switcher on every page, or `?lang=ar`), kept in `localStorage`, so it is the same from
  browsing through cart, checkout and order tracking. Default: the browser language when it is Arabic, otherwise English. Switching reloads the
  page; the cart (`localStorage`), dashboard filters (`sessionStorage`) and registration / onboarding drafts survive it.
* A signed-in person's choice is also saved on the account (`users.preferred_lang`, `PATCH /api/auth/me { "lang": "ar" }`) and adopted at the
  next sign-in on any device.
* Arabic switches `<html dir="rtl" lang="ar">`. The stylesheet uses logical properties (`margin-inline-start`, `inset-inline-*`, `text-align: start`),
  so sidebars, tables, dialogs and the nested menu mirror. Phone numbers, emails, ids and prices are isolated (`dir="ltr"` / `<bdi>`); time-axis charts stay left-to-right.
* `npm run check` fails when the two dictionaries differ, when a key used in the code is missing, or when a dynamic family
  (`status.*`, `err.*`, `sub.status.*`, `adm.cap.*` ...) lacks a member.
* Restaurant-written content (dish, category, extra, restaurant name / description) is stored in both languages and shown with `loc()`: the
  visitor's language, then the other language, then the legacy text - never an empty label. Search matches both languages. Restaurants have
  optional `name_ar / name_en / description_ar / description_en` (Profile & settings); the canonical `name` stays the fallback and the web address source.
* Server validation errors carry a stable `details.reason`, all other errors a stable `code`; the UI translates both. Raw server text is never
  shown in Arabic (an unknown code shows the generic message), and stack traces / database errors never reach the browser.
* Not translated on purpose: free text entered by users (names, addresses, notes), provider / bank references, and the diagnostic sentences
  the server writes for operators (they are translated while still the unedited defaults).

## Restaurant-defined extras and customer customization

* The owner defines, per dish, groups of extras: bilingual names, price, enabled switch, **maximum quantity per extra**, whether the group
  is required (`min_select`) and how many different extras may be chosen (`max_select`, defaulting to "all of them"). Extras can be
  reordered and removed. Saved atomically with the dish (`optionGroups` on `POST/PUT /api/manage/products`); extras keep their ids when
  edited so carts and history stay linked.
* The customer picks extras (with quantities where the owner allows more than one) and may add **free-text special instructions**
  (<= 300 characters, plain text, control characters stripped). Instructions are stored on that order line, shown to the restaurant, and
  **never create or change a price**. Different instructions or extras mean different order lines.
* The server validates every id, quantity, group limit and availability (`invalid_option`, `option_unavailable`,
  `option_quantity_exceeded`, `invalid_option_count`).

## General (order-level) extras

Besides the extras that belong to a dish (above), a restaurant can offer **general extras**: items a customer adds to an order without
choosing a dish - bottled water, soft drinks, fries, garlic sauce, ketchup ... They live in their own table, `restaurant_extras`
(`restaurant_id`, bilingual `name_ar/name_en`, optional `description_ar/description_en`, `category` = drinks | sides | sauces | other,
`price_cents`, `image_url`, `is_available`, `track_stock` / `stock_quantity`, `max_quantity` per order). Dish extras (`option_groups` / `options`) are untouched.

* **Dashboard:** Menu -> *Add-ons & extras* has two tabs, *Dish extras* and *General extras* (create / edit / delete with image upload, category
  filter, availability switch). Stock and availability of general extras are also in *Availability & stock* (staff may use that page).
* **Customer:** the restaurant page has an *Extras* section grouped by category. An extra can be added without a dish; the card turns into a
  quantity stepper and the cart shows it as its own line (badge "Extra"). The cart persists in `localStorage` like dish lines.
* **Order:** a general extra is an `order_items` row with `item_kind = 'extra'`, `product_id = NULL` and `extra_id`; name (both languages),
  category and unit price are snapshotted, so renaming, re-pricing or deleting the extra later never changes a past order. Totals are
  `sum(line totals)` over dish lines and extra lines (no extra is counted twice); the minimum order amount counts them too. An order may contain
  only general extras. They show as separate lines in the customer's order page, the restaurant's order cards and the admin order dialog.
* **Server rules:** the request carries only `extras: [{ extraId, quantity }]`; the price always comes from `restaurant_extras`. Every id is checked
  together with the restaurant (`invalid_extra`), unavailable extras are refused (`extra_unavailable`), quantities above the extra's maximum
  (duplicates are added up first) fail with `extra_quantity_exceeded`, and tracked stock is taken in the same transaction as the order with one
  conditional `UPDATE ... AND stock_quantity >= ?` (`insufficient_stock` / `out_of_stock`). Cancelling / rejecting / an expired payment gives the stock back
  exactly once (the same `stock_deducted` counter as dishes). General extras never appear in "Top dishes".

## Registration phone numbers

* `POST /api/auth/register` and `/register-owner` require `phone`; it is validated and stored in E.164 (`+966500000000`; spaces, dashes,
  a `00` prefix and Arabic-Indic digits are accepted and normalised) on `users.phone`. It is **not verified** - no SMS provider is configured
  and the UI says so.
* The owner's personal number lives on the account. The restaurant keeps its own, separate public `phone` / `email`.
* Accounts created before this change keep working with no phone (`phoneMissing: true`). They add one with `PATCH /api/auth/me` (checkout
  does this automatically on their next order) and a legacy owner must give one when registering the restaurant.
* Restaurant registration prefills the owner's name, mobile number and email from the signed-in account (read from the server, never from
  another user's data), keeps drafts per user for the tab session (wiped on sign-out), and updates the **same** account instead of creating
  another one.

## API summary (restaurant dashboard, all tenant-scoped)

| Call | Notes |
|---|---|
| `GET /api/manage/products` · `GET /api/manage/products/:id` | list with extras counts; one dish with its extras groups |
| `POST /api/manage/products` · `PUT /api/manage/products/:id` | `nameAr nameEn descriptionAr descriptionEn originalPriceCents discountedPriceCents trackStock stockQuantity categoryId isAvailable imageUrl optionGroups` (owner) |
| `PATCH /api/manage/products/:id/stock` | `{trackStock?, quantity? \| restockBy?}` (owner **and staff**) |
| `PATCH /api/manage/products/:id/availability` | owner and staff |
| `GET/POST /api/manage/products/:id/option-groups`, `PUT/DELETE /api/manage/option-groups/:id` | one extras group at a time (owner) |
| `GET/POST/PUT/DELETE /api/manage/categories` | `nameAr` + `nameEn` (or legacy `name`) |
| `GET/POST /api/manage/extras`, `PUT/DELETE /api/manage/extras/:id` | general extras (list: owner and staff; create / edit / delete: owner) |
| `PATCH /api/manage/extras/:id/availability`, `/stock` | owner and staff; same body as for dishes (`quantity` or `restockBy`) |
| `POST /api/public/restaurants/:slug/orders` | `items[]: {productId, quantity, options:[{optionId, quantity}], instructions}` (the legacy `optionIds` still works), plus `extras[]: {extraId, quantity}` (items may then be empty) |
| `PATCH /api/auth/me` | `{name?, phone?, lang?}` for the signed-in user (`lang` is `ar` or `en`) |

Authorization: every id from the URL or body is only ever used together with the signed-in user's own restaurant; customers get 403,
anonymous callers 401, staff may only switch dishes on/off and adjust stock. Hostile ids (`3.14`, `1e999`, `abc`, ...) are a plain 404.

Legacy API calls keep working: `name` / `description` / `priceCents` (create and update), `optionIds`, and the one-name group payload.
Updating the single-language `name` of a dish that already has Arabic/English text is refused with a clear message.

## Fixes made along the way

* Deleting a dish, an extra or a group that had ever been ordered failed with a constraint error (the composite foreign key tried to
  `SET NULL` a `NOT NULL` column). References are now detached explicitly; past orders keep their snapshots.

## Branches, per-branch stock, discount rules, Excel import/export (migration 008 / PostgreSQL 004)

The migration is additive: nothing is rewritten or deleted. Run `npm run migrate` (also done by `npm start`); never reset a production database.

### Branches and maps
* `branches` (already existed) gains `name_ar`, `name_en`, `latitude`, `longitude` (range-checked), `address_components` (JSON) and `is_active`.
  There is **one** branch model: registration, the dashboard and ordering all use it. A restaurant is one account with any number of branches (up to 100; the plan's `max_branches` limits additions from the dashboard).
* Registration (`/onboarding.html`): restaurant details with a map location, then the branches step (a count, add / remove, ONE editor + map open at a time so 15+ branches stay manageable), a review step with a map of all branches (numbered, distinctly coloured markers) and a single `POST /api/onboarding/restaurant` that creates the restaurant, subscription, payment account and **all branches in one transaction**. The wizard keeps everything typed (this tab only) when going back; the request carries an `Idempotency-Key`, so a retry returns the first result instead of creating a second restaurant or duplicate branches. Branch locations are mandatory there; the dashboard keeps them optional for branches created before maps existed. The plan is chosen after creation; plans whose branch limit is lower than the number of branches are disabled in the plan step.
* Map: Leaflet served from `/vendor/leaflet` (the strict CSP allows no CDN). Tiles come from `MAP_TILE_URL` (default: OpenStreetMap, attribution shown). Address search is proxied by `GET /api/geo/search` / `/api/geo/reverse` (signed-in users, rate limited, cached, one upstream request per `GEOCODER_MIN_INTERVAL_MS`, identifying User-Agent). Configure `GEOCODER_URL` for a self-hosted / commercial Nominatim-compatible service; the public service forbids autocomplete and bulk use. If search is off, rate limited or offline the map still works by clicking, dragging the marker or typing the coordinates. No API keys are used or exposed.
* A branch that already has orders cannot be deleted (`branch_has_orders`): deactivate it.

### Stock per branch
* `branch_stock` / `branch_extra_stock`: one row per branch and dish (extra), `UNIQUE (branch_id, product_id)`, `quantity`, optional `low_stock_threshold` (default 5), per-branch `is_available`, `updated_at`. The composite foreign keys make cross-restaurant rows impossible.
* `products.track_stock` stays the switch "is this tracked". The quantity lives on the dish **only while the restaurant has no active branch** (behaviour unchanged). Once it has branches the branch rows are authoritative; an item without a row at a branch has no stock there.
* **Migration of existing stock**: a restaurant with exactly one branch gets that branch's rows copied from the existing quantities. With several branches nothing is assigned silently: the legacy quantity is preserved on the dish, the Availability & stock page shows a warning (`GET /api/manage/stock/branches` -> `legacy`) and the owner chooses the branch (`POST /api/manage/stock/adopt-legacy`). The first branch of a restaurant created later adopts the dish-level stock automatically (unambiguous).
* **Ordering**: the order's branch is `branchId` from the customer's branch picker; a single branch is used automatically; a delivery with coordinates goes to the nearest located branch; otherwise `422 branch_required`. Stock is validated against that branch and decremented by one conditional `UPDATE ... WHERE quantity >= ?` inside the serialised write transaction (no overselling, also across instances). A branch without stock never borrows from another branch. `orders.branch_id` remembers the branch, so cancel / reject / expiry restore exactly the units taken, to the same branch, once (the `order_items.stock_deducted` counter is claimed first).
* Dashboard: `/dashboard.html#menu/stock` - a searchable branch picker (summary badges per branch), filters (available / low / out / unlimited / switched off), edit quantity, restock (+N, atomic), low-stock threshold, availability at this branch. Staff may use it.
* The dish form with exactly one branch maps its quantity to that branch; with several branches the field is hidden and the API answers `409 use_branch_stock` rather than guessing.

### Discount rules
* `discount_rules` (scope `product` | `category` | `restaurant`, kind `percent` (basis points, at most 90 %) | `fixed` (cents), Arabic/English name and description, `starts_at` / `ends_at`, `is_active`, optional `usage_limit`) and `discount_rule_products`. Rules are evaluated when a price is needed, so a rule change reaches every eligible dish with no edit of the dishes, and no per-dish discount copies are created.
* **Precedence (the one pricing rule, `server/services/discounts.js`)**: 1. a dish with its own discounted price (`original_price_cents`) keeps it; 2. otherwise the most specific active rule: dish rule > category rule > restaurant rule; 3. within a level the lowest final price wins, a tie goes to the oldest rule. **Rules never stack.** A rule that would make a price zero or negative is skipped for that dish; creating a fixed amount that would do so for a selected dish is rejected.
* The same function prices the public menu, the cart/checkout check (`priceCart`) and the order snapshot (`order_items.unit_price_cents`, `original_unit_price_cents`, `discount_rule_id`, `discount_rule_name`), so the displayed price, cart price, checkout total and order always agree. Rules are always scoped by `restaurant_id`; a usage limit counts orders (one per order per rule, not given back on cancellation) and is enforced by a conditional UPDATE. Discounts are restaurant-wide: the platform has no per-branch prices.
* API (owner): `GET/POST /api/manage/discounts`, `GET/PUT/DELETE /api/manage/discounts/:id` (the item list shows before / after prices).

### Excel import / export (All dishes page)
* `GET /api/manage/dishes/template.xlsx`, `GET /api/manage/dishes/export.xlsx`, `POST /api/manage/dishes/import/preview?mode=create|update`, `POST /api/manage/dishes/import?mode=...&skipInvalid=1` (body = the .xlsx, `Idempotency-Key` header). Owners only. Library: ExcelJS.
* Columns: ID, Name (Arabic), Name (English), Description (Arabic), Description (English), Category, Original Price, Discounted Price, Available, Track Stock, Stock Quantity (restaurants without branches) or one `Stock - <branch> (#id)` column per branch, Image URL. Prices are plain decimals (max 2 decimals).
* **Create mode** never overwrites: a dish whose English name already exists is reported as *skipped*. **Update mode** needs the dish ID (from the export) and only touches dishes of this restaurant - never matched by name. The restaurant always comes from the signed-in owner; the file has no way to name one (unknown columns are ignored and listed; branch columns of other restaurants are refused).
* Validation (server side, again on confirm): required fields, numbers, discount < price, category references, yes/no values, duplicates (in the file and existing), stock only with tracking, https/uploaded image paths only, plan limit. Errors name the **sheet row and column**. Empty *Available* means not available (nothing is published by accident). All writes are one transaction; with errors nothing is imported unless the owner chooses "import only valid rows". Summary: created / updated / skipped / failed.
* Limits: 2 MB, 1000 rows, ZIP container checked and declared uncompressed size capped (25 MB) before parsing; malformed files give a generic 400, never internals. Spreadsheet formula injection is neutralised on export.

## Plans-first onboarding, per-customer discount limits, category pictures (migration 009 / PostgreSQL 005)

### Onboarding
* `/plans.html` (public, reads `GET /api/public/plans`) is the entry point for restaurant owners. The chosen plan **code** travels in `?plan=` and `localStorage` until the account exists; `POST /auth/register-owner` validates it against `plans` and keeps it on the account (`users.pending_plan_code`). `GET/PUT /api/onboarding/plan` read/change it. Only the code is ever accepted: price, trial and limits always come from the `plans` table.
* `POST /onboarding/restaurant` uses `body.planCode` or the retained plan, creates the restaurant and its subscription exactly as before (free = active, paid with trial = trialing, paid without trial = unpaid with one open invoice, nothing active until the provider confirms) and clears the retained plan. It is idempotent per `Idempotency-Key`. Branches are no longer part of registration (the API still accepts an optional `branches` list for compatibility); owners add them in Dashboard → Team & branches. A restaurant with zero branches keeps working: the menu shows, orders are accepted and stock lives on the dishes.

### Discount limits
* `usage_limit` = total redemptions across all customers (NULL = unlimited). `max_uses_per_customer` = redemptions of the same rule by one customer (NULL = unlimited; **new rules default to 1**, rules that existed before migration 009 stay NULL so their behaviour does not change).
* `discount_redemptions` has one row per rule per order (`UNIQUE(rule_id, order_id)`): `reserved` (order placed) → `redeemed` (delivered) or `released` (cancelled, rejected, payment failed or expired). Reserved and redeemed rows count toward both limits; releasing a row gives the total count back exactly once (the status transition is the guard), so retries and duplicate webhooks cannot corrupt counts. Migration 009 back-fills one row for every existing, non-cancelled order that a rule priced.
* A signed-in customer's menu, cart and order are priced without the rules they have used up; `recordUse()` re-checks both limits inside the order transaction (write transactions are serialised, and the conditional UPDATE locks the rule row), so concurrent checkouts cannot exceed either limit. The customer is always `req.user`, never a client-supplied id.

### Category pictures
* `categories.image_url`. Set with `PUT /manage/categories/:id/image` (raw PNG/JPEG/WebP body, ≤ 2 MB, type checked from the file's bytes), removed with `DELETE …/image`; the JSON category endpoints cannot set it. Replacing, removing or deleting the category deletes the old file unless a dish, extra, logo or other category still uses it (`services/uploads.js`). Customers see it on the restaurant page (category chips and headings), with a placeholder when there is none or it fails to load.

## Coupons (migration 010 / PostgreSQL 006)
* Tables: `coupons` (code stored trimmed + upper-case, `UNIQUE(restaurant_id, code)`; scope `order` | `menu` | `category` | `product`; percent (basis points, ≤ 90 %) or fixed; optional `max_discount_cents` (percent only) and `min_subtotal_cents`; `usage_limit`, `used_count`, `max_uses_per_customer` (default 1, NULL = unlimited), `allow_stacking`), `coupon_products`, and `coupon_redemptions` (one row per coupon per order, `reserved` → `redeemed` | `released`, with the code and the discount granted). `orders` gets `coupon_id`, `coupon_code`, `coupon_discount_cents`, so history never depends on the coupon row; a coupon with redemptions can only be disabled, not deleted.
* API: owner-only `GET/POST /manage/coupons`, `GET /manage/coupons/generate-code`, `GET/PUT/DELETE /manage/coupons/:id` (detail includes statistics and the redemption history without customer contact data); customers `POST /public/restaurants/:slug/quote` (prices the cart, with an optional `couponCode`, writes nothing) and `couponCode` on `POST …/orders`.
* **Precedence policy.** (1) Dish prices: a dish's own discounted price, else the most specific automatic rule (dish > category > whole menu). (2) A coupon applies to the already-priced cart and, unless the coupon allows stacking, only to dishes without a discount. (3) The scope sets the eligible subtotal (`order` also counts general extras; `menu` all dishes; `category`; `product`); the minimum is compared with the eligible subtotal. (4) Discount = % of the eligible subtotal (capped) or the fixed amount, never more than the eligible subtotal and never the whole order (at least 1 cent stays payable). One coupon per order; there are no platform promotions. (5) The discount is deducted before tax; the service fee and the commission are charged on the discounted food value (`computeOrderTotals`, unchanged), so the restaurant bears the coupon like any price reduction and the settlement model is untouched.
* Limits and lifecycle are the same as for automatic discounts (see above): the order transaction re-checks both limits (conditional UPDATE on the coupon row + per-customer count), cancellation / rejection / failed or expired payment release the use exactly once, delivery makes it final.
