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

## SaaS plans and subscriptions

Plans are data, configured in *Admin → Plans*: name, description, price, billing interval (month/year), trial days, max products, staff, branches, **orders per month**, analytics / advanced-report features, bullet points, active flag. Seeded starting points (Free, Starter, Pro, Business) are just defaults — rename or change them freely; nothing in the code depends on their names.

Each restaurant has one subscription: status `TRIALING · ACTIVE · PAST_DUE · CANCELLED · EXPIRED · SUSPENDED`, the price and interval it subscribed at (locked), start/end/trial dates, cancellation date. Lifecycle (runs every minute): trial ends → invoice + grace period (`SAAS_GRACE_DAYS`) → `EXPIRED` (public page stops taking orders, owner can still sign in and pay) → payment restores it. Limits are enforced **on the server** for products, staff, branches and orders/month, with a clear message and an upgrade link — never silently.

## Onboarding

Register → create restaurant → choose plan (free / trial / invoice + payment) → payout-account setup (card payments) → **admin review** → activated. The owner sees every step's state (Done / Pending / Action needed) on `/onboarding.html` and in the dashboard.

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
| `npm test` | 155 automated tests (in-memory SQLite + a local test double of Tap + PostgreSQL-specific tests on an embedded real PostgreSQL) |
| `npm run db:local` | Create/start a persistent local PostgreSQL (role, databases, `.env` DATABASE_URL); see `docs/DATABASE.md` |
| `npm run test:pg` | The whole suite on a real PostgreSQL server (embedded PostgreSQL 18, or `TEST_DATABASE_URL`) |
| `npm run db:sqlite-to-postgres` | One-time copy of a SQLite database into an empty PostgreSQL database |
| `npm run build` / `check` | Syntax check + SQL-injection guard (there is no bundler: nothing to compile) |
| `npm run verify` | check + tests |
| `npm run smoke -- <url>` / `linkcheck -- <url>` | End-to-end smoke run / broken-link crawl against a running server |
| `npm run payouts:weekly` | Cron entry for weekly payouts (the server also runs it hourly; duplicates are impossible) |

## Documentation

[`docs/PAYMENTS.md`](docs/PAYMENTS.md) — Tap setup, webhook URL, restaurant payouts, refunds, sandbox → live · [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — environment, TLS, Docker, backups, wildcard domains · [`docs/DATABASE.md`](docs/DATABASE.md) — **why SQLite is not the right production database for a multi-tenant SaaS, and how to move to PostgreSQL** · [`docs/SECURITY.md`](docs/SECURITY.md) — review and residual risks · [`docs/BACKUPS.md`](docs/BACKUPS.md) · [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md) — final pass/fail report and verdict.

## Limitations you should know about

- **Tap integration is unverified against a live/sandbox account** (webhook field mapping, `destinations` split semantics, USD settlement — see `docs/PAYMENTS.md`). Treat as unresolved until checked.
- **Database:** SQLite is the development / single-instance engine. **PostgreSQL is implemented** (`DATABASE_URL=postgres://…`, several instances, tested on PostgreSQL 18.4) but is untested here against a managed service over TLS; it uses a synchronous worker-thread bridge (one connection per instance), see `docs/DATABASE.md` for the trade-offs.
- **Admin 2FA is implemented (TOTP + backup codes) but must be enabled by each admin before production launch.**
- The interactive prompt of `npm run admin:create` could not be exercised in the non-interactive environment this was built in (the environment-variable mode is tested).
- Restaurant KYC happens with Tap; an admin then links the destination id. No bank/ID documents are collected here.
- No real-time push (order board polls every 20 s); one owner per restaurant; branches are counted and limited but orders are not routed per branch.
- The `Dockerfile` has not been built here (Docker unavailable). Graceful-shutdown logging is only asserted on POSIX systems.
