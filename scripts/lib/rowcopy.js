// Table-level copy between two databases that share the application schema (SQLite -> PostgreSQL migration, and the logical
// backup/restore used when pg_dump is not available). Both sides use the application's synchronous db API.
const fs = require('node:fs');
const path = require('node:path');

const SKIP = new Set(['schema_migrations']);

// Parent-before-child order from the target's foreign keys. users <-> restaurants is a cycle (restaurants.owner_id): the owner column
// is written after the users exist.
function tableOrder(pg) {
  const tables = pg.prepare("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'")
    .all().map((r) => r.t).filter((t) => !SKIP.has(t));
  const clean = (s) => String(s).replace(/"/g, '').split('.').pop();
  const deps = pg.prepare("SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = current_schema()::regnamespace").all()
    .map((d) => ({ child: clean(d.child), parent: clean(d.parent) }))
    .filter((d) => !(d.child === 'restaurants' && d.parent === 'users') && d.child !== d.parent);
  const out = [];
  const seen = new Set();
  const visit = (t) => {
    if (seen.has(t)) return;
    seen.add(t);
    for (const d of deps.filter((x) => x.child === t)) visit(d.parent);
    out.push(t);
  };
  tables.sort().forEach(visit);
  return out;
}

const columnsOf = (pg, table) => pg.prepare('SELECT column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position').all(table).map((r) => r.c);

function readRows(src, table, cols) {
  const hasId = cols.includes('id');
  return src.prepare(`SELECT ${cols.join(', ')} FROM ${table}${hasId ? ' ORDER BY id' : ''}`).all();
}

// rows: [{col: value}] -> INSERT into target. Returns the number of rows written.
function writeRows(dst, table, cols, rows) {
  if (!rows.length) return 0;
  const stmt = dst.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (const r of rows) stmt.run(...cols.map((c) => r[c]));
  return rows.length;
}

function resetSequences(pg, tables) {
  for (const t of tables) {
    if (!columnsOf(pg, t).includes('id')) continue;
    const max = pg.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${t}`).get().m;
    pg.prepare("SELECT setval(pg_get_serial_sequence(?, 'id'), ?, ?)").get(t, Math.max(max, 1), max > 0);
  }
}

// Copy every application table from src to dst (dst must be migrated and EMPTY). Runs in one transaction.
function copyAll(src, dst, { onTable = () => {} } = {}) {
  const order = tableOrder(dst);
  const nonEmpty = order.find((t) => dst.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n > 0);
  if (nonEmpty) throw new Error(`target is not empty (table ${nonEmpty} has rows); restore/migrate into a freshly migrated database`);
  const counts = {};
  dst.exec('BEGIN');
  try {
    dst.exec('ALTER TABLE restaurants DISABLE TRIGGER trg_restaurants_updated'); // do not rewrite updated_at while linking owners
    const owners = [];
    for (const t of order) {
      const cols = columnsOf(dst, t);
      const have = new Set(src.prepare ? columnsFromSource(src, t) : cols);
      const use = cols.filter((c) => have.has(c));
      const rows = readRows(src, t, use);
      if (t === 'restaurants' && use.includes('owner_id')) {
        for (const r of rows) { if (r.owner_id != null) owners.push([r.owner_id, r.id]); r.owner_id = null; }
      }
      counts[t] = writeRows(dst, t, use, rows);
      onTable(t, counts[t]);
    }
    for (const [owner, rid] of owners) dst.prepare('UPDATE restaurants SET owner_id = ? WHERE id = ?').run(owner, rid);
    dst.exec('ALTER TABLE restaurants ENABLE TRIGGER trg_restaurants_updated');
    resetSequences(dst, order);
    dst.exec('COMMIT');
  } catch (e) {
    try { dst.exec('ROLLBACK'); } catch { /* already aborted */ }
    throw e;
  }
  return counts;
}

// column names of a table in the SOURCE database, whichever engine it is
function columnsFromSource(src, table) {
  if (src.dialect === 'postgres') return columnsOf(src, table);
  return src.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// ---- logical dump (NDJSON, one file per table) used for backups when pg_dump is unavailable
function dumpAll(src, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const order = tableOrder(src);
  const counts = {};
  src.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); // one consistent snapshot of every table
  try {
    for (const t of order) {
      const cols = columnsOf(src, t);
      const rows = readRows(src, t, cols);
      fs.writeFileSync(path.join(dir, `${t}.ndjson`), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
      counts[t] = rows.length;
    }
  } finally { src.exec('COMMIT'); }
  const migrations = src.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ format: 'foodies-ndjson-v1', createdAt: new Date().toISOString(), migrations, counts }, null, 2));
  return { counts, migrations };
}

// A "database" over NDJSON files, readable by copyAll
function ndjsonSource(dir) {
  const read = (t) => {
    const f = path.join(dir, `${t}.ndjson`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return {
    dialect: 'ndjson',
    prepare(sql) {
      const m = /FROM (\w+)/.exec(sql);
      const t = m && m[1];
      if (/^PRAGMA table_info\((\w+)\)/.test(sql)) return { all: () => Object.keys(read(/\((\w+)\)/.exec(sql)[1])[0] || {}).map((name) => ({ name })) };
      return { all: () => read(t) };
    },
  };
}

module.exports = { tableOrder, copyAll, dumpAll, ndjsonSource, columnsOf, resetSequences };
