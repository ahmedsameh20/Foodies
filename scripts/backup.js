// Consistent backup of the database (+ a copy of uploads/). Safe while the server runs.
//   npm run backup                 -> backups/<timestamp>/   keeps the newest BACKUP_KEEP (default 14)
//   BACKUP_DIR=/mnt/backups npm run backup
// SQLite: VACUUM INTO snapshot (app.db).  PostgreSQL: pg_dump custom format (pg.dump) when pg_dump is installed, otherwise a logical
// snapshot of every table as NDJSON (one REPEATABLE READ transaction). See docs/BACKUPS.md.
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('../server/config');

const root = path.resolve(process.env.BACKUP_DIR || path.join(config.ROOT, 'backups'));
const keep = Number(process.env.BACKUP_KEEP) || 14;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(root, stamp);
fs.mkdirSync(dir, { recursive: true });

if (config.dbDialect === 'postgres') {
  const have = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (have.status === 0 && !process.env.BACKUP_FORCE_LOGICAL) {
    const r = spawnSync('pg_dump', ['--format=custom', '--no-owner', `--file=${path.join(dir, 'pg.dump')}`, config.databaseUrl], { encoding: 'utf8' });
    if (r.status !== 0) { console.error(`pg_dump failed: ${(r.stderr || '').replace(config.databaseUrl, '[url]').slice(0, 300)}`); process.exit(1); }
    console.log(`PostgreSQL backup (pg_dump) written to ${dir}`);
  } else {
    const { openDb, migrate } = require('../server/db');
    const { dumpAll } = require('./lib/rowcopy');
    const db = openDb(config.databaseUrl, { schema: config.databaseSchema });
    migrate(db);
    const { counts } = dumpAll(db, dir);
    db.close();
    console.log(`PostgreSQL logical backup (NDJSON, pg_dump not available) written to ${dir}: ${Object.values(counts).reduce((a, b) => a + b, 0)} rows`);
  }
} else {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(config.databasePath);
  db.exec('PRAGMA busy_timeout = 5000');
  const target = path.join(dir, 'app.db');
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`); // consistent snapshot, no WAL files needed
  const check = new DatabaseSync(target);
  const integrity = check.prepare('PRAGMA integrity_check').get().integrity_check;
  check.close();
  db.close();
  if (integrity !== 'ok') { console.error(`Backup failed integrity check: ${integrity}`); process.exit(1); }
  console.log(`Backup written to ${dir} (integrity ok)`);
}
if (fs.existsSync(config.uploadDir)) fs.cpSync(config.uploadDir, path.join(dir, 'uploads'), { recursive: true });

const old = fs.readdirSync(root).filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n)).sort().slice(0, -keep);
for (const n of old) fs.rmSync(path.join(root, n), { recursive: true, force: true });
if (old.length) console.log(`${old.length} old backup(s) pruned`);
