# Production readiness report — Tap verification pass (2026-10-07)

## Test results (never combine these)
| Suite | Result |
|---|---|
| **Local tests, SQLite** (`npm run verify`: syntax/SQL guard + 155 tests incl. the PostgreSQL-specific ones, against the local Tap test double) | **155/155 PASS** |
| **Local tests, PostgreSQL 18.4** (`npm run test:pg`: the entire suite on a real PostgreSQL server, one schema per test app) | **155/155 PASS** |
| `npm audit` | 0 vulnerabilities |
| **Real Tap sandbox tests** (`npm run sandbox:tap`) | **0 run — TAP SANDBOX NOT VERIFIED** (no sandbox credentials in this environment; the key fields in `.env` are empty) |

The local tests prove this codebase's logic. They are **not** provider verification.

## What was established from Tap's official documentation (not from a sandbox)
* **Onboarding:** File API + Business API (Marketplace keys) or the v3 lead API; no hosted onboarding link documented; `destination_id` is what charges need but does not prove KYC.
* **Destination status:** `GET /v2/destination/{id}` returns identifiers only (no status/KYC field). **TAP KYC STATUS IS NOT AVAILABLE VIA API**; no account/KYC webhook is documented. The admin-confirmation workflow stays, now also checking `live_mode` against `PAYMENT_ENV`.
* **Settlement model = C + A:** the charge allocates the restaurant's share to its destination; **Tap settles to the bank itself** (automatic after KYC, or from Tap's dashboard when auto-settlement is disabled on request). **There is no create-payout API**, so none was built. Payouts are *retrievable* (`POST /v2/payouts/list/`), implemented read-only.
* **Payout/settlement webhooks:** none documented → none implemented (the earlier generic payout-event pipeline stays inert for Tap).
* **Recurring:** card-on-file is documented (save card → token → merchant-initiated charge with `payment_agreement`); no Tap-side scheduler or failed-recurring handling documented. Implemented behind `SAAS_AUTO_RENEWAL` (off) with our own retry schedule.
* **Methods:** hosted page shows what Tap enabled (`src_all`); Apple Pay KSA/SAR documented, Google Pay KSA **not** in documented coverage, STC Pay SAR/KSA only; no API lists enabled methods.
* **Refunds:** full/partial, synchronous, `destinations` for split charges, documented reason values.

## Code changes in this pass
* `server/payments/tap.js`: destination ids (wallet/business), richer `retrieveCharge` (card/customer/agreement ids), refund reason mapping, `chargeSavedCard`, `listPayouts`/`getPayout`, `splitPhone`, `classifyPayoutStatus`; `provider.js`: capability levels corrected to the documentation (`createPayout`, `getAccountStatus`, payout/account webhooks, subscriptions = NOT_SUPPORTED).
* New: `services/settlements.js` (read-only Tap settlement sync/state), migration `005_tap_settlement_recurring.sql` (`provider_settlements`, `subscription_payment_methods`, `subscription_charge_attempts`, wallet/business ids), card-on-file renewal in `services/subscriptions.js` + 5-minute timer in `server/index.js`.
* API: owner `GET /api/manage/settlements`, `DELETE /api/manage/subscription/payment-method`, `saveCard` on invoice payment, finance now reports `settlementModel`/`settlementState`; admin `POST /api/admin/settlements/sync`, `GET /api/admin/finance/restaurants`, payment-settings now lists observed payment sources, payout-API/account-status/webhook capability levels.
* UI: restaurant **Finance & settlement** (Earnings → Platform commission → Net earnings, "Tap settlement" status, "Weekly earnings statements", "Settlements reported by Tap", opt-in saved card); admin **Payouts** (per-restaurant finance + Tap settlement table, Sync button, no "request payout" for Tap).
* Defaults: `CURRENCY` default **SAR**; `PAYMENT_ENV` handling; `.env.example` and `docs/PAYMENTS.md` rewritten with the exact variables.
* **`scripts/tap-sandbox.js` / `npm run sandbox:tap`**: the real-sandbox runner (refuses without credentials or with a live key; records redacted evidence to `sandbox-results/`).
* Tests: `tests/tap-model.test.js` (+10), updates to existing suites for SAR.

## Real-world money flow (see `docs/PAYMENTS.md` §0)
Customer pays on Tap's hosted page → Tap charge with `destinations` (restaurant share only; the remainder, i.e. commission, stays with the platform) → restaurant's Tap wallet → **Tap settles the wallet to the restaurant's bank** after Tap has approved the business. Automatic: the split and (after KYC) Tap's settlement. Needs the restaurant: a Tap Business with KYC documents + IBAN. Needs Tap: KYC approval and enabling settlement. **Unverified: that the allocation really reaches the wallet, settlement timing/currency per method, clawback on refunds after settlement.**

## Final verdict table
```
Provider:                        Tap Payments
Real Sandbox Verification:       NOT VERIFIED
Restaurant Onboarding:           NOT VERIFIED   (manual at Tap; process documented; platform-side linking implemented and locally tested)
KYC/KYB:                         NOT VERIFIED   (TAP KYC STATUS IS NOT AVAILABLE VIA API: admin confirmation, destination existence + live_mode checked)
Marketplace Split:               NOT VERIFIED   (request structure matches docs; allocation never observed)
Restaurant Settlement/Payout:    PARTIAL        (model identified from docs: Tap-controlled settlement, no payout API; read-only Tap payout sync implemented; never observed)
SaaS Recurring Billing:          NOT VERIFIED   (AUTOMATIC RECURRING BILLING NOT VERIFIED; implemented, off by default)
Visa/Mastercard:                 NOT VERIFIED
Mada:                            NOT VERIFIED   (source id documented; enablement per merchant account)
Apple Pay:                       NOT VERIFIED   (documented for KSA/SAR; needs enabling by Tap)
Google Pay:                      NOT VERIFIED   (KSA not in documented coverage)
Refunds:                         NOT VERIFIED   (flow documented and locally tested; completion only on REFUNDED)
Webhooks:                        PARTIAL        (charge/refund hashstring documented and implemented; payout/KYC webhooks do not exist in the docs)
SAR:                             NOT VERIFIED   (default currency; settlement currency unconfirmed)
USD:                             NOT VERIFIED   (not enabled)
PostgreSQL:                      IMPLEMENTED + TESTED locally on PostgreSQL 18.4 (full suite, cross-process locking, migration, backup/restore); managed service over TLS, pg_dump and Docker NOT VERIFIED
```

## FINAL PRODUCTION VERDICT
```
NOT READY FOR PRODUCTION
```
### Blockers
1. **No Tap sandbox run.** Run `npm run sandbox:tap` with a sandbox key, merchant id, a sandbox destination id, a test phone and a public webhook URL; commit nothing but the redacted evidence; fix whatever differs (field names, `x_created`, split behaviour, refund of split charges, payouts-list parameters and amount unit).
2. **Marketplace split unobserved** — confirm in the sandbox *and* the Tap dashboard that the restaurant wallet received exactly the destination amount and the platform kept the remainder.
3. **Real restaurant settlement unobserved** — one business must pass Tap KYC and receive a Tap payout in the sandbox/live account; settlement cycle, currency and (for mada/others) timing must be confirmed in writing with Tap, together with the **marketplace eligibility** of your account and whether auto-settlement stays on.
4. **Restaurant KYC status cannot be read by API** — verification stays an admin judgement; acceptable only if Tap's approval is confirmed out-of-band for every restaurant.
5. **Payment methods unverified** (mada, Apple Pay, Google Pay, STC Pay) — none is advertised; enable on the Tap account and prove with a recorded payment.
6. **Automatic SaaS renewal unverified** — keep `SAAS_AUTO_RENEWAL=off` (invoice-based renewal works) until step 8 of the sandbox runner passes.
7. **Currency**: SAR must be confirmed as charge, settlement and split currency; USD stays disabled.
8. **PostgreSQL in your environment**: implemented and tested locally (see `docs/DATABASE.md`), but not against your managed PostgreSQL over TLS, not with `pg_dump`/`pg_restore`, and not under production load. Run `npm run test:pg`-equivalent checks (migrate, backup+restore drill, a load test) against the real service before running several instances. The synchronous bridge pauses the event loop during a query: keep the database in the same region.
