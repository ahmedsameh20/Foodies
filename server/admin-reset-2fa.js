process.removeAllListeners('warning');
// Recovery for an administrator who lost their authenticator AND backup codes. Run on the server:
//   ADMIN_EMAIL=you@example.com npm run admin:reset-2fa
// It disables 2FA for that account and signs it out everywhere; the admin must enrol again after signing in.
const config = require('./config');
const { openDb, migrate } = require('./db');
const { resetAdminTwoFactor } = require('./services/seedData');

const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
if (!email) { console.error('Set ADMIN_EMAIL, e.g.  ADMIN_EMAIL=you@example.com npm run admin:reset-2fa'); process.exit(1); }
const db = openDb(config.databaseTarget, { schema: config.databaseSchema });
migrate(db, { backupFile: config.databasePath });
if (resetAdminTwoFactor(db, email)) console.log(`Two-factor authentication reset for ${email}. They must enrol again after signing in.`);
else { console.error(`No super_admin account found for ${email}.`); process.exit(1); }
