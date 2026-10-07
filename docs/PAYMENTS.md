# Payments (Tap Payments)

> **TAP SANDBOX NOT VERIFIED.** No Tap credentials exist in this environment, so nothing here has been run against Tap's sandbox or
> live API. `npm test` (144 tests) uses a local test double (`tests/fakeTap.js`) and proves *this codebase's logic only*. Everything
> below marked **documented** comes from Tap's official documentation (`developers.tap.company`, read 2026-10-07 through an automated
> page summariser, so confirm critical items with Tap); everything marked **NOT VERIFIED** has not been confirmed by documentation *or* a real call.
> The real-sandbox runner is `npm run sandbox:tap` (section 12). Until it passes, card payments stay off.

## 0. The key question: how does a restaurant actually get its money?

```
Customer card / Mada / Apple Pay …            (methods shown on Tap's hosted page = what Tap enabled for the merchant account)
        │  pays on Tap's hosted checkout (3-D Secure at Tap)                     AUTOMATIC
        ▼
Tap charge on the PLATFORM's merchant account  (POST /v2/charges, merchant.id, destinations[...])
        │  split at charge time (documented): restaurant share → restaurant's Tap destination; the REMAINDER stays with the marketplace
        ├──► Platform commission  = what is not allocated to a destination        AUTOMATIC (we send only the restaurant share)
        └──► Restaurant allocation → the restaurant's Tap wallet (destination)    AUTOMATIC, only if the destination exists
                 │  Tap SETTLES the wallet to the restaurant's bank account
                 │     • automatically after Tap has approved the business (documented), on Tap's cycle
                 │       (cards: "5 business days standard" documented; mada/others NOT VERIFIED)
                 │     • or manually from Tap's dashboard if Tap disabled auto-settlement for that business at your request (documented)
                 ▼
Restaurant bank account (IBAN given to Tap during onboarding)                      DONE BY TAP — not by this platform
```
* **Automatic:** charge allocation (split) and, after KYC, Tap's own settlement to the bank.
* **Requires restaurant onboarding:** a Tap *Business* with KYC/KYB documents (identity document, commercial registration, logo) and the bank IBAN. The platform never collects these.
* **Requires Tap approval:** Tap reviews the documents; "payouts will be available" only after the business passes KYC (documented).
* **Not available:** an API that makes the platform *create* a payout. Tap's documentation exposes no create-payout endpoint (only retrieve/list/download, and the dashboard for manual payouts). So this platform does **not** pay restaurants and does not pretend to.
* **Unverified:** whether the split really lands in the destination wallet, settlement timing for mada/others, settlement currency, how refunds of already-settled money claw back, and every field/status name beyond what the docs show. These need the sandbox run.

The app therefore separates: **Earnings** (platform ledger: sales, commission, refunds, net, pending/available) from **Tap settlement** (what Tap *reports* it paid, through its Payouts API, read-only, stored in `provider_settlements`). Weekly "statements" are earnings records in this model, labelled "Weekly earnings statements", never "payouts"; they become `paid` only by a provider event (none is documented for Tap) or an explicit manual record that is labelled "recorded manually".

## 1. Two separate financial systems (never mixed)
```
SaaS billing     Restaurant ──► Tap (plain charge, no destinations) ──► Platform     saas_invoices, subscription_payment_methods, subscription_charge_attempts, saas_invoice_refunds
Marketplace      Customer ──► Tap (charge with destinations) ──► Platform commission + Restaurant destination ──► Tap settlement ──► bank
                                                                                          payments, refunds, ledger_entries, payouts(statements), payout_events, provider_settlements
```

## 2. What Tap's documentation says (answers to the verification questions)

| Question | Answer from Tap's documentation | Status |
|---|---|---|
| How is a restaurant onboarded? | Two steps: upload KYC files (`POST /v2/files`, multipart, returns `file_id`), then **Create Business** (`POST /v2/business`: bilingual name, `type` corp/indv, `entity.legal_name`, `entity.documents[]` with file ids, `entity.bank_account.iban`, `contact_person`, `brands`). Requires **Marketplace keys** (separate from Merchant keys). A newer `POST /v3/connect/lead` creates a merchant lead (`brand` required; entity/wallet/users optional; `post.url` callback). | documented |
| Is onboarding hosted by Tap? | **No hosted onboarding link is documented.** Tap's team contacts you if documents are missing. | NOT VERIFIED |
| Does the platform create the business through the API? | Possible (File + Business API) but it requires the platform to handle the restaurant's identity documents and IBAN. **This platform does not**: an admin registers the business with Tap (dashboard/API) and links the result. | design decision |
| Is `destination_id` sufficient? | It is what a charge's `destinations` needs. It does **not** prove KYC is complete: payouts only become available after Tap approves the business. | documented |
| How is destination status verified? | `GET /v2/destination/{id}` returns **identifiers only**: `id, display_name, business_id, business_entity_id, wallet_id, live_mode, created`. **There is no status/KYC field.** | documented |
| Webhook for account/KYC status? | **None documented.** Documented webhooks: charges, authorize, invoices, subscriptions (hashstring); merchant-signup / terminal-unlink / board-url notices are unrelated to restaurants. | **TAP KYC STATUS IS NOT AVAILABLE VIA API** |
| Endpoint that returns destination status | none. `GET /v2/destination/{id}` (existence + wallet/business ids). Business list/retrieve responses are not documented in enough detail to rely on. | NOT VERIFIED |
| Split request structure | `destinations: { destination: [ { id, amount, currency } ] }` on `POST /v2/charges`; "the remaining amount … goes directly to your Marketplace account". Delayed split via *Update Charge*. | documented (allocation itself NOT VERIFIED) |
| Settlement / payout model | **C + A:** destination allocation, then **Tap-controlled settlement**, automatic to the bank after KYC, or from Tap's dashboard when auto settlement is disabled on request. **No API-created payouts.** | documented |
| Payout API | Read-only: `POST /v2/payouts/list/` with `payouts.payout_id[]` and `merchants[]` → `payouts[]` with `id, status` (example `PAID_OUT`), `amount` (integer), `currency`, `merchant_id`, `wallet{id,country,bank}`, `date` (ms), `settlements_available`. A payout ID exists "whenever Tap sends funds to the merchant's bank account". Status enumeration and amount unit are **not documented**. | documented (partial) |
| Payout / settlement webhooks | **None documented** (created / processing / completed / failed / settlement completed / failed). Not implemented. | **NOT SUPPORTED (as documented)** |
| Refunds | `POST /v2/refunds`: `charge_id, amount, currency, reason` (documented values: duplicate, fraudulent, requested_by_customer), optional `reference`, `post`, **`destinations`** for split charges. Full or partial. Synchronous; success = status `REFUNDED`, code `000`. Webhook via `post.url`. | documented |
| Recurring / saved cards | Yes (card-on-file): first charge with `save_card=true` (customer phone required) returns `card.id`, `customer.id`, `payment_agreement.id`; later, `POST /v2/tokens` with `saved_card{card_id,customer_id}` gives a one-time token used as `source.id` in `POST /v2/charges` with `customer_initiated=false`, `threeDSecure=false`, `payment_agreement.id`. **No Tap-side scheduler is documented** (merchants schedule) and failed-recurring handling is not documented. A "subscriptions" webhook object is mentioned but no subscription API was found. | documented (flow); NOT VERIFIED (behaviour) |
| Methods | `source.id`: `src_all` (hosted page lists what is enabled), `src_card`, `src_sa.mada`, `src_sa.stcpay`. Apple Pay and Google Pay **appear automatically on the hosted page once Tap enables them for the merchant**. Apple Pay: KSA/SAR supported (USD "an addition"). Google Pay: documented coverage lists UAE, Oman, Kuwait, Qatar, Bahrain (+USD) — **KSA not listed**. STC Pay: KSA, SAR only, no recurring, needs account activation and an OTP step. There is **no API to list the methods enabled** for a merchant. | documented / enablement NOT VERIFIED |
| Webhook signature | `hashstring` header = HMAC-SHA256 with the **secret API key** over `x_id x_amount x_currency x_gateway_reference x_payment_reference x_status x_created` (charges, authorize, refunds); amount in the currency's standard decimals; **no timestamp** (replay is handled by event de-duplication + re-fetch). | documented |
| Sandbox | `sk_test_…` keys exist; marketplace keys come from Tap after eligibility is confirmed. Destination objects carry `live_mode`. | documented |
| Currency | SAR is the Saudi currency. USD is listed for Apple Pay/Google Pay; **USD charging/settlement/split/payout for a Saudi merchant is NOT VERIFIED**. | NOT VERIFIED |

## 3. Payment methods shown to customers
The customer page says "Pay online" and **does not name methods**: Tap's hosted page shows exactly the methods Tap enabled for the merchant account, and no API lists them. The platform's own evidence is the **observed payment sources** on completed payments (Admin → Settings → payment provider; `payments.payment_source`). Apple Pay / Google Pay / mada / STC Pay remain **NOT VERIFIED** until a sandbox/live payment with that source is recorded. Google Pay is not documented for KSA.

## 4. Provider abstraction (`server/payments/provider.js`)
Interface used by the app: `createCheckout, verifyPayment/getPayment, refundPayment, handleWebhook, getConnectedAccount, createConnectedAccount, getOnboardingLink, getAccountStatus, createPayout, getPayout, listPayouts, chargeSavedCard, createSubscription, cancelSubscription, getRefund`.
Capability levels for Tap (what `/api/admin/payment-settings` reports):

| Capability | Level |
|---|---|
| checkout, re-fetch, refunds (+ `destinations`), webhook signature, split, destination lookup, payout list/get, saved-card charge | IMPLEMENTED_UNVERIFIED |
| `getAccountStatus`, account/KYC/destination webhooks | **NOT_SUPPORTED** (no status field/webhook documented) |
| `createPayout`, payout/settlement webhooks | **NOT_SUPPORTED** (settlement is performed by Tap; nothing to create or subscribe to) |
| `createSubscription` / `cancelSubscription` | **NOT_SUPPORTED** (we schedule renewals ourselves with card-on-file) |
| `createConnectedAccount`, `getOnboardingLink`, `getRefund`, Apple Pay, Google Pay, mada, STC Pay, USD settlement | NOT_VERIFIED |

Unsupported/unverified methods throw typed `ProviderError`s (`not_supported` / `capability_not_verified`); nothing can mistake them for success.

## 5. Customer order payment flow
`checkout → order (awaiting_payment, hidden from the restaurant) → payments row → Tap hosted checkout → pay (3-D Secure) → webhook → signature → de-duplicate → re-fetch charge → amount, currency, order reference → paid (once) → order confirmed → ledger sale → earnings eligible when delivered.`
The browser's "success" is never trusted. Mismatches are recorded and the order stays unpaid; a late payment after expiry is refunded automatically; cash on delivery is a separate flow.
**Commission** = percentage (bp) + fixed, capped at the food value, from Admin → Settings, overridable per restaurant, snapshotted per order. With `PAYOUT_MODE=provider_settled` the charge carries `destinations` for the restaurant's share only; the rest is the platform's commission.

## 6. Restaurant payout account
States (derived, `services/paymentAccounts.js`): `NOT_ONBOARDED → ONBOARDING → PENDING_VERIFICATION → VERIFIED`, plus `REJECTED`, `SUSPENDED`, `DISABLED`.
1. Owner: *Finance & settlement → Set up payout account* (legal name, registration number, contact). Bank/card/password fields are rejected (400) and never stored.
2. Admin registers the business with Tap (KYC/KYB at Tap) and gets the `destination_id`.
3. Admin links it (*Restaurants → View → Payment account*). The platform calls `GET /destination/{id}`, stores `wallet_id`/`business_id`, refuses a destination whose `live_mode` disagrees with `PAYMENT_ENV`, and refuses to mark it verified/enabled unless Tap recognised it in that same request. **"Verified" therefore means: an admin confirms Tap approved the business, and Tap recognises the destination. Tap's KYC status itself cannot be read via API.**
4. One Tap destination can belong to one restaurant only (unique index).

## 7. Settlement and statements
* `provider_settled` (default, the Tap model): the restaurant dashboard shows **Earnings → Platform commission → Net earnings** and **Tap settlement** status: *waiting for verification / waiting for Tap / processing / paid by Tap / failed at Tap*. The "Settlements reported by Tap" table comes from the admin pressing *Sync settlements from Tap* (`POST /admin/settlements/sync`), which calls `POST /v2/payouts/list/` and matches payouts to restaurants by wallet id. Amounts are shown **as Tap reports them** (unit undocumented) and never used in arithmetic. A sync never marks an earnings statement paid (a Tap payout is not mapped to our weekly statements: the docs give no per-charge linkage in the payout object).
* Admin → Payouts shows a per-restaurant table: gross sales, commission, refunds, net earnings, **Tap destination ID**, settlement status, settlement currency, last **Tap payment ID**, last **Tap settlement ID** (admin only; no secrets).
* `PAYOUT_MODE=manual_transfer`: the platform pays by hand; statements → `manual_payout` → paid with a bank reference, labelled "recorded manually". `paid` can never be set without a provider confirmation or this explicit manual record (database CHECK).

## 8. Refunds
Full/partial, idempotent, capped at what remains. Reason sent to Tap is mapped to a documented value (`requested_by_customer` unless it is `duplicate`/`fraudulent`); free text stays in our database. The refund is **completed only when Tap answers `REFUNDED`**; `PENDING`/failed leave payment, order and ledger untouched. On success payment/order/ledger (commission and restaurant share reversed in proportion, exact to the cent) update atomically, and the restaurant's destination share is sent in `destinations`. Whether Tap pulls an already-settled amount back from the restaurant's bank is **NOT VERIFIED**; the platform nets it from the next earnings statement.

## 9. SaaS subscriptions and renewal
Invoice → Tap hosted checkout (plain charge, reference `inv_<id>`) → signed webhook → re-fetch → amount/currency/reference → paid → active.
**Automatic renewal (card-on-file) is implemented from Tap's documented flow but OFF by default (`SAAS_AUTO_RENEWAL=off`): AUTOMATIC RECURRING BILLING NOT VERIFIED.** When enabled: the owner opts in on payment (card saved at Tap; we store only `customer.id`, `card.id`, `payment_agreement.id`, brand, last4); when a renewal invoice is issued the server creates a one-time token and a merchant-initiated charge, then **re-fetches and verifies** the charge before marking the invoice paid; max 3 attempts, one per day, `UNIQUE(invoice, attempt)`; after that the invoice stays open for the owner to pay and the normal grace/expiry applies. Owners can turn it off at any time. No card number or CVV is ever stored.

## 10. Currency
Defaults to **SAR** (`CURRENCY=SAR`; mandatory explicit in production). Order, payment, settlement and subscription currencies are stored separately and nothing converts between them. USD is **not enabled and NOT VERIFIED**.

## 11. Configuration (exact variables)
| Variable | Required | Meaning |
|---|---|---|
| `PAYMENT_PROVIDER=tap` | yes | `none` keeps card payments off |
| `PAYMENT_ENV=sandbox\|production` | yes | `sk_test_` requires sandbox, `sk_live_` requires production; mixing refuses to start; destinations' `live_mode` must match |
| `TAP_SECRET_KEY` (alias `PAYMENT_SECRET_KEY`) | yes | **Merchant** secret key (`sk_test_…`/`sk_live_…`) used for charges, refunds, tokens, destination lookup, payouts list. Server only |
| `TAP_MERCHANT_ID` (alias `PAYMENT_MERCHANT_ID`) | production: yes | sent as `merchant.id` on charges and used to filter payouts; missing in production → **MISCONFIGURED**, card payments stay off |
| `TAP_WEBHOOK_SECRET` | no | only if Tap ever issues a separate one: Tap documents signing with the secret API key, which is the default |
| `APP_URL` | yes | https in production: redirect and `post.url` (`https://YOURDOMAIN/webhooks/tap`) |
| `CURRENCY=SAR` | production: yes | no default in production |
| `PAYOUT_MODE=provider_settled` | default | Tap-settlement model |
| `SAAS_AUTO_RENEWAL=off\|on` | no | card-on-file renewals (NOT VERIFIED) |
| Marketplace keys | **not used by this app** | Tap issues them for onboarding Businesses (File/Business API). Admins use them in Tap's tools; the app never needs them (it does not create Businesses). |
There is no per-restaurant secret; the only per-restaurant value is the destination id stored in the database.

## 12. Real Tap sandbox verification (`npm run sandbox:tap`)
`scripts/tap-sandbox.js` talks to the **real** `api.tap.company` with your `sk_test_` key (refuses live keys; refuses to run without a key and prints `TAP SANDBOX NOT VERIFIED`; never uses the test double). Steps (a person pays on Tap's hosted page with a Tap test card):
1 create charge · 2 pay, re-fetch, verify amount/currency/reference, record `payment_method` · 3 webhook delivery + `hashstring` (needs `TAP_PUBLIC_URL`) · 4 partial + remainder refund, idempotent replay · 5 destination fields (and whether any status field exists) · 6 **split charge with a destination** · 7 payouts list structure and statuses · 8 save card + merchant-initiated renewal (needs `TAP_TEST_PHONE`). Evidence (redacted JSON) goes to `sandbox-results/`.
```
TAP_SECRET_KEY=sk_test_… TAP_MERCHANT_ID=… TAP_TEST_DESTINATION_ID=… TAP_TEST_PHONE=+9665… TAP_PUBLIC_URL=https://<tunnel> npm run sandbox:tap
```
Results recorded so far: **none (no credentials) — every item is NOT VERIFIED.** Also still to be checked by hand in Tap's dashboard: wallet balances after a split, a business through KYC, an actual settlement, methods enabled (mada / Apple Pay / STC Pay), USD.

## 13. Concurrency and PostgreSQL
On SQLite, concurrent orders, duplicate webhooks (tested: 8 parallel identical webhooks → one ledger sale), concurrent refunds (tested: 8 parallel → only the amount available) and duplicate statements are safe **in a single instance** only. On **PostgreSQL** (`DATABASE_URL=postgres://…`, implemented and tested on PostgreSQL 18.4) every write transaction takes a cross-instance advisory lock, so the same guarantees hold with several app instances: tested with three separate processes (no lost updates; concurrent weekly-statement runs create exactly one statement and attach each ledger entry once). Background jobs (expiry sweeper, lifecycle, renewals, statements) run on one leader instance. See `docs/DATABASE.md`; behaviour against a managed PostgreSQL service is NOT VERIFIED.

## 14. Troubleshooting
* `provider_confirmation_required` (409) linking an account → provider not configured or destination not recognised.
* `environment_mismatch` (422) → a sandbox destination on a production deployment (or the reverse).
* `provider_capability_unavailable` (501) → the operation does not exist at Tap (e.g. create payout): Tap settles restaurants itself.
* Webhook 401 → signature field mapping; payments are still confirmed by the return-page check and the unpaid-order sweeper (both call Tap).
* Reconciliation `paid_at_provider_not_recorded` → webhook missed; use Admin → Payments → reconcile.
