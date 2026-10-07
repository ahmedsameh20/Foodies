process.removeAllListeners('warning'); // silence node:sqlite "experimental" banner
const config = require('./config');
const logger = require('./logger');
const { openDb, migrate } = require('./db');
const { createApp } = require('./app');
const { createProvider } = require('./payments/provider');
const payments = require('./services/payments');
const payouts = require('./services/payouts');
const { ensurePlans } = require('./services/seedData');
const subscriptions = require('./services/subscriptions');

const db = openDb(config.databaseTarget, { schema: config.databaseSchema });
const applied = migrate(db, { backupFile: config.databasePath });
if (applied.length) logger.info('db.migrated', { applied });
ensurePlans(db); // default feature tiers; INSERT OR IGNORE, never overwrites plans an admin has edited

const provider = createProvider();
if (config.paymentProvider === 'none') logger.warn('payments.disabled', { hint: 'Card payments are off; only cash on delivery is available. Set PAYMENT_PROVIDER and credentials to enable.' });

const server = createApp(db, { provider }).listen(config.port, () => {
  logger.info('server.started', { database: db.dialect, port: config.port, appUrl: config.appUrl, payments: provider.enabled ? provider.name : 'disabled', payoutMode: config.payoutMode });
});

// Background work: cancel unpaid card orders (after asking the provider one last time) and create weekly payouts.
const timers = [];
// With PostgreSQL several instances may run: background jobs run on the one that holds the leader lock (SQLite: always this process).
const leader = () => db.tryLeader();
timers.push(setInterval(() => {
  if (!leader()) return;
  payments.expireUnpaidOrders(db, provider).catch((e) => logger.error('sweeper.failed', { error: e }));
}, 60 * 1000));
timers.push(setInterval(() => {
  if (!leader()) return;
  try {
    const r = subscriptions.runLifecycle(db);
    if (r.renewalsIssued || r.trialsEnded || r.expired || r.cancelled) logger.info('subscriptions.lifecycle', r);
  } catch (e) { logger.error('subscriptions.lifecycle_failed', { error: e }); }
}, 60 * 1000));
if (config.saasAutoRenewal) {
  timers.push(setInterval(() => {
    if (!leader()) return;
    subscriptions.runAutoRenewals(db, provider).then((r) => { if (r.attempted) logger.info('subscriptions.auto_renewals', r); }).catch((e) => logger.error('subscriptions.auto_renewals_failed', { error: e }));
  }, 5 * 60 * 1000));
}
const payoutTimer = payouts.startScheduler(db);
if (payoutTimer) timers.push(payoutTimer);
timers.forEach((t) => t.unref());

function shutdown(signal) {
  logger.info('server.stopping', { signal });
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => logger.error('process.unhandled_rejection', { error: e }));
