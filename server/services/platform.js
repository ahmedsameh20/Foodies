// Runtime platform settings (editable by admins) and audit logging.
const config = require('../config');
const logger = require('../logger');
const { bad } = require('../utils');

// Settings stored in the DB override the environment defaults.
const DEFAULTS = {
  commission_bp: () => config.commissionBp,
  service_fee_bp: () => config.serviceFeeBp,
  service_fee_fixed_cents: () => config.serviceFeeFixedCents,
  commission_fixed_cents: () => config.commissionFixedCents,   // fixed commission added to the percentage, per order
  min_payout_cents: () => config.minPayoutCents,               // statements below this are carried into the next week
};

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return Number(row.value);
  return DEFAULTS[key]();
}

function setSetting(db, key, value, userId) {
  if (!DEFAULTS[key]) throw bad(`Unknown setting ${key}`);
  if (!Number.isInteger(value) || value < 0 || (key.endsWith('_bp') && value > 10000)) throw bad(`${key}: invalid value`, { field: key });
  db.prepare(
    `INSERT INTO settings (key, value, updated_by) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(key, String(value), userId || null);
}

function allSettings(db) {
  return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, getSetting(db, k)]));
}

// Commission rate that applies to a restaurant: its own override, else the platform setting.
function commissionBpFor(db, restaurant) {
  return restaurant.commission_bp_override ?? getSetting(db, 'commission_bp');
}

// Full commission rule for a restaurant: percentage (bp) + fixed cents, each with an optional per-restaurant override.
function commissionFor(db, restaurant) {
  return {
    bp: commissionBpFor(db, restaurant),
    fixedCents: restaurant.commission_fixed_override ?? getSetting(db, 'commission_fixed_cents'),
  };
}

function serviceFee(db) {
  return { bp: getSetting(db, 'service_fee_bp'), fixedCents: getSetting(db, 'service_fee_fixed_cents') };
}

// Records an important action. `req` may be omitted for system actions. Details must never contain secrets.
function audit(db, req, action, targetType, targetId, details) {
  const actor = req?.user;
  db.prepare('INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, details, ip) VALUES (?,?,?,?,?,?,?)')
    .run(actor?.id ?? null, actor?.role ?? 'system', action, targetType ?? null, targetId === undefined ? null : String(targetId),
      details ? JSON.stringify(logger.redact(details)) : null, req?.ip ?? null);
  logger.info('audit', { action, actorId: actor?.id ?? null, targetType, targetId, details });
}

module.exports = { getSetting, setSetting, allSettings, commissionBpFor, commissionFor, serviceFee, audit };
