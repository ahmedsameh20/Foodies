// Data layer. Two engines behind one synchronous API (prepare().get/all/run, exec, tx):
//   * SQLite (node:sqlite)   development, tests, single-instance deployments      openDb('./data/app.db' | ':memory:')
//   * PostgreSQL (pg)        production, several app instances                    openDb('postgres://user:pass@host/db')
// The application code is identical for both. For PostgreSQL the driver runs in a worker thread behind a synchronous bridge
// (server/pg/sync-client.js) and SQL is translated by server/pg/translate.js.
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const PG_MIGRATIONS_DIR = path.join(MIGRATIONS_DIR, 'postgres');
const isPgTarget = (t) => /^postgres(ql)?:\/\//i.test(String(t || ''));

// Advisory-lock keys (arbitrary application constants).
const LOCK_WRITE = 7340001;   // serialises write transactions across all app instances (mirrors SQLite's single writer)
const LOCK_MIGRATE = 7340002; // one instance migrates at a time
const LOCK_LEADER = 7340003;  // background jobs run on one instance

// ------------------------------------------------------------------------------------------------ SQLite
function openSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.dialect = 'sqlite';
  db.tryLeader = () => true;
  return db;
}

// ------------------------------------------------------------------------------------------------ PostgreSQL
const PG_ERRORS = {
  23505: ['SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed'],
  23503: ['SQLITE_CONSTRAINT_FOREIGNKEY', 'FOREIGN KEY constraint failed'],
  23514: ['SQLITE_CONSTRAINT_CHECK', 'CHECK constraint failed'],
  23502: ['SQLITE_CONSTRAINT_NOTNULL', 'NOT NULL constraint failed'],
};

// Errors keep the codes/wording the application already understands (it matches /SQLITE_CONSTRAINT/, /UNIQUE/ ...) and add pgCode.
function mapError(e) {
  const m = PG_ERRORS[e.pgCode];
  if (!m) return e;
  const err = new Error(`${m[1]}: ${e.constraint || e.detail || e.message}`);
  Object.assign(err, { code: m[0], pgCode: e.pgCode, constraint: e.constraint, cause: e });
  return err;
}

function openPg(url, { schema = null } = {}) {
  const { PgSync } = require('./pg/sync-client');
  const { translate } = require('./pg/translate');
  const client = new PgSync(url, { schema });
  let idTables = null;
  const hasId = (t) => {
    if (!idTables) {
      idTables = new Set(client.query("SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'id'").rows.map((r) => r.table_name));
    }
    return idTables.has(t);
  };
  const cache = new Map();
  const compile = (sql) => {
    let c = cache.get(sql);
    if (!c) { c = translate(sql, hasId); cache.set(sql, c); }
    return c;
  };
  // Parameters that SQLite would simply fail to match (NaN, Infinity, integers beyond 64 bits) are bound as NULL so PostgreSQL
  // answers "no such row" instead of raising a type error: hostile ids must produce 404/400, never 500.
  const norm = (args) => args.map((a) => {
    if (a === undefined) return null;
    if (typeof a === 'boolean') return a ? 1 : 0;
    if (typeof a === 'bigint') return Number(a);
    if (typeof a === 'number' && (!Number.isFinite(a) || (Number.isInteger(a) && Math.abs(a) > 9.2e18))) return null;
    return a;
  });
  const run = (text, values) => {
    try { return client.query(text, values); } catch (e) { throw mapError(e); }
  };
  const db = {
    dialect: 'postgres',
    schema,
    _tx: false,
    get isTransaction() { return this._tx; },
    prepare(sql) {
      const c = compile(sql);
      return {
        get: (...a) => run(c.text, norm(a)).rows[0],
        all: (...a) => run(c.text, norm(a)).rows,
        run: (...a) => { const r = run(c.text, norm(a)); return { changes: r.rowCount, lastInsertRowid: r.rows[0]?.id }; },
      };
    },
    // Multi-statement scripts and transaction control: sent as written (no parameters, no translation). Migration scripts for PostgreSQL are native.
    exec(sql) {
      const s = sql.trim();
      if (/^BEGIN\b/i.test(s)) this._tx = true;
      const r = run(s, undefined);
      if (/^(COMMIT|ROLLBACK|END)\s*;?$/i.test(s)) this._tx = false;
      if (/\bCREATE\s+TABLE\b|\bDROP\s+TABLE\b/i.test(s)) idTables = null;
      return r;
    },
    resetCatalog() { idTables = null; cache.clear(); },
    // Background jobs (sweepers, lifecycle, statements) run on one instance: the first to take the session lock keeps it.
    tryLeader() {
      return run('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_LEADER]).rows[0].ok === true;
    },
    close() { client.close(); },
  };
  return db;
}

function openDb(target, opts = {}) {
  return isPgTarget(target) ? openPg(target, opts) : openSqlite(target);
}

// ------------------------------------------------------------------------------------------------ migrations
// SQLite: forward-only files in migrations/. A migration may start with "-- migrate:foreign_keys=off" when it must rebuild a table;
// foreign keys are re-verified afterwards and the migration is rolled back if any violation is found. Before touching an existing
// database file a copy is saved next to it.
// PostgreSQL: forward-only files in migrations/postgres/, applied inside one transaction each, under a lock so that several instances
// starting together migrate exactly once. Every SQLite migration needs a matching PostgreSQL file (tests/postgres.test.js checks parity).
function migrate(db, { backupFile } = {}) {
  return db.dialect === 'postgres' ? migratePg(db) : migrateSqlite(db, { backupFile });
}

function migratePg(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))");
  const enc = db.prepare('SHOW server_encoding').get();
  if (enc && String(enc.server_encoding).toUpperCase() !== 'UTF8') throw new Error(`The PostgreSQL database encoding is ${enc.server_encoding}; it must be UTF8 (createdb -E UTF8 -T template0 ...)`);
  db.prepare('SELECT pg_advisory_lock(?)').get(LOCK_MIGRATE);
  const applied = [];
  try {
    const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
    const files = fs.readdirSync(PG_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files.filter((x) => !done.has(x))) {
      const sql = fs.readFileSync(path.join(PG_MIGRATIONS_DIR, f), 'utf8');
      db.exec('BEGIN');
      try {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(f);
        db.exec('COMMIT');
        applied.push(f);
      } catch (e) {
        db.exec('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${e.message}`);
      }
    }
  } finally {
    db.prepare('SELECT pg_advisory_unlock(?)').get(LOCK_MIGRATE);
  }
  db.resetCatalog();
  return applied;
}

function migrateSqlite(db, { backupFile } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const pending = files.filter((f) => !done.has(f));
  if (pending.length && done.size && backupFile && fs.existsSync(backupFile)) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(backupFile, `${backupFile}.pre-${pending[0].replace('.sql', '')}.bak`);
  }
  const applied = [];
  for (const f of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const fkOff = /^--\s*migrate:foreign_keys=off/m.test(sql);
    if (fkOff) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      if (fkOff) {
        const bad = db.prepare('PRAGMA foreign_key_check').all();
        if (bad.length) throw new Error(`foreign key violations after migration: ${JSON.stringify(bad.slice(0, 3))}`);
      }
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(f);
      db.exec('COMMIT');
      applied.push(f);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${f} failed: ${e.message}`);
    } finally {
      if (fkOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
  return applied;
}

// Run fn inside a transaction. Re-entrant: a nested call becomes a savepoint, so service functions can be composed inside a larger
// atomic unit. SQLite: BEGIN IMMEDIATE (one writer). PostgreSQL: BEGIN + a transaction-scoped advisory lock, so write transactions
// are serialised across every app instance exactly like SQLite serialises them within one file (correctness first; reads are not blocked).
let savepointSeq = 0;
function tx(db, fn) {
  if (db.isTransaction) {
    const name = `sp_${++savepointSeq}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const r = fn();
      db.exec(`RELEASE ${name}`);
      return r;
    } catch (e) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw e;
    }
  }
  if (db.dialect === 'postgres') {
    db.exec('BEGIN');
    try {
      db.prepare('SELECT pg_advisory_xact_lock(?)').get(LOCK_WRITE);
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* connection already reset the transaction */ }
      throw e;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb, openSqlite, openPg, migrate, tx, isPgTarget, LOCK_WRITE };
