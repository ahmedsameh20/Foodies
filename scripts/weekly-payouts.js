process.removeAllListeners('warning');
// Cron entry point: generates the weekly payout statements for the most recent complete Monday-Sunday week.
// Safe to run repeatedly (UNIQUE(restaurant_id, period_start) prevents duplicates).
//   0 6 * * 1  cd /app && npm run payouts:weekly
const config = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { generateWeeklyPayouts } = require('../server/services/payouts');

const db = openDb(config.databaseTarget, { schema: config.databaseSchema });
migrate(db, { backupFile: config.databasePath });
const { period, created } = generateWeeklyPayouts(db);
console.log(`Week ${period.periodStart} .. ${period.periodEnd}: ${created.length} payout(s) created.`);
for (const c of created) console.log(`  restaurant ${c.restaurantId}: payout #${c.payoutId}, ${c.amountCents} minor units, ${c.entries} ledger entries`);
