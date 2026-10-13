# Foodies — Multi-Tenant SaaS Platform for Restaurants

Foodies is a SaaS platform: **restaurants are the tenants** that subscribe to it, and **customers** order food from them.

```
MY SAAS PLATFORM
├── SUPER ADMIN        controls the whole platform                  (role: super_admin)  → /admin
├── RESTAURANT TENANTS each with fully isolated data                (roles: owner, staff) → /dashboard.html
│     Restaurant A · Restaurant B · Restaurant C · …
└── CUSTOMERS          order from any restaurant                    (role: customer)
```

Two **separate** money systems (never mixed in the database):

| | Who pays whom | Tables | Provider |
|---|---|---|---|
| **1. Order payments** | customer → restaurant (platform takes a commission) | `payments`, `refunds`, `ledger_entries`, `payouts` | Tap Payments (card) or cash on delivery |
| **2. SaaS subscriptions** | restaurant → platform | `subscriptions`, `saas_invoices` | Tap Payments (hosted checkout) or manual settlement by an admin |

> **Payment status, stated plainly.** Both systems talk to **Tap Payments' documented API** and are tested end-to-end
> against a local test double of it. They have **not** been run against a real or sandbox Tap account (no credentials existed).
> Until you configure Tap and complete [`docs/PAYMENTS.md`](docs/PAYMENTS.md), card payment is switched off and the platform runs on
> cash on delivery (orders) and admin-settled invoices (subscriptions). Nothing here fakes a successful payment.

## Admin panel — how to get in

```
ADMIN LOGIN:      http://localhost:3000/admin/login
ADMIN DASHBOARD:  http://localhost:3000/admin/dashboard
PRODUCTION:       https://YOUR-DOMAIN.com/admin
ADMIN CREATION:   npm run admin:create
```

`3000` is the configured default (`PORT` in `.env`). If something else already uses it, start with `PORT=3100 npm start` and use that port.

1. **Create the first Super Admin** (there is no built-in or default admin account — by design):
   ```bash
   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='a long passphrase 1' npm run admin:create
   ```
   or run `npm run admin:create` in a terminal with no variables to be asked for the details (the password is not echoed).
2. Open `/admin` (or `/admin/login`) and sign in. After sign-in a Super Admin is **always** sent to `/admin/dashboard`; restaurant owners, staff and customers never are.
3. Enable **two-factor authentication** under *Admin → Security (2FA)*. It is **mandatory in production** (`REQUIRE_ADMIN_2FA`, on by default when `NODE_ENV=production`): until an admin enrols, the admin API answers `403 mfa_enrollment_required`.

Authorisation is enforced on the **backend**: every `/admin/*` page and every `/api/admin/*` call checks the role in the database. Anonymous visitors are redirected to `/admin/login`; signed-in non-admins get **403 Forbidden**.

**Roles in this project:** `super_admin` (platform owner) · `owner` (restaurant admin) · `staff` (restaurant staff) · `customer`.

### Admin sections
Dashboard (live statistics + charts) · Restaurants (search, filter, paginate, approve, reject, suspend, activate, delete when it has no financial history, full details) · Users · Customers · Orders · Payments · Refunds · Payouts · Subscriptions · Plans (create/edit/deactivate) · Reports (9, with CSV) · Support · Settings (commission/fees) · Audit Logs · System Health · Security (2FA).

## Multi-tenancy and isolation

* Every restaurant-owned row carries `restaurant_id` (products, categories, option groups, orders, order items, payments, refunds, ledger, payouts, subscription, invoices, staff users, support tickets, settings …). Cross-table references are **composite foreign keys**, so the database itself refuses rows that mix two restaurants.
* The tenant is **never read from the request**. `GET /api/orders` (alias of `/api/manage/orders`) runs `tenantContext`, which takes the restaurant from the signed-in user's own record; every id in a URL is only used together with `AND restaurant_id = <that tenant>`. `restaurantId`, `tenantId`, `userId`, `owner_id`, `approvalStatus`, `commissionBpOverride` … in a body, query string or header are ignored. This is tested across ~20 endpoints in both directions (`tests/billing.test.js`).
* Customers are platform-wide users; a restaurant sees only those who ordered from it, and only their orders with it.

**Tenant addressing** (all work today without wildcard DNS except the subdomain form): `/restaurant/<slug>` · `/r/<slug>` · `https://<slug>.<TENANT_BASE_DOMAIN>` · an admin-assigned custom domain. Setting `TENANT_BASE_DOMAIN` plus wildcard DNS/TLS later turns on subdomains with no code change; the host only selects which *public* page is shown.

## Menu, languages, stock and extras

Everything about a dish is managed in **Dashboard → Menu**. Menu expands inside the dashboard sidebar (no second panel) into: + Add new dish ·
All dishes (grouped by category, with search and filters) · Categories · Availability & stock · Discounts & offers · Add-ons & extras · Menu settings.

* **Arabic and English for every dish** - name and description in both languages, entered by the owner (nothing is machine-translated);
  customers see the language they browse in (header switcher, RTL for Arabic) through cart, checkout and order tracking - and the dashboards, admin panel and legal pages are bilingual too - with a fallback
  to the other language when a translation is missing.
* **Original and discounted price** - the dish shows the original price struck through and the discounted price is what is charged.
* **Stock** - optional per dish; orders cannot exceed it, concurrent orders cannot oversell, and cancellations / failed payments give the
  units back exactly once. Existing dishes stay unlimited.
* **Extras** - the restaurant defines priced, bilingual extras per dish (optional or required groups, maximum quantity per extra);
  customers pick them and can add free-text **special instructions** that never change a price.
* **General extras** - bottled water, fries, sauces ...: priced, bilingual, categorised items customers add to an order *without choosing a dish*; separate
  cart / order lines, server-priced, optional stock (see `docs/MENU.md`).
* **Mobile numbers** - required (and format-checked, not SMS-verified) when registering as a customer or a restaurant owner; restaurant
  registration prefills name, mobile and email from the signed-in account.

The server recomputes every price from its own data; see [`docs/MENU.md`](docs/MENU.md) for the rules, the data model and the migration.

## SaaS plans and subscriptions

Plans are data, configured in *Admin → Plans*: name, description, price, billing interval (month/year), trial days, max products, staff, branches, **orders per month**, analytics / advanced-report features, bullet points, active flag. Seeded starting points (Free, Starter, Pro, Business) are just defaults — rename or change them freely; nothing in the code depends on their names.

Each restaurant has one subscription: status `TRIALING · ACTIVE · PAST_DUE · CANCELLED · EXPIRED · SUSPENDED`, the price and interval it subscribed at (locked), start/end/trial dates, cancellation date. Lifecycle (runs every minute): trial ends → invoice + grace period (`SAAS_GRACE_DAYS`) → `EXPIRED` (public page stops taking orders, owner can still sign in and pay) → payment restores it. Limits are enforced **on the server** for products, staff, branches and orders/month, with a clear message and an upgrade link — never silently.

## Onboarding

**Plans first:** the home page and `/plans.html` list the plans that exist in the database (price, billing period, trial, limits, features). The owner picks one, then registers; the chosen plan **code** is kept on the account by the server (never a price) and shown again, with its price, before the restaurant is created. Then: create restaurant (no branches needed) → subscription (free = active, trial = trialing, paid without trial = unpaid until the payment is confirmed) → payout-account setup (card payments) → **admin review** → activated. The owner sees every step's state (Done / Pending / Action needed) on `/onboarding.html` and in the dashboard.

**Branches** are added afterwards in *Dashboard → Team & branches* (name, contact, address and coordinates picked on the OpenStreetMap map, active/inactive; up to the plan's limit, each with its own stock). A restaurant with no branches works: the dashboard shows an empty state and a checklist, and stock lives on the dishes.

## Discounts, coupons and category pictures

* **Automatic discounts** (*Menu → Discounts & offers*): rules for dishes, a category or the whole menu, percentage or fixed. Two separate limits: **total redemption limit** and **maximum uses per customer** (default 1), enforced by the backend from a redemption ledger (`discount_redemptions`: reserved → redeemed | released) inside the order transaction. Cancelled, rejected, failed or expired orders give the use back exactly once; duplicate webhooks cannot double count.
* **Coupons** (second tab of the same page): codes customers type in the cart (normalised, unique per restaurant). Percentage (optional maximum discount) or fixed, optional minimum eligible subtotal, scope = entire order / all dishes / one category / selected dishes, start and end dates, total and per-customer limits, optional stacking. The cart calls `POST /api/public/restaurants/:slug/quote`, so every figure shown (eligible subtotal, coupon discount, tax, delivery, total) comes from the server and is re-checked whenever the cart changes. Orders keep the coupon code and discount that were applied; the dashboard shows redemptions, remaining capacity, unique customers and the discount granted. Precedence and accounting rules: [`docs/MENU.md`](docs/MENU.md).
* **Category pictures**: optional image per category (PNG/JPEG/WebP ≤ 2 MB, checked by content), shown on the customer menu and in the dashboard with a placeholder fallback.
* **Excel import** also reads workbooks saved by other tools (prefixed XML namespaces).

## Run it locally

```bash
npm install
cp .env.example .env              # development works with the defaults
npm run migrate                   # creates data/app.db (additive; backs up before upgrading)
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase 1' npm run admin:create
npm start                         # http://localhost:3000
npm run seed:sample               # OPTIONAL, development only: sample restaurants + a random one-time password
```

No demo data exists unless you run `seed:sample` (refused when `NODE_ENV=production`). The original static site lives in `legacy/` and is only served in development.

| Command | Purpose |
|---|---|
| `npm start` | Apply migrations, then start the server |
| `npm run dev` | Restart on file changes |
| `npm run admin:create` | Create a Super Admin (env vars or interactive) |
| `npm run admin:reset-2fa` | Operator recovery when an admin lost their authenticator and backup codes |
| `npm run backup` / `npm run restore -- <folder>` | Consistent backup (+uploads) and restore for SQLite or PostgreSQL; see `docs/BACKUPS.md` |
| `npm run sandbox:tap` | REAL Tap sandbox verification runner (needs credentials; prints TAP SANDBOX NOT VERIFIED without them) |
| `npm test` | 177 automated tests (in-memory SQLite + a local test double of Tap + PostgreSQL-specific tests on an embedded real PostgreSQL) |
| `npm run db:local` | Create/start a persistent local PostgreSQL (role, databases, `.env` DATABASE_URL); see `docs/DATABASE.md` |
| `npm run test:pg` | The whole suite on a real PostgreSQL server (embedded PostgreSQL 18, or `TEST_DATABASE_URL`) |
| `npm run db:sqlite-to-postgres` | One-time copy of a SQLite database into an empty PostgreSQL database |
| `npm run build` / `check` | Syntax check + SQL-injection guard + Arabic/English dictionary check (there is no bundler: nothing to compile) |
| `node scripts/dev-sandbox.js` | Start the app on a throw-away SQLite database (http://localhost:3100) to try the UI without touching the configured database |
| `npm run verify` | check + tests |
| `npm run smoke -- <url>` / `linkcheck -- <url>` | End-to-end smoke run / broken-link crawl against a running server |
| `npm run payouts:weekly` | Cron entry for weekly payouts (the server also runs it hourly; duplicates are impossible) |

## Documentation

[`docs/MENU.md`](docs/MENU.md) — **menu, Arabic/English, stock, discounts, coupons, extras, phone numbers, migrations** · [`docs/PAYMENTS.md`](docs/PAYMENTS.md) — Tap setup, webhook URL, restaurant payouts, refunds, sandbox → live · [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — environment, TLS, Docker, backups, wildcard domains · [`docs/DATABASE.md`](docs/DATABASE.md) — **why SQLite is not the right production database for a multi-tenant SaaS, and how to move to PostgreSQL** · [`docs/SECURITY.md`](docs/SECURITY.md) — review and residual risks · [`docs/BACKUPS.md`](docs/BACKUPS.md) · [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md) — final pass/fail report and verdict.

## Limitations you should know about

- **Tap integration is unverified against a live/sandbox account** (webhook field mapping, `destinations` split semantics, USD settlement — see `docs/PAYMENTS.md`). Treat as unresolved until checked.
- **Database:** SQLite is the development / single-instance engine. **PostgreSQL is implemented** (`DATABASE_URL=postgres://…`, several instances, tested on PostgreSQL 18.4) but is untested here against a managed service over TLS; it uses a synchronous worker-thread bridge (one connection per instance), see `docs/DATABASE.md` for the trade-offs.
- **Admin 2FA is implemented (TOTP + backup codes) but must be enabled by each admin before production launch.**
- The interactive prompt of `npm run admin:create` could not be exercised in the non-interactive environment this was built in (the environment-variable mode is tested).
- Restaurant KYC happens with Tap; an admin then links the destination id. No bank/ID documents are collected here.
- No real-time push (order board polls every 20 s); one owner per restaurant; email + password is the only sign-in method (no social or phone OTP); branches have no operating hours of their own.
- The `Dockerfile` has not been built here (Docker unavailable). Graceful-shutdown logging is only asserted on POSIX systems.
