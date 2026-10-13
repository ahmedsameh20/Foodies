// Branches of a restaurant: validation, persistence and the public / dashboard shape. The same code serves the dashboard
// (routes/manageMenu.js) and restaurant registration (routes/admin.js, POST /onboarding/restaurant), so a branch is validated and
// stored the same way wherever it is created. Every query carries restaurant_id: a branch can only ever belong to the caller's restaurant.
const { tx } = require('../db');
const {
  HttpError, fail, str, phone, bool,
} = require('../utils');
const inventory = require('./inventory');

const MAX_BRANCHES = 100;

const comps = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

const formatBranch = (b) => ({
  id: b.id, name: b.name, nameAr: b.name_ar || '', nameEn: b.name_en || '', address: b.address || '', phone: b.phone || '',
  latitude: b.latitude ?? null, longitude: b.longitude ?? null, addressComponents: comps(b.address_components),
  isActive: !!b.is_active, createdAt: b.created_at,
});

// Only what a customer needs to choose a branch.
const publicBranch = (b) => ({
  id: b.id, name: b.name, nameAr: b.name_ar || '', nameEn: b.name_en || '', address: b.address || '', phone: b.phone || '',
  latitude: b.latitude ?? null, longitude: b.longitude ?? null,
});

function coordinate(v, field, max) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > max) fail(field, 'is not a valid coordinate', 'invalid_coordinate', { max });
  return v;
}

function parseComponents(v, field) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) fail(field, 'must be an object', 'invalid');
  const out = {};
  const keys = Object.keys(v);
  if (keys.length > 20) fail(field, 'too many address parts', 'too_many', { max: 20 });
  for (const k of keys) {
    if (!/^[a-z_]{1,30}$/.test(k)) fail(field, 'unknown address part', 'invalid');
    if (typeof v[k] !== 'string') fail(field, 'address parts must be text', 'not_text');
    out[k] = v[k].slice(0, 200);
  }
  return out;
}

// `cur` is the stored row on update (fields that are not sent keep their value). `requireLocation`: the map location is mandatory
// (registration), otherwise it is optional so that branches created through the older form / API keep working.
function parseBranch(b, cur, { requireLocation = false, path = '' } = {}) {
  b = b || {};
  const f = (k) => (path ? `${path}.${k}` : k);
  const get = (key, curVal) => (b[key] !== undefined ? b[key] : curVal);
  const nameEn = str(get('nameEn', cur?.name_en), f('nameEn'), { max: 100, optional: true });
  const nameAr = str(get('nameAr', cur?.name_ar), f('nameAr'), { max: 100, optional: true });
  const name = b.name !== undefined || !nameEn ? str(get('name', cur?.name), f('name'), { max: 100 }) : nameEn;
  const latitude = b.latitude !== undefined ? coordinate(b.latitude, f('latitude'), 90) : (cur?.latitude ?? null);
  const longitude = b.longitude !== undefined ? coordinate(b.longitude, f('longitude'), 180) : (cur?.longitude ?? null);
  if ((latitude === null) !== (longitude === null)) fail(f(latitude === null ? 'latitude' : 'longitude'), 'latitude and longitude go together', 'coordinates_pair');
  if (requireLocation && latitude === null) fail(f('latitude'), 'choose the branch location on the map', 'location_required');
  const components = parseComponents(b.addressComponents, f('addressComponents'));
  return {
    name, name_ar: nameAr, name_en: nameEn,
    address: str(get('address', cur?.address), f('address'), { max: 300, optional: true }),
    phone: phone(get('phone', cur?.phone), f('phone'), { optional: true }),
    latitude, longitude,
    address_components: components === undefined ? (cur?.address_components ?? null) : JSON.stringify(components),
    is_active: b.isActive !== undefined ? (bool(b.isActive, f('isActive')) ? 1 : 0) : (cur?.is_active ?? 1),
  };
}

// Inserts one already-parsed branch. The first branch of a restaurant takes over the stock that was kept on the dishes (unambiguous).
function insertBranch(db, restaurantId, data) {
  const first = !db.prepare('SELECT 1 FROM branches WHERE restaurant_id = ? AND is_active = 1').get(restaurantId);
  const id = Number(db.prepare(
    `INSERT INTO branches (restaurant_id, name, name_ar, name_en, address, phone, latitude, longitude, address_components, is_active) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(restaurantId, data.name, data.name_ar, data.name_en, data.address, data.phone, data.latitude, data.longitude, data.address_components, data.is_active).lastInsertRowid);
  if (first && data.is_active) inventory.adoptLegacy(db, restaurantId, id);
  return id;
}

function updateBranch(db, restaurantId, id, data) {
  return db.prepare(
    `UPDATE branches SET name=?, name_ar=?, name_en=?, address=?, phone=?, latitude=?, longitude=?, address_components=?, is_active=? WHERE id = ? AND restaurant_id = ?`)
    .run(data.name, data.name_ar, data.name_en, data.address, data.phone, data.latitude, data.longitude, data.address_components, data.is_active, id, restaurantId).changes;
}

// A branch that has taken orders is deactivated instead of deleted: its stock rows and the orders' stock restoration depend on it.
function deleteBranch(db, restaurantId, id) {
  return tx(db, () => {
    if (!db.prepare('SELECT 1 FROM branches WHERE id = ? AND restaurant_id = ?').get(id, restaurantId)) return 0;
    if (db.prepare('SELECT 1 FROM orders WHERE branch_id = ? AND restaurant_id = ?').get(id, restaurantId)) {
      throw new HttpError(409, 'branch_has_orders', 'This branch has orders. Deactivate it instead of deleting it.');
    }
    return db.prepare('DELETE FROM branches WHERE id = ? AND restaurant_id = ?').run(id, restaurantId).changes;
  });
}

module.exports = { MAX_BRANCHES, formatBranch, publicBranch, parseBranch, insertBranch, updateBranch, deleteBranch };
