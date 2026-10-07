// PostgreSQL worker thread. It owns ONE connection and executes the operations the (synchronous) main thread sends it, replying through a
// MessagePort and then waking the main thread (see sync-client.js). One connection per application instance gives the same ordering
// guarantees SQLite gave (statements and transactions run strictly in sequence); cross-instance consistency comes from PostgreSQL
// itself (transactional DDL, constraints, and the advisory lock taken by tx() in server/db.js).
const { parentPort, workerData } = require('node:worker_threads');
const { Client, types } = require('pg');

// COUNT/SUM come back as bigint/numeric strings by default; all money here is integer minor units, well inside 2^53.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

const client = new Client({ connectionString: workerData.url, application_name: 'foodies', statement_timeout: workerData.statementTimeoutMs || 30000 });
client.on('error', () => { /* surfaced by the next query */ });

const ready = (async () => {
  await client.connect();
  if (workerData.schema) {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${workerData.schema}"`);
    await client.query(`SET search_path TO "${workerData.schema}", public`);
  }
})();

let inTx = false;
const DML = /^\s*(INSERT|UPDATE|DELETE)\b/i;
const READ_OR_UPDATE = /^\s*(SELECT|WITH|UPDATE|DELETE)\b/i;
const TX_END = /^\s*(COMMIT|ROLLBACK|END)\s*;?\s*$/i;
// "3.14" or "abc" can never equal a bigint key. SQLite answers "no rows" and so do we.
const NO_MATCH_CODES = new Set(['22P02', '22003']);

async function inSavepoint(text, values) {
  // SQLite keeps a transaction usable after a failed statement; PostgreSQL aborts it. A savepoint around each DML statement inside a
  // transaction restores the SQLite behaviour for code that catches a constraint error and carries on.
  const sp = client.query('SAVEPOINT stmt');
  const q = client.query(text, values);
  q.catch(() => {});
  sp.catch(() => {});
  try {
    const r = await q;
    await client.query('RELEASE SAVEPOINT stmt');
    return { rows: r.rows, rowCount: r.rowCount };
  } catch (e) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT stmt');
      await client.query('RELEASE SAVEPOINT stmt');
    } catch { /* connection is gone */ }
    throw e;
  }
}

async function runQuery(text, values) {
  if (/^\s*BEGIN\b/i.test(text)) inTx = true;
  if (inTx && DML.test(text)) return inSavepoint(text, values);
  let r;
  try {
    r = await client.query(text, values);
  } catch (e) {
    // reads and updates outside a transaction only: an INSERT with a bad value must still fail loudly
    if (!inTx && NO_MATCH_CODES.has(e.code) && READ_OR_UPDATE.test(text)) return { rows: [], rowCount: 0 };
    throw e;
  }
  if (TX_END.test(text)) inTx = false;
  const last = Array.isArray(r) ? r[r.length - 1] : r;
  return { rows: last.rows || [], rowCount: last.rowCount ?? 0 };
}

async function run(op) {
  await ready;
  if (op.type === 'query') return runQuery(op.text, op.values);
  if (op.type === 'end') { await client.end(); return {}; }
  throw new Error(`unknown op ${op.type}`);
}

parentPort.on('message', async ({ port, sab, op }) => {
  const flag = new Int32Array(sab);
  let reply;
  try {
    reply = { ok: await run(op) };
  } catch (e) {
    reply = { err: { message: e.message, code: e.code, constraint: e.constraint, detail: e.detail, table: e.table, column: e.column } };
  }
  port.postMessage(reply);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
