// Idempotency for money-creating requests. A client sends "Idempotency-Key"; repeating the same request with the
// same key returns the stored response instead of creating a second order/payment.
const crypto = require('node:crypto');
const { tx } = require('../db');
const { HttpError } = require('../utils');

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

async function withIdempotency(db, { userId, scope, key, body }, fn) {
  if (key === undefined || key === null || key === '') return fn();
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new HttpError(400, 'validation_error', 'Idempotency-Key must be 8-100 URL-safe characters', { field: 'Idempotency-Key' });
  const hash = crypto.createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');

  const claim = tx(db, () => {
    const row = db.prepare('SELECT * FROM idempotency_keys WHERE user_id = ? AND scope = ? AND key = ?').get(userId, scope, key);
    if (row) {
      if (row.request_hash !== hash) throw new HttpError(422, 'idempotency_conflict', 'This Idempotency-Key was already used with a different request');
      if (row.response_body) return { replay: { status: row.response_status, body: JSON.parse(row.response_body) } };
      const ageMs = Date.now() - new Date(row.created_at).getTime();
      if (ageMs < 120000) throw new HttpError(409, 'request_in_progress', 'This request is already being processed');
      db.prepare('DELETE FROM idempotency_keys WHERE id = ?').run(row.id); // abandoned by a crash: allow a fresh attempt
    }
    db.prepare('INSERT INTO idempotency_keys (user_id, scope, key, request_hash) VALUES (?,?,?,?)').run(userId, scope, key, hash);
    return { replay: null };
  });
  if (claim.replay) return { ...claim.replay, replayed: true };

  try {
    const result = await fn();
    db.prepare('UPDATE idempotency_keys SET response_status = ?, response_body = ? WHERE user_id = ? AND scope = ? AND key = ?')
      .run(result.status, JSON.stringify(result.body), userId, scope, key);
    return result;
  } catch (e) {
    // Failed attempts are not remembered, so the customer can correct the request and retry with the same key.
    db.prepare('DELETE FROM idempotency_keys WHERE user_id = ? AND scope = ? AND key = ?').run(userId, scope, key);
    throw e;
  }
}

module.exports = { withIdempotency };
