// A real, persistent PostgreSQL for this project on THIS machine (no Docker, no installer): the PostgreSQL binaries that ship with the
// `embedded-postgres` dev dependency, run as an ordinary background server with its own data directory.
//
//   npm run db:local            create everything on first run (cluster, role, databases, .env), start it, migrate; later runs just start it
//   npm run db:local -- status
//   npm run db:local -- stop
//
// What it creates (data/postgres is git-ignored):
//   cluster      data/postgres        listens on localhost only, port LOCAL_PG_PORT (default 54320), scram-sha-256 password auth
//   role         foodies              random password, NOT a superuser
//   databases    foodies              the application (UTF8)           -> DATABASE_URL in .env
//                foodies_test         scratch database for `npm run test:pg`  -> .pg-test.env (never loaded by the app)
//   superuser    postgres             random password kept only in data/postgres.superuser (for maintenance)
// Passwords are generated here and written ONLY to git-ignored files. This is a development / small-deployment convenience: for a public
// production service prefer a managed PostgreSQL with point-in-time recovery (docs/DATABASE.md).
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'postgres');
const LOG = path.join(ROOT, 'data', 'postgres.log');
const SUPER_FILE = path.join(ROOT, 'data', 'postgres.superuser');
const PORT = Number(process.env.LOCAL_PG_PORT) || 54320;
const cmd = process.argv[2] || 'setup';

function binDir() {
  const base = path.join(ROOT, 'node_modules', '@embedded-postgres');
  for (const d of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const b = path.join(base, d, 'native', 'bin');
    if (fs.existsSync(b)) return b;
  }
  throw new Error('PostgreSQL binaries not found: run `npm install` (dev dependency embedded-postgres)');
}
const exe = (n) => path.join(binDir(), process.platform === 'win32' ? `${n}.exe` : n);
const secret = () => crypto.randomBytes(24).toString('base64url');
const portFree = (port) => new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(port, '127.0.0.1', () => s.close(() => res(true))); });
const isRunning = () => spawnSync(exe('pg_ctl'), ['status', '-D', DATA], { encoding: 'utf8' }).status === 0;

function start() {
  if (isRunning()) return;
  // stdio is ignored on purpose: the server keeps running in the background and would otherwise hold our output pipes open forever
  const r = spawnSync(exe('pg_ctl'), ['start', '-D', DATA, '-l', LOG, '-w', '-t', '60', '-o', `-p ${PORT} -c listen_addresses=localhost`], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error(`pg_ctl start failed (see ${LOG})`);
}

// replace or append KEY=value in a dotenv file, keeping everything else
function setEnv(file, key, value) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  fs.writeFileSync(file, re.test(text) ? text.replace(re, () => line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
}

async function setup() {
  const fresh = !fs.existsSync(path.join(DATA, 'PG_VERSION'));
  if (fresh) {
    if (!(await portFree(PORT))) throw new Error(`port ${PORT} is in use: set LOCAL_PG_PORT=<free port> and run again`);
    fs.mkdirSync(path.dirname(DATA), { recursive: true });
    const superPw = secret();
    const pwfile = path.join(path.dirname(DATA), '.pgpw.tmp');
    fs.writeFileSync(pwfile, superPw, { mode: 0o600 });
    const i = spawnSync(exe('initdb'), ['-D', DATA, '-U', 'postgres', '--auth=scram-sha-256', `--pwfile=${pwfile}`, '--encoding=UTF8', '--locale=C'], { encoding: 'utf8' });
    fs.rmSync(pwfile, { force: true });
    if (i.status !== 0) throw new Error(`initdb failed: ${(i.stderr || '').trim().slice(0, 400)}`);
    fs.writeFileSync(SUPER_FILE, `${superPw}\n`, { mode: 0o600 });
  }
  start();
  const { Client } = require('pg');
  const superPw = fs.readFileSync(SUPER_FILE, 'utf8').trim();
  const admin = new Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: superPw, database: 'postgres' });
  await admin.connect();
  const out = { port: PORT };
  try {
    const has = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'foodies'")).rowCount > 0;
    if (!has) {
      const appPw = secret();
      await admin.query(`CREATE ROLE foodies LOGIN PASSWORD '${appPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      for (const db of ['foodies', 'foodies_test']) await admin.query(`CREATE DATABASE ${db} OWNER foodies ENCODING 'UTF8' TEMPLATE template0`);
      const url = (db) => `postgres://foodies:${appPw}@127.0.0.1:${PORT}/${db}`;
      setEnv(path.join(ROOT, '.env'), 'DATABASE_URL', url('foodies'));
      setEnv(path.join(ROOT, '.pg-test.env'), 'TEST_DATABASE_URL', url('foodies_test'));
      out.created = true;
    } else out.created = false;
  } finally { await admin.end(); }
  return out;
}

(async () => {
  if (cmd === 'stop') {
    const r = spawnSync(exe('pg_ctl'), ['stop', '-D', DATA, '-m', 'fast', '-w'], { encoding: 'utf8' });
    console.log(r.status === 0 ? 'PostgreSQL stopped.' : (r.stderr || r.stdout || 'not running').trim());
    return;
  }
  if (cmd === 'status') { console.log(isRunning() ? `PostgreSQL is running on 127.0.0.1:${PORT}` : 'PostgreSQL is not running (npm run db:local to start it)'); return; }
  if (cmd !== 'setup' && cmd !== 'start') { console.error('usage: npm run db:local [-- status|stop]'); process.exit(2); }
  const r = await setup();
  console.log(r.created ? `Created PostgreSQL role "foodies" and databases "foodies" + "foodies_test" on 127.0.0.1:${r.port}.` : `PostgreSQL is running on 127.0.0.1:${r.port}; role and databases already exist.`);
  console.log('DATABASE_URL is in .env (git-ignored); the test database URL is in .pg-test.env. Next: npm run migrate');
})().catch((e) => { console.error(e.message); process.exit(1); });
