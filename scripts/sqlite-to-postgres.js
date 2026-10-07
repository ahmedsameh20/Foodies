// One-time migration of an existing SQLite database into an empty PostgreSQL database.
//   DATABASE_URL=postgres://user:pass@host:5432/foodies  DATABASE_PATH=./data/app.db  npm run db:sqlite-to-postgres
// 1. STOP the application and take a backup (npm run backup). 2. The target is migrated and must be EMPTY. 3. Rows are copied in one
// transaction (all or nothing), identity sequences are advanced, and per-table row counts are compared. SQLite is never modified.
process.removeAllListeners('warning');
const config = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { copyAll } = require('./lib/rowcopy');

if (config.dbDialect !== 'postgres') { console.error('Set DATABASE_URL=postgres://... (the target). The SQLite source is DATABASE_PATH.'); process.exit(2); }
const src = openDb(config.databasePath);
const dst = openDb(config.databaseUrl, { schema: config.databaseSchema });
const applied = migrate(dst);
if (applied.length) console.log(`Applied PostgreSQL migrations: ${applied.join(', ')}`);
const counts = copyAll(src, dst, { onTable: (t, n) => console.log(`  ${t}: ${n}`) });
let bad = 0;
for (const [t, n] of Object.entries(counts)) {
  const got = dst.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const was = src.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  if (got !== was || got !== n) { console.error(`COUNT MISMATCH ${t}: sqlite ${was}, postgres ${got}`); bad += 1; }
}
dst.close();
if (bad) { console.error('Verification FAILED'); process.exit(1); }
console.log(`Done: ${Object.keys(counts).length} tables copied and verified. Point the app at DATABASE_URL and start it.`);
