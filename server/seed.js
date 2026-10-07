process.removeAllListeners('warning');
// Idempotent, additive seeding. Never deletes or overwrites rows.
//   npm run seed          -> default feature tiers only (safe in production)
//   npm run seed:sample   -> also imports SAMPLE restaurants + sample accounts (development only)
const config = require('./config');
const { openDb, migrate } = require('./db');
const { ensurePlans, seedSample } = require('./services/seedData');

const withSample = process.argv.includes('--sample');
const db = openDb(config.databaseTarget, { schema: config.databaseSchema });
migrate(db, { backupFile: config.databasePath });

ensurePlans(db);
console.log('Default plans are in place.');

if (withSample) {
  if (config.isProd) {
    console.error('Refusing to load sample data when NODE_ENV=production.');
    process.exit(1);
  }
  const { created, credentials } = seedSample(db, { log: console.log });
  console.log(created.length ? `Imported ${created.length} sample restaurants.` : 'Sample restaurants already present.');
  if (credentials) {
    console.log(`Sample accounts (development only): ${credentials.accounts.join(', ')}`);
    console.log(`Generated password (shown once, not stored anywhere): ${credentials.password}`);
  }
}
