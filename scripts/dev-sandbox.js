// Starts the app on a THROWAWAY database (a fresh SQLite file in the OS temp folder) so you can click through the UI without touching
// the data configured in .env (DATABASE_URL / DATABASE_PATH). Nothing is seeded: register accounts in the browser.
//   node scripts/dev-sandbox.js            -> http://localhost:3100
//   SANDBOX_PORT=3200 node scripts/dev-sandbox.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = process.env.SANDBOX_DIR || path.join(os.tmpdir(), 'foodies-sandbox');
const port = process.env.SANDBOX_PORT || '3100';
fs.mkdirSync(dir, { recursive: true });

// real environment variables win over .env, so these override whatever .env configures
Object.assign(process.env, {
  NODE_ENV: 'development',
  PORT: port,
  APP_URL: `http://localhost:${port}`,
  DATABASE_URL: '',
  DATABASE_PATH: path.join(dir, 'app.db'),
  UPLOAD_DIR: path.join(dir, 'uploads'),
  RATE_LIMIT: 'off',
  BCRYPT_ROUNDS: '4',
  PAYMENT_PROVIDER: 'none',
  TAP_SECRET_KEY: '',
  PAYMENT_SECRET_KEY: '',
});
console.log(`Sandbox database: ${process.env.DATABASE_PATH}  (delete the folder to start over)`);
require('../server/index.js'); // migrates and seeds the plans on boot, like a normal start
