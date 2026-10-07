# Security review

Scope: this repository's server and frontend. Findings below were checked by tests (`tests/*.test.js`) or direct
inspection; items marked *open* are residual risk.

| Area | Result |
|---|---|
| **SQL injection** | All queries are parameterised; the few dynamic fragments are constants. `npm run check` fails the build if SQL is built from `req.*`. Hostile ids/strings are tested (`edge.test.js`). LIKE wildcards in admin search are escaped. |
| **XSS** | Strict CSP (`script-src 'self'`, no inline scripts/handlers — tested); every dynamic value goes through an escaping template; stored script payloads are tested; CSV exports neutralise spreadsheet formulas. |
| **CSRF** | Session cookie is `HttpOnly; SameSite=Lax; Secure` (prod). Cookie-authenticated writes must pass an Origin / `Sec-Fetch-Site` same-origin check (tested); bearer clients are not CSRF-able. |
| **Authentication** | bcrypt (12 rounds default), 72-byte password cap, constant-ish login timing, generic errors, rate limits on auth/mail/orders/global, JWT algorithm pinned, token revoked on logout / password change / reset / account disable (`token_version`). Reset & verification tokens are random, hashed at rest, single-use, expiring. |
| **Authorization / IDOR** | Role and tenant are read from the database on every request, never from the token or body. Restaurant routes derive the tenant from the user; every id lookup is also filtered by it; composite foreign keys block cross-tenant links. Customers see only their own orders and reports. Cross-tenant access is tested for products, orders, customers, staff, reports, categories, options and payouts. All admin endpoints are tested as 401/403 for every other role. |
| **Payment manipulation** | Prices, options, fees, tax and commission are computed on the server from DB rows; client-sent amounts are ignored (tested). Card orders stay invisible to the restaurant until the provider's payment is verified server-side. Webhooks need a valid signature, are de-duplicated and re-verified against the provider API (amount, currency, order reference). Refunds/orders/payouts are idempotent; refunds can never exceed the payment (DB `CHECK`); the ledger is append-only. |
| **Secrets** | None in the repository. `.env` is git-ignored; production refuses missing/weak secrets; logs redact keys, tokens, cookies, passwords, card-like fields and signatures (tested against a real production-mode process). The payment secret key is only used server-side. |
| **File uploads** | Owner-only, ≤ 2 MB, type decided by file *content* (PNG/JPEG/WebP magic bytes), random names, served with `nosniff`. |
| **Information exposure** | Public endpoints return only public columns; the provider destination id is never shown to restaurants or customers; error responses never include stack traces. |
| **CORS** | None enabled (same-origin app). |
| **Dependencies** | `npm audit`: 0 known vulnerabilities at the time of writing. |

## Added with the SaaS layer

| Area | Result |
|---|---|
| **Admin access** | `/admin/*` pages are authorised by the backend before any HTML is sent (anonymous → `/admin/login`, non-admin → 403 page); `/api/admin/*` checks the role from the database on every call. Tested for anonymous, customer, owner and staff. |
| **Sign-in robustness** | A stale/expired/revoked session cookie is treated as "signed out" and cleared; it can no longer make the sign-in request itself fail (regression test). |
| **Admin 2FA** | TOTP (RFC 6238, verified against the RFC test vectors) + single-use hashed backup codes; secret encrypted at rest (AES-256-GCM); each 30 s step usable once (replay-proof); a 2FA challenge token is not a session; required in production by default. |
| **Tenant isolation** | ~20 tenant endpoints verified in both directions, ids and `restaurantId/tenantId/userId` in path/body/query/header ignored, a tenant cannot approve, suspend or re-price itself. |
| **Billing integrity** | SaaS invoices are verified with the provider (amount, currency, reference `inv_<id>`) before a subscription changes; webhooks are signed, de-duplicated and re-checked; invoice and order money live in different tables. |

## Added with the payments completion

| Area | Result |
|---|---|
| **Payout-account data** | Only identifiers/statuses/masked bank. The API rejects `iban`, card, CVV, password, secret, account-number fields (owner and admin endpoints, tested). Verified/enabled is refused unless the provider confirms the destination; one destination per restaurant (unique index). |
| **Payout integrity** | Admins cannot mark a payout paid directly; `paid` needs a reference and a confirmation source (provider or admin_manual), enforced by a database CHECK; provider events are applied once (unique event id), amount+currency checked; every transition logged in `payout_events` and the audit log. |
| **Provider environment** | `sk_test_` with production (and `sk_live_` with sandbox) refuses to start; production without provider/merchant id reports MISCONFIGURED and keeps card payments off. No fake provider outside `tests/`. |
| **Secrets in UI/API** | Payment settings, system health and reports never contain keys or webhook secrets (tested). |
| **Tenant isolation** | Restaurant finance is derived from the signed-in owner's restaurant; ids/headers in the request change nothing (tested); only owners (not customers/staff) see finance. |

## Residual risks (open)

- Admin 2FA exists but each admin must enrol; it is enforced automatically only when `NODE_ENV=production` / `REQUIRE_ADMIN_2FA=1`. Backup codes are shown once; recovery for a lost authenticator + backup codes is an operator action on the server: `ADMIN_EMAIL=… npm run admin:reset-2fa` (audit-logged).
- Account existence can be inferred from registration (`409`); the login/forgot-password endpoints do not leak it.
- Tap webhook/refund/payout signature details are partly undocumented — see `docs/PAYMENTS.md`; unverifiable events are ignored, never trusted.
- SQLite is a single point of failure; take backups.
- Disabled-account and revoked-session checks cost one DB read per request (intentional).
