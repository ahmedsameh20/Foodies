// Stock handling for dishes / general extras with track_stock = 1. Items without stock tracking are unlimited and never touched.
//
// Where the quantity lives:
//   * Restaurant WITHOUT active branches: products.stock_quantity / restaurant_extras.stock_quantity (the original behaviour, unchanged).
//   * Restaurant WITH active branches: branch_stock / branch_extra_stock, one row per branch and item (UNIQUE (branch_id, item)).
//     Each branch is independent: selling or restocking at one branch never touches another. An item without a row at a branch has
//     no stock there (it is out of stock) - nothing is ever assumed to be shared or borrowed from another branch.
//
// Safety model:
//   * reserve() is ONE conditional UPDATE ("... AND quantity >= qty"): it can never take stock below zero, and two orders for the last
//     unit cannot both succeed. createOrder() also runs inside tx(), which serialises write transactions (BEGIN IMMEDIATE on SQLite, an
//     advisory lock on PostgreSQL), so the check and the decrement are atomic across app instances.
//   * Each order line remembers how many units it took (order_items.stock_deducted) and the order remembers its branch
//     (orders.branch_id). restoreForOrder() puts exactly those units back to that branch and zeroes the counter first, so cancelling,
//     rejecting, an expired payment and a late webhook can each call it any number of times and the stock is restored once.
//   * Delivered orders are never restored (the food was consumed); refunds on delivered orders do not touch stock.
const { tx } = require('../db');
const { HttpError } = require('../utils');

const DEFAULT_LOW_STOCK = 5;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// ---------------------------------------------------------------- branches
const activeBranches = (db, restaurantId) => db.prepare('SELECT * FROM branches WHERE restaurant_id = ? AND is_active = 1 ORDER BY name, id').all(restaurantId);

const hasBranches = (db, restaurantId) => !!db.prepare('SELECT 1 FROM branches WHERE restaurant_id = ? AND is_active = 1').get(restaurantId);

const distanceKm = (a, b) => { // haversine
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
};

// The branch that fulfils an order. null = the restaurant has no branches (stock then lives on the dish, as before).
//   * an explicit branchId must be one of the restaurant's active branches;
//   * a single branch is used automatically;
//   * otherwise a delivery with coordinates goes to the nearest branch that has a map location;
//   * otherwise the customer must choose (422 branch_required). No other branch is ever substituted when stock runs out.
function resolveBranch(db, restaurantId, { branchId = null, latitude = null, longitude = null } = {}) {
  const branches = activeBranches(db, restaurantId);
  if (!branches.length) {
    if (branchId !== null && branchId !== undefined) throw new HttpError(422, 'invalid_branch', 'That branch is not available for this restaurant', { branchId });
    return null;
  }
  if (branchId !== null && branchId !== undefined) {
    const b = branches.find((x) => x.id === branchId);
    if (!b) throw new HttpError(422, 'invalid_branch', 'That branch is not available for this restaurant', { branchId });
    return b;
  }
  if (branches.length === 1) return branches[0];
  if (latitude !== null && longitude !== null) {
    const located = branches.filter((b) => b.latitude !== null && b.longitude !== null);
    if (located.length) return located.map((b) => ({ b, d: distanceKm({ latitude, longitude }, b) })).sort((x, y) => x.d - y.d || x.b.id - y.b.id)[0].b;
  }
  throw new HttpError(422, 'branch_required', 'Choose the branch that will prepare your order');
}

// ---------------------------------------------------------------- reading stock for one branch
function stockRows(db, restaurantId, branchId, kind) {
  const [table, col] = kind === 'extra' ? ['branch_extra_stock', 'extra_id'] : ['branch_stock', 'product_id'];
  const map = new Map();
  for (const r of db.prepare(`SELECT * FROM ${table} WHERE restaurant_id = ? AND branch_id = ?`).all(restaurantId, branchId)) map.set(r[col], r);
  return map;
}

// The item row as seen at one branch: the branch quantity replaces the legacy one, and a branch can switch the item off on its own.
function atBranch(item, row) {
  return {
    ...item,
    stock_quantity: item.track_stock ? (row ? row.quantity : 0) : item.stock_quantity,
    is_available: item.is_available && (row ? row.is_available : 1) ? 1 : 0,
  };
}

// ---------------------------------------------------------------- reserve / restore
function reserve(db, restaurantId, branchId, productId, quantity) {
  if (branchId === null || branchId === undefined) {
    return db.prepare('UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND restaurant_id = ? AND track_stock = 1 AND stock_quantity >= ?')
      .run(quantity, productId, restaurantId, quantity).changes === 1;
  }
  return db.prepare(
    `UPDATE branch_stock SET quantity = quantity - ?, updated_at = ${NOW} WHERE restaurant_id = ? AND branch_id = ? AND product_id = ? AND is_available = 1 AND quantity >= ?`)
    .run(quantity, restaurantId, branchId, productId, quantity).changes === 1;
}

// General extras (restaurant_extras) follow the same rules as dishes.
function reserveExtra(db, restaurantId, branchId, extraId, quantity) {
  if (branchId === null || branchId === undefined) {
    return db.prepare('UPDATE restaurant_extras SET stock_quantity = stock_quantity - ? WHERE id = ? AND restaurant_id = ? AND track_stock = 1 AND stock_quantity >= ?')
      .run(quantity, extraId, restaurantId, quantity).changes === 1;
  }
  return db.prepare(
    `UPDATE branch_extra_stock SET quantity = quantity - ?, updated_at = ${NOW} WHERE restaurant_id = ? AND branch_id = ? AND extra_id = ? AND is_available = 1 AND quantity >= ?`)
    .run(quantity, restaurantId, branchId, extraId, quantity).changes === 1;
}

function restoreForOrder(db, orderId, restaurantId) {
  return tx(db, () => {
    const order = db.prepare('SELECT branch_id FROM orders WHERE id = ? AND restaurant_id = ?').get(orderId, restaurantId);
    const branchId = order ? order.branch_id : null;
    const lines = db.prepare('SELECT id, product_id, extra_id, stock_deducted FROM order_items WHERE order_id = ? AND restaurant_id = ? AND stock_deducted > 0').all(orderId, restaurantId);
    let restored = 0;
    for (const l of lines) {
      // zero the counter first: only the caller that wins this update puts the units back
      const claimed = db.prepare('UPDATE order_items SET stock_deducted = 0 WHERE id = ? AND stock_deducted = ?').run(l.id, l.stock_deducted).changes === 1;
      if (!claimed) continue;
      if (l.product_id) {
        if (branchId !== null) {
          db.prepare(`UPDATE branch_stock SET quantity = quantity + ?, updated_at = ${NOW} WHERE restaurant_id = ? AND branch_id = ? AND product_id = ?`).run(l.stock_deducted, restaurantId, branchId, l.product_id);
        } else {
          db.prepare('UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ? AND restaurant_id = ? AND track_stock = 1').run(l.stock_deducted, l.product_id, restaurantId);
        }
        restored += l.stock_deducted;
      } else if (l.extra_id) { // a general extra (deleted extras have extra_id NULL: nothing to restore)
        if (branchId !== null) {
          db.prepare(`UPDATE branch_extra_stock SET quantity = quantity + ?, updated_at = ${NOW} WHERE restaurant_id = ? AND branch_id = ? AND extra_id = ?`).run(l.stock_deducted, restaurantId, branchId, l.extra_id);
        } else {
          db.prepare('UPDATE restaurant_extras SET stock_quantity = stock_quantity + ? WHERE id = ? AND restaurant_id = ? AND track_stock = 1').run(l.stock_deducted, l.extra_id, restaurantId);
        }
        restored += l.stock_deducted;
      }
    }
    return restored;
  });
}

// ---------------------------------------------------------------- owner / staff: managing the quantities of one branch
const KINDS = { dish: { table: 'branch_stock', col: 'product_id', items: 'products' }, extra: { table: 'branch_extra_stock', col: 'extra_id', items: 'restaurant_extras' } };

function ownBranch(db, restaurantId, branchId) {
  const b = db.prepare('SELECT * FROM branches WHERE id = ? AND restaurant_id = ?').get(branchId, restaurantId);
  if (!b) throw new HttpError(404, 'not_found', 'Branch not found');
  return b;
}

const lowLimit = (row) => (row && row.low_stock_threshold !== null && row.low_stock_threshold !== undefined ? row.low_stock_threshold : DEFAULT_LOW_STOCK);
function stateOf(item, row) {
  if (!item.track_stock) return 'unlimited';
  const q = row ? row.quantity : 0;
  if (q <= 0) return 'out';
  return q <= lowLimit(row) ? 'low' : 'ok';
}

// Every dish and general extra with its quantity at ONE branch.
function branchStock(db, restaurantId, branchId) {
  const out = [];
  for (const kind of ['dish', 'extra']) {
    const { items } = KINDS[kind];
    const rows = stockRows(db, restaurantId, branchId, kind);
    const list = db.prepare(`SELECT * FROM ${items} WHERE restaurant_id = ? ORDER BY name, id`).all(restaurantId);
    for (const it of list) {
      const row = rows.get(it.id);
      out.push({
        kind, id: it.id, name: it.name, nameAr: it.name_ar || '', nameEn: it.name_en || '', category: kind === 'extra' ? it.category : null, categoryId: kind === 'dish' ? it.category_id : null,
        trackStock: !!it.track_stock, quantity: it.track_stock ? (row ? row.quantity : 0) : null,
        lowStockThreshold: row ? row.low_stock_threshold : null, lowLimit: lowLimit(row),
        itemAvailable: !!it.is_available, branchAvailable: row ? !!row.is_available : true, hasRow: !!row,
        state: stateOf(it, row), updatedAt: row ? row.updated_at : null,
      });
    }
  }
  return out;
}

// One row per active branch: how many tracked items are out / low / fine, so a restaurant with many branches sees where to act.
function branchSummaries(db, restaurantId) {
  const branches = db.prepare('SELECT * FROM branches WHERE restaurant_id = ? ORDER BY is_active DESC, name, id').all(restaurantId);
  const dishes = db.prepare('SELECT id, track_stock FROM products WHERE restaurant_id = ? AND track_stock = 1').all(restaurantId);
  const extras = db.prepare('SELECT id, track_stock FROM restaurant_extras WHERE restaurant_id = ? AND track_stock = 1').all(restaurantId);
  const rowsOf = (table, col) => {
    const m = new Map();
    for (const r of db.prepare(`SELECT * FROM ${table} WHERE restaurant_id = ?`).all(restaurantId)) m.set(`${r.branch_id}:${r[col]}`, r);
    return m;
  };
  const dRows = rowsOf('branch_stock', 'product_id');
  const eRows = rowsOf('branch_extra_stock', 'extra_id');
  return branches.map((b) => {
    const s = { tracked: 0, out: 0, low: 0, ok: 0 };
    for (const [list, rows] of [[dishes, dRows], [extras, eRows]]) {
      for (const it of list) {
        const st = stateOf(it, rows.get(`${b.id}:${it.id}`));
        s.tracked += 1; s[st] += 1;
      }
    }
    return { id: b.id, name: b.name, nameAr: b.name_ar || '', nameEn: b.name_en || '', address: b.address || '', isActive: !!b.is_active, ...s };
  });
}

// Sets / adds to / flags the stock of ONE item at ONE branch. quantity = absolute value; restockBy = atomic increment.
function updateStock(db, restaurantId, { kind, itemId, branchId, quantity, restockBy, lowStockThreshold, isAvailable }) {
  const k = KINDS[kind];
  return tx(db, () => {
    ownBranch(db, restaurantId, branchId);
    const item = db.prepare(`SELECT * FROM ${k.items} WHERE id = ? AND restaurant_id = ?`).get(itemId, restaurantId);
    if (!item) throw new HttpError(404, 'not_found', kind === 'extra' ? 'Extra not found' : 'Product not found');
    let row = db.prepare(`SELECT * FROM ${k.table} WHERE branch_id = ? AND ${k.col} = ? AND restaurant_id = ?`).get(branchId, itemId, restaurantId);
    if (!row) {
      db.prepare(`INSERT INTO ${k.table} (restaurant_id, branch_id, ${k.col}, quantity) VALUES (?,?,?,0)`).run(restaurantId, branchId, itemId);
      row = db.prepare(`SELECT * FROM ${k.table} WHERE branch_id = ? AND ${k.col} = ? AND restaurant_id = ?`).get(branchId, itemId, restaurantId);
    }
    if (restockBy !== undefined) {
      if (!item.track_stock) throw new HttpError(409, 'stock_not_tracked', 'Turn on stock tracking for this item before restocking it');
      if (row.quantity + restockBy > 1e6) throw new HttpError(400, 'validation_error', 'restockBy: stock would exceed the maximum', { field: 'restockBy', reason: 'out_of_range', min: 1, max: 1e6 - row.quantity });
      db.prepare(`UPDATE ${k.table} SET quantity = quantity + ?, updated_at = ${NOW} WHERE id = ? AND restaurant_id = ?`).run(restockBy, row.id, restaurantId);
    }
    if (quantity !== undefined) db.prepare(`UPDATE ${k.table} SET quantity = ?, updated_at = ${NOW} WHERE id = ? AND restaurant_id = ?`).run(quantity, row.id, restaurantId);
    if (lowStockThreshold !== undefined) db.prepare(`UPDATE ${k.table} SET low_stock_threshold = ?, updated_at = ${NOW} WHERE id = ? AND restaurant_id = ?`).run(lowStockThreshold, row.id, restaurantId);
    if (isAvailable !== undefined) db.prepare(`UPDATE ${k.table} SET is_available = ?, updated_at = ${NOW} WHERE id = ? AND restaurant_id = ?`).run(isAvailable ? 1 : 0, row.id, restaurantId);
    return branchStock(db, restaurantId, branchId).find((x) => x.kind === kind && x.id === itemId);
  });
}

// Total over the active branches, for list views and exports (null for untracked items).
function totalsByItem(db, restaurantId, kind) {
  const k = KINDS[kind];
  const m = new Map();
  for (const r of db.prepare(
    `SELECT s.${k.col} AS item_id, SUM(s.quantity) AS q FROM ${k.table} s JOIN branches b ON b.id = s.branch_id AND b.restaurant_id = s.restaurant_id
     WHERE s.restaurant_id = ? AND b.is_active = 1 GROUP BY s.${k.col}`).all(restaurantId)) m.set(r.item_id, Number(r.q));
  return m;
}

// Product rows as the dashboard lists them: with branches the stock figure is the total over the active branches.
function withBranchTotals(db, restaurantId, rows, kind = 'dish') {
  if (!rows.length || !hasBranches(db, restaurantId)) return rows;
  const totals = totalsByItem(db, restaurantId, kind);
  return rows.map((r) => (r.track_stock ? { ...r, stock_quantity: totals.get(r.id) || 0, _branchTotal: true } : r));
}

// Legacy quantities (kept on the dish / extra) that were never assigned to a branch while the restaurant has several: reported, never guessed.
function legacySummary(db, restaurantId) {
  const branches = activeBranches(db, restaurantId);
  const count = (items, table, col) => db.prepare(
    `SELECT COUNT(*) c FROM ${items} i WHERE i.restaurant_id = ? AND i.track_stock = 1 AND i.stock_quantity > 0 AND NOT EXISTS (SELECT 1 FROM ${table} s WHERE s.${col} = i.id AND s.restaurant_id = i.restaurant_id)`)
    .get(restaurantId).c;
  const dishes = count('products', 'branch_stock', 'product_id');
  const extras = count('restaurant_extras', 'branch_extra_stock', 'extra_id');
  return { unassignedDishes: dishes, unassignedExtras: extras, ambiguous: branches.length > 1 && dishes + extras > 0 };
}

// Copies the legacy quantity of every tracked item that has no branch row yet into ONE branch. Used automatically for the first branch of a
// restaurant (unambiguous) and on request by the owner for the multi-branch case. Rows that already exist are never touched.
function adoptLegacy(db, restaurantId, branchId) {
  return tx(db, () => {
    ownBranch(db, restaurantId, branchId);
    const d = db.prepare(
      `INSERT INTO branch_stock (restaurant_id, branch_id, product_id, quantity)
       SELECT p.restaurant_id, CAST(? AS INTEGER), p.id, p.stock_quantity FROM products p WHERE p.restaurant_id = ? AND p.track_stock = 1
         AND NOT EXISTS (SELECT 1 FROM branch_stock s WHERE s.product_id = p.id AND s.restaurant_id = p.restaurant_id AND s.branch_id IN (SELECT id FROM branches WHERE restaurant_id = p.restaurant_id))`)
      .run(branchId, restaurantId).changes;
    const e = db.prepare(
      `INSERT INTO branch_extra_stock (restaurant_id, branch_id, extra_id, quantity)
       SELECT x.restaurant_id, CAST(? AS INTEGER), x.id, x.stock_quantity FROM restaurant_extras x WHERE x.restaurant_id = ? AND x.track_stock = 1
         AND NOT EXISTS (SELECT 1 FROM branch_extra_stock s WHERE s.extra_id = x.id AND s.restaurant_id = x.restaurant_id AND s.branch_id IN (SELECT id FROM branches WHERE restaurant_id = x.restaurant_id))`)
      .run(branchId, restaurantId).changes;
    return { dishes: d, extras: e };
  });
}

module.exports = {
  DEFAULT_LOW_STOCK, activeBranches, hasBranches, resolveBranch, stockRows, atBranch, reserve, reserveExtra, restoreForOrder,
  ownBranch, branchStock, branchSummaries, updateStock, totalsByItem, withBranchTotals, legacySummary, adoptLegacy, distanceKm,
};
