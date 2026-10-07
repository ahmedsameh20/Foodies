// Runs the complete automated suite against a REAL PostgreSQL server (an embedded PostgreSQL binary from the `embedded-postgres`
// dev dependency, started in a temp directory and removed afterwards) or, when TEST_DATABASE_URL is already set, against that server.
//   npm run test:pg
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

(async () => {
  let stop = async () => {};
  let url = process.env.TEST_DATABASE_URL;
  // `npm run db:local` writes a scratch-database URL to .pg-test.env (git-ignored, never read by the application)
  const envFile = path.join(__dirname, '..', '.pg-test.env');
  if (!url && fs.existsSync(envFile)) url = (/^TEST_DATABASE_URL=(.+)$/m.exec(fs.readFileSync(envFile, 'utf8')) || [])[1];
  if (url) {
    if (/USER:PASSWORD|@HOST[:/]/.test(url)) { console.error('TEST_DATABASE_URL still contains the placeholders USER / PASSWORD / HOST from the documentation: put your real connection string in it.'); process.exit(2); }
    const { Client } = require('pg');
    const target = (() => { try { const u = new URL(url); return `${u.hostname}:${u.port || 5432}${u.pathname}`; } catch { return '(unparseable URL)'; } })();
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 8000 });
    try { await c.connect(); await c.end(); } catch (e) { console.error(`Cannot connect to ${target}: ${e.message}`); process.exit(2); }
    console.log(`Using the existing PostgreSQL at ${target} (each test app gets its own throw-away schema)`);
  }
  if (!url) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodies-pg-'));
    const port = Number(process.env.TEST_PG_PORT) || (54000 + Math.floor(Math.random() * 900));
    const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'test', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
    await pg.initialise();
    await pg.start();
    url = `postgres://postgres:test@localhost:${port}/postgres`;
    stop = async () => { try { await pg.stop(); } catch { /* already stopped */ } try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* Windows may keep files locked briefly; the temp dir is harmless */ } };
  }
  const root = path.join(__dirname, '..');
  const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.test.js')).map((f) => path.join('tests', f));
  console.log(`Running ${files.length} test file(s) against PostgreSQL`);
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: root, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: url } });
  await stop();
  process.exit(r.status ?? 1);
})().catch((e) => { console.error(e); process.exit(1); });
