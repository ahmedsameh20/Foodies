# Database

Two engines, one codebase, one synchronous data API (`server/db.js`):

| | SQLite | PostgreSQL |
|---|---|---|
| Select with | default, or `DATABASE_URL=sqlite:./data/app.db` / `DATABASE_PATH` | `DATABASE_URL=postgres://user:password@host:5432/database` |
| Use for | development, tests, demos, one small instance on one disk | **production**, several app instances, managed backups |
| Schema | `server/migrations/00N_*.sql` (forward-only, backed up before upgrade) | `server/migrations/postgres/00N_*.sql` (forward-only, one transaction each, under a lock) |
| Multi-instance | **No** (one process per file) | **Yes** (see "How consistency works") |

**PostgreSQL status (2026-10-07): implemented and tested against a real PostgreSQL 18.4 server** (`embedded-postgres` dev dependency). The complete
automated suite (155 tests) passes on **both** engines: `npm run verify` (SQLite + the PostgreSQL-specific tests, which start their own PostgreSQL) and
`npm run test:pg` (every test, including the functional ones, on PostgreSQL). **Not yet verified:** a managed PostgreSQL service (RDS, Cloud SQL, Neon, ...)
over TLS, PostgreSQL versions other than 18, `pg_dump`/`pg_restore` (not installed here), and the Docker/compose files.

## A ready-made local PostgreSQL (no installer, no Docker)
```bash
npm run db:local            # first run: creates the cluster, role "foodies", databases "foodies" + "foodies_test", writes DATABASE_URL to .env; later runs just start it
npm run migrate             # creates the schema in "foodies"
npm run test:pg             # the whole suite against "foodies_test" (each test app gets and drops its own schema)
npm run db:local -- status  # or: -- stop
```
Listens on `127.0.0.1:54320` only (override with `LOCAL_PG_PORT`), scram-sha-256 password auth, the `foodies` role is not a superuser, all passwords are random and live only in git-ignored files (`.env`, `.pg-test.env`, `data/postgres.superuser`). Data is in `data/postgres/`; it keeps running until you stop it or reboot (run `npm run db:local` again). The tests refuse to touch the `foodies` database: `.env`'s `DATABASE_URL` is blanked inside the test process. This is a development / small-deployment convenience, not a managed service: it has no automatic backups (use `npm run backup`) and no high availability.

## Required PostgreSQL setup
```sql
CREATE DATABASE foodies ENCODING 'UTF8' TEMPLATE template0;     -- UTF8 is REQUIRED (the app refuses to migrate otherwise)
CREATE USER foodies WITH PASSWORD '<strong password>';
GRANT ALL ON DATABASE foodies TO foodies;  -- and, on PostgreSQL 15+:  \c foodies  then  GRANT ALL ON SCHEMA public TO foodies;
```
```
DATABASE_URL=postgres://foodies:<password>@db.internal:5432/foodies?sslmode=verify-full
# optional: keep the app in its own schema (it is created if missing)
DATABASE_SCHEMA=foodies
```
Then `npm run migrate` (also run by `npm start`). TLS: put `sslmode=verify-full` (and `sslrootcert=...` if your CA is private) in the URL; `node-postgres` reads it.
The role needs `CREATE` on the database (the first migration creates tables, functions `iso_now()`, `touch_updated_at()`, `ledger_append_only()` and triggers).

## How the PostgreSQL layer works (and its honest limits)
The application is written against a **synchronous** API (`db.prepare(sql).get/all/run`, `tx(db, fn)`), ~370 call sites. Rewriting all of them to `async/await`
would have re-opened every money flow, so instead:
* the `pg` driver runs in a **worker thread** (`server/pg/worker.js`) and the calling thread blocks on it with `Atomics.wait` (`server/pg/sync-client.js`), exactly like SQLite blocks inside `node:sqlite`;
* SQL is written once in portable form; `server/pg/translate.js` rewrites the handful of SQLite idioms (`?` → `$n`, `strftime(...)` → `iso_now()`, `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`, `LIKE` → `ILIKE`, `$n IS NULL` typing, `RETURNING id` for `lastInsertRowid`);
* constraint errors are mapped back to the codes/wording the app already handles (`SQLITE_CONSTRAINT_UNIQUE`, …) and a savepoint around each write inside a transaction keeps "catch the error and carry on" working;
* money stays `BIGINT` integer minor units, timestamps stay ISO-8601 UTC `TEXT`, so both engines return identical values.

Consequences you should know about:
* **One connection per app instance, strictly sequential.** Throughput per instance is bounded by database round-trip latency, and the event loop is paused while a query runs (as with SQLite). Fine for a restaurant marketplace at moderate scale; add instances rather than expecting one instance to scale. Keep the database close (same region/VPC).
* This is a pragmatic bridge, not a fully async data layer. If you outgrow it, the migration path is mechanical (`await` the calls; the SQL and schema do not change).

## How consistency works with several instances
* **Write transactions are serialised across all instances** by a transaction-scoped advisory lock taken by `tx()` (`pg_advisory_xact_lock`). This is the PostgreSQL equivalent of SQLite's single writer, so refund caps, one-payout-per-week, ledger entries, order numbers, plan limits and webhook de-duplication behave exactly as tested. Reads are not blocked. Tested with three separate processes (no lost updates; exactly one weekly statement).
* The constraints (unique indexes, composite tenant FKs, CHECKs, the append-only ledger trigger) are enforced by PostgreSQL itself, independently of the lock.
* **Background jobs** (unpaid-order sweeper, subscription lifecycle, weekly statements, card renewals) run on the instance that holds a session-level advisory lock; if it dies another takes over.
* Still **per instance** (not shared): the in-memory rate limiter (limits apply per instance; enforce a global limit at your proxy/CDN) and `uploads/` (use a shared volume or object storage when running more than one instance).
* A long transaction on one instance delays writes on the others; the code keeps transactions short (no network calls inside a transaction).

## Moving an existing SQLite installation to PostgreSQL
```bash
npm run backup                                   # safety copy (SQLite)
# stop the app, then:
export DATABASE_URL=postgres://foodies:...@host:5432/foodies
export DATABASE_PATH=./data/app.db               # the SQLite source
npm run db:sqlite-to-postgres                    # migrates the empty target, copies every table in one transaction, verifies row counts
npm start                                        # now running on PostgreSQL
```
Order is derived from the foreign keys; `users`↔`restaurants.owner_id` is linked afterwards; identity sequences are advanced past the copied ids. The target must be empty
(it refuses otherwise) and SQLite is never modified: roll back by pointing the app at the SQLite file again. Tested on the seeded sample data (`tests/postgres.test.js`).

## Schema parity
Every new SQLite migration needs a matching PostgreSQL file under `server/migrations/postgres/`. `tests/postgres.test.js` compares tables, columns and indexes of both engines and fails on drift.
`scripts/gen-pg-schema.js` regenerates a full PostgreSQL schema from the final SQLite schema as a starting point.

## Backups
See `docs/BACKUPS.md` (`npm run backup` / `restore` for both engines; use managed point-in-time recovery or `pg_dump` in production).

## Known differences handled
`COLLATE NOCASE` email uniqueness → unique index on `lower(email)` (and emails are lower-cased by the app); `LIKE` case-insensitivity → `ILIKE`; strict `GROUP BY`; reserved words as aliases (`day`, `month`) are written `AS day`; camelCase aliases are quoted; hostile ids (`3.14`, `1e999`) match no row instead of raising a type error.
