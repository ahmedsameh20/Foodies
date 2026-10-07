// Restore a backup made by scripts/backup.js:   npm run restore -- backups/<timestamp>
// STOP THE SERVER FIRST. SQLite: the current database is moved aside (never deleted). PostgreSQL: restores into the database in
// DATABASE_URL, which must be EMPTY (create a fresh database; the restore never drops or overwrites data).
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('../server/config');

const src = process.argv[2];
if (!src) { console.error('Usage: npm run restore -- <backup folder>'); process.exit(2); }
const folder = path.resolve(src);
const copyUploads = () => { const up = path.join(folder, 'uploads'); if (fs.existsSync(up)) fs.cpSync(up, config.uploadDir, { recursive: true }); };

if (config.dbDialect === 'postgres') {
  const dump = path.join(folder, 'pg.dump');
  if (fs.existsSync(dump)) {
    const r = spawnSync('pg_restore', ['--no-owner', `--dbname=${config.databaseUrl}`, dump], { encoding: 'utf8' });
    if (r.status !== 0) { console.error(`pg_restore failed: ${(r.stderr || '').replace(config.databaseUrl, '[url]').slice(0, 400)}`); process.exit(1); }
    copyUploads();
    console.log('Restored from pg.dump with pg_restore.');
  } else if (fs.existsSync(path.join(folder, 'manifest.json'))) {
    const { openDb, migrate } = require('../server/db');
    const { copyAll, ndjsonSource } = require('./lib/rowcopy');
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
    if (manifest.format !== 'foodies-ndjson-v1') { console.error('Unknown backup format'); process.exit(1); }
    const db = openDb(config.databaseUrl, { schema: config.databaseSchema });
    migrate(db);
    try {
      const counts = copyAll(ndjsonSource(folder), db, {});
      copyUploads();
      console.log(`Restored ${Object.values(counts).reduce((a, b) => a + b, 0)} rows into PostgreSQL.`);
    } catch (e) {
      console.error(`Restore failed: ${e.message}`);
      process.exit(1);
    } finally { db.close(); }
  } else { console.error(`No pg.dump or manifest.json in ${src}`); process.exit(2); }
} else {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(folder, 'app.db');
  if (!fs.existsSync(file)) { console.error(`No app.db in ${src}`); process.exit(2); }
  const probe = new DatabaseSync(file, { readOnly: true });
  const integrity = probe.prepare('PRAGMA integrity_check').get().integrity_check;
  const migrations = probe.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
  probe.close();
  if (integrity !== 'ok') { console.error(`Backup is corrupt: ${integrity}`); process.exit(1); }
  const dest = config.databasePath;
  if (fs.existsSync(dest)) fs.renameSync(dest, `${dest}.before-restore-${Date.now()}`);
  for (const ext of ['-wal', '-shm']) fs.rmSync(dest + ext, { force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  copyUploads();
  console.log(`Restored ${dest} from ${src} (${migrations} migrations). Start the server; npm run migrate runs automatically.`);
}
