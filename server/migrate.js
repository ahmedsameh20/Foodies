process.removeAllListeners('warning');
const config = require('./config');
const { openDb, migrate } = require('./db');

const db = openDb(config.databaseTarget, { schema: config.databaseSchema });
const applied = migrate(db, { backupFile: config.databasePath });
console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date.');
