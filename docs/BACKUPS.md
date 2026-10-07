# Backups and restore

## SQLite (what the app runs on today)

| Step | Command |
|---|---|
| Backup (safe while the server runs; consistent snapshot via `VACUUM INTO`, integrity-checked, uploads copied) | `npm run backup` → `backups/<timestamp>/{app.db,uploads/}` |
| Location / retention | `BACKUP_DIR=/mnt/backups BACKUP_KEEP=30 npm run backup` (default `./backups`, newest 14 kept) |
| Schedule | cron `0 3 * * * cd /opt/foodies && npm run backup` and **copy the folder off the host** (object storage / another machine) |
| Restore (**stop the app first**) | `npm run restore -- backups/<timestamp>` — verifies integrity, moves the current DB aside as `app.db.before-restore-<ms>` (never deletes it), restores DB + uploads |
| Then | `npm start` (re-applies any newer migrations) and check `GET /health` |

The restore path is covered by an automated test (`tests/hardening.test.js`: data written → backup → live DB deleted → restore → data present, integrity `ok`). Do a real restore drill on a scratch machine before launch and after any change of hosting.

## PostgreSQL (production)

Use the database provider's **managed backups with point-in-time recovery** as the primary safety net, and keep the application-level backup as a second, portable copy.

| Step | Command |
|---|---|
| Backup | `npm run backup` with `DATABASE_URL=postgres://...`: uses `pg_dump --format=custom` (`pg.dump`) when `pg_dump` is on the PATH, otherwise a **logical NDJSON snapshot** of every table taken in one REPEATABLE READ transaction (`manifest.json` + `<table>.ndjson`). `uploads/` is copied alongside. |
| Schedule / retention | cron daily, `BACKUP_KEEP=14` (default) prunes older folders; copy `backups/` off the host |
| Restore | create a **fresh empty UTF8 database**, point `DATABASE_URL` at it, **stop the app**, `npm run restore -- backups/<timestamp>` (`pg_restore` for `pg.dump`; the NDJSON path migrates the schema, then loads all tables in one transaction and fixes identity sequences). It refuses a non-empty target and never drops anything. |
| Then | `npm start` and check `GET /health` and Admin → System health |

**Tested:** the NDJSON backup/restore round-trip against a real PostgreSQL 18.4 (rows, ledger totals, UTF-8 and emoji preserved, sequences usable) in `tests/postgres.test.js`.
**Not tested here:** the `pg_dump` / `pg_restore` branch (no PostgreSQL client tools were installed). Run one restore drill with your real tooling on a scratch database before launch.

Example crontab:
```
0 3 * * * cd /opt/foodies && npm run backup >> /var/log/foodies-backup.log 2>&1
```
