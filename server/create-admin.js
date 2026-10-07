process.removeAllListeners('warning');
// Creates a platform administrator (role "super_admin"). Nothing is hard-coded: provide the credentials either
//   - through the environment (CI, containers, scripts):
//       ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase 1' npm run admin:create
//   - or interactively, when run in a terminal without those variables (the password is not echoed):
//       npm run admin:create
// Safe to re-run: an existing account is never modified. After the first sign-in, enable two-factor
// authentication under Admin -> Security (required in production).
const readline = require('node:readline');
const config = require('./config');
const { openDb, migrate } = require('./db');
const { ensurePlans, createAdmin } = require('./services/seedData');
const { email, password, str } = require('./utils');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); else if (/\r|\n/.test(s)) process.stdout.write(s); };
    }
    rl.question(question, (a) => { rl.close(); resolve(a); });
  });
}

(async () => {
  try {
    let rawEmail = process.env.ADMIN_EMAIL;
    let rawPass = process.env.ADMIN_PASSWORD;
    let rawName = process.env.ADMIN_NAME;
    if ((!rawEmail || !rawPass) && process.stdin.isTTY) {
      console.log('Create a platform administrator (super_admin).');
      rawEmail = rawEmail || await ask('Email: ');
      rawName = rawName || await ask('Name [Platform Admin]: ');
      if (!rawPass) {
        rawPass = await ask('Password (min 8 chars, letters and numbers; not shown): ', { hidden: true });
        const again = await ask('Repeat password: ', { hidden: true });
        if (rawPass !== again) throw new Error('The passwords do not match');
      }
    }
    if (!rawEmail || !rawPass) {
      throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required when not running in an interactive terminal.\n  ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=\'a long passphrase 1\' npm run admin:create');
    }
    const mail = email(rawEmail, 'ADMIN_EMAIL');
    const pass = password(rawPass, 'ADMIN_PASSWORD');
    const name = str(rawName || 'Platform Admin', 'ADMIN_NAME', { max: 100 });
    const db = openDb(config.databaseTarget, { schema: config.databaseSchema });
    migrate(db, { backupFile: config.databasePath });
    ensurePlans(db);
    const r = createAdmin(db, { email: mail, name, password: pass });
    if (r.created) {
      console.log(`Admin account created for ${mail} (role: super_admin).`);
      console.log(`Sign in at ${config.appUrl}/admin/login`);
    } else {
      console.log(`An account for ${mail} already exists; nothing changed.`);
    }
  } catch (e) {
    console.error(`Could not create admin: ${e.message}`);
    process.exit(1);
  }
})();
