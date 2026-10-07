// Synchronous facade over node-postgres.
//
// The whole application (routes, services, tests) is written against a synchronous data API. Rather than rewrite ~370 call sites
// (and re-verify every money flow) the PostgreSQL driver runs in a worker thread and the calling thread blocks on it with
// Atomics.wait, exactly like SQLite's in-process calls block. Consequences, stated plainly:
//   * while a query runs, this process's event loop is paused (same as SQLite); queries are small and indexed;
//   * one connection per instance, strictly ordered; throughput per instance is bounded by round-trip latency;
//   * several app instances may share one database: write transactions are serialised across them by an advisory lock (server/db.js).
const path = require('node:path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');

class PgSync {
  constructor(url, { schema = null, timeoutMs = 60000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: { url, schema, statementTimeoutMs: Math.max(1000, timeoutMs - 5000) } });
    this.worker.unref();
    this.closed = false;
  }

  call(op) {
    if (this.closed) throw new Error('database connection is closed');
    const { port1, port2 } = new MessageChannel();
    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);
    this.worker.postMessage({ port: port2, sab, op }, [port2]);
    const state = Atomics.wait(flag, 0, 0, this.timeoutMs);
    if (state === 'timed-out') { port1.close(); throw new Error(`database call timed out after ${this.timeoutMs} ms`); }
    const msg = receiveMessageOnPort(port1)?.message;
    port1.close();
    if (!msg) throw new Error('database worker returned no result');
    if (msg.err) {
      const e = new Error(msg.err.message);
      Object.assign(e, { pgCode: msg.err.code, constraint: msg.err.constraint, detail: msg.err.detail, table: msg.err.table, column: msg.err.column });
      throw e;
    }
    return msg.ok;
  }

  query(text, values) { return this.call({ type: 'query', text, values }); }

  close() {
    if (this.closed) return;
    try { this.call({ type: 'end' }); } catch { /* already gone */ }
    this.closed = true;
    this.worker.terminate();
  }
}

module.exports = { PgSync };
