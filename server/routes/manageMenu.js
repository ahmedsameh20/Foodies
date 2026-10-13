// Dashboard API for: branches (map locations), per-branch stock, discount rules and Excel import / export of dishes.
// Mounted by routes/manage.js AFTER tenantContext: req.restaurant is the signed-in user's own restaurant. Every query below is scoped by
// it; ids from the URL or body are only ever used together with that restaurant id.
const express = require('express');
const crypto = require('node:crypto');
const { tx } = require('../db');
const { requireOwner } = require('../middleware/auth');
const { enforceLimit } = require('../services/plans');
const branches = require('../services/branches');
const inventory = require('../services/inventory');
const discounts = require('../services/discounts');
const coupons = require('../services/coupons');
const dishSheet = require('../services/dishSheet');
const { withIdempotency } = require('../services/idempotency');
const { audit } = require('../services/platform');
const {
  HttpError, notFound, int, bool, ok,
} = require('../utils');

const router = express.Router();
const idOf = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : 0; };

// ---------------------------------------------------------------- branches
router.get('/branches', (req, res) => {
  const rows = req.db.prepare('SELECT * FROM branches WHERE restaurant_id = ? ORDER BY is_active DESC, name, id').all(req.restaurant.id);
  ok(res, { branches: rows.map(branches.formatBranch) });
});

router.post('/branches', requireOwner, (req, res) => {
  const data = branches.parseBranch(req.body, null);
  const id = tx(req.db, () => {
    enforceLimit(req.db, req.restaurant.id, 'branches');
    return branches.insertBranch(req.db, req.restaurant.id, data);
  });
  ok(res, { branch: branches.formatBranch(req.db.prepare('SELECT * FROM branches WHERE id = ? AND restaurant_id = ?').get(id, req.restaurant.id)) }, 201);
});

router.put('/branches/:id', requireOwner, (req, res) => {
  const id = idOf(req.params.id);
  const cur = req.db.prepare('SELECT * FROM branches WHERE id = ? AND restaurant_id = ?').get(id, req.restaurant.id);
  if (!cur) throw notFound('Branch');
  const data = branches.parseBranch(req.body, cur);
  branches.updateBranch(req.db, req.restaurant.id, id, data);
  ok(res, { branch: branches.formatBranch(req.db.prepare('SELECT * FROM branches WHERE id = ? AND restaurant_id = ?').get(id, req.restaurant.id)) });
});

router.delete('/branches/:id', requireOwner, (req, res) => {
  if (!branches.deleteBranch(req.db, req.restaurant.id, idOf(req.params.id))) throw notFound('Branch');
  ok(res, { deleted: true });
});

// ---------------------------------------------------------------- stock per branch (owner and staff)
router.get('/stock/branches', (req, res) => {
  ok(res, { branches: inventory.branchSummaries(req.db, req.restaurant.id), legacy: inventory.legacySummary(req.db, req.restaurant.id), defaultLowStock: inventory.DEFAULT_LOW_STOCK });
});

router.get('/stock', (req, res) => {
  const branchId = idOf(req.query.branchId);
  inventory.ownBranch(req.db, req.restaurant.id, branchId);
  const items = inventory.branchStock(req.db, req.restaurant.id, branchId);
  const tracked = items.filter((i) => i.trackStock);
  ok(res, {
    branch: branches.formatBranch(req.db.prepare('SELECT * FROM branches WHERE id = ? AND restaurant_id = ?').get(branchId, req.restaurant.id)),
    items,
    summary: { tracked: tracked.length, out: tracked.filter((i) => i.state === 'out').length, low: tracked.filter((i) => i.state === 'low').length, ok: tracked.filter((i) => i.state === 'ok').length },
    legacy: inventory.legacySummary(req.db, req.restaurant.id),
  });
});

router.patch('/stock/:kind/:id', (req, res) => {
  const kind = req.params.kind === 'dishes' ? 'dish' : req.params.kind === 'extras' ? 'extra' : null;
  if (!kind) throw notFound('Item');
  const b = req.body || {};
  const branchId = int(b.branchId, 'branchId', { min: 1 });
  if (b.quantity !== undefined && b.restockBy !== undefined) throw new HttpError(400, 'validation_error', 'quantity: send either quantity or restockBy, not both', { field: 'quantity', reason: 'conflict' });
  const patch = {
    kind, itemId: idOf(req.params.id), branchId,
    quantity: b.quantity !== undefined ? int(b.quantity, 'quantity', { max: 1e6 }) : undefined,
    restockBy: b.restockBy !== undefined ? int(b.restockBy, 'restockBy', { min: 1, max: 1e6 }) : undefined,
    lowStockThreshold: b.lowStockThreshold !== undefined ? int(b.lowStockThreshold, 'lowStockThreshold', { max: 1e6, optional: true }) : undefined,
    isAvailable: b.isAvailable !== undefined ? bool(b.isAvailable, 'isAvailable') : undefined,
  };
  if (Object.values(patch).every((v, i) => i < 3 || v === undefined) && patch.quantity === undefined && patch.restockBy === undefined) {
    throw new HttpError(400, 'validation_error', 'quantity: nothing to update', { field: 'quantity', reason: 'required' });
  }
  ok(res, { item: inventory.updateStock(req.db, req.restaurant.id, patch) });
});

// Several branches and quantities that live only on the dishes: the owner decides which branch holds them (never guessed).
router.post('/stock/adopt-legacy', requireOwner, (req, res) => {
  const branchId = int(req.body?.branchId, 'branchId', { min: 1 });
  ok(res, { adopted: inventory.adoptLegacy(req.db, req.restaurant.id, branchId) });
});

// ---------------------------------------------------------------- coupons (owner)
// Every query below is scoped by req.restaurant: a coupon of another restaurant does not exist for this one. Customers and staff are refused.
const couponOr404 = (db, rid, id) => { const c = coupons.describe(db, rid).find((x) => x.id === id); if (!c) throw notFound('Coupon'); return c; };

router.get('/coupons', requireOwner, (req, res) => ok(res, { coupons: coupons.describe(req.db, req.restaurant.id) }));

router.get('/coupons/generate-code', requireOwner, (req, res) => ok(res, { code: coupons.generateCode(req.db, req.restaurant.id) }));

router.get('/coupons/:id', requireOwner, (req, res) => {
  const coupon = couponOr404(req.db, req.restaurant.id, idOf(req.params.id));
  ok(res, { coupon, redemptions: coupons.redemptionHistory(req.db, req.restaurant.id, coupon.id) });
});

router.post('/coupons', requireOwner, (req, res) => {
  const parsed = coupons.parseCoupon(req.db, req.restaurant.id, req.body || {}, null);
  const id = coupons.saveCoupon(req.db, req.restaurant.id, null, parsed);
  audit(req.db, req, 'coupon.create', 'coupon', id, { restaurantId: req.restaurant.id });
  ok(res, { coupon: couponOr404(req.db, req.restaurant.id, id) }, 201);
});

router.put('/coupons/:id', requireOwner, (req, res) => {
  const id = idOf(req.params.id);
  const cur = coupons.loadAll(req.db, req.restaurant.id, id)[0];
  if (!cur) throw notFound('Coupon');
  const parsed = coupons.parseCoupon(req.db, req.restaurant.id, req.body || {}, cur);
  coupons.saveCoupon(req.db, req.restaurant.id, id, parsed);
  audit(req.db, req, 'coupon.update', 'coupon', id, { restaurantId: req.restaurant.id });
  ok(res, { coupon: couponOr404(req.db, req.restaurant.id, id) });
});

router.delete('/coupons/:id', requireOwner, (req, res) => {
  const id = idOf(req.params.id);
  if (!coupons.removeCoupon(req.db, req.restaurant.id, id)) throw notFound('Coupon');
  audit(req.db, req, 'coupon.delete', 'coupon', id, { restaurantId: req.restaurant.id });
  ok(res, { deleted: true });
});

// ---------------------------------------------------------------- discount rules (owner)
router.get('/discounts', requireOwner, (req, res) => {
  ok(res, { rules: discounts.describe(req.db, req.restaurant.id) });
});

router.get('/discounts/:id', requireOwner, (req, res) => {
  const rule = discounts.describe(req.db, req.restaurant.id, new Date(), { withItems: true }).find((r) => r.id === idOf(req.params.id));
  if (!rule) throw notFound('Discount');
  ok(res, { rule });
});

const ruleOr404 = (db, rid, id) => { const r = discounts.loadAllRules(db, rid).find((x) => x.id === id); if (!r) throw notFound('Discount'); return r; };

router.post('/discounts', requireOwner, (req, res) => {
  const parsed = discounts.parseRule(req.db, req.restaurant.id, req.body || {}, null);
  const id = discounts.saveRule(req.db, req.restaurant.id, null, parsed);
  audit(req.db, req, 'discount.create', 'discount_rule', id, { restaurantId: req.restaurant.id });
  ok(res, { rule: discounts.describe(req.db, req.restaurant.id, new Date(), { withItems: true }).find((r) => r.id === id) }, 201);
});

router.put('/discounts/:id', requireOwner, (req, res) => {
  const id = idOf(req.params.id);
  const cur = ruleOr404(req.db, req.restaurant.id, id);
  const parsed = discounts.parseRule(req.db, req.restaurant.id, req.body || {}, cur);
  discounts.saveRule(req.db, req.restaurant.id, id, parsed);
  audit(req.db, req, 'discount.update', 'discount_rule', id, { restaurantId: req.restaurant.id });
  ok(res, { rule: discounts.describe(req.db, req.restaurant.id, new Date(), { withItems: true }).find((r) => r.id === id) });
});

router.delete('/discounts/:id', requireOwner, (req, res) => {
  const id = idOf(req.params.id);
  ruleOr404(req.db, req.restaurant.id, id);
  tx(req.db, () => {
    req.db.prepare('UPDATE order_items SET discount_rule_id = NULL WHERE discount_rule_id = ? AND restaurant_id = ?').run(id, req.restaurant.id); // the name snapshot stays
    req.db.prepare('DELETE FROM discount_rules WHERE id = ? AND restaurant_id = ?').run(id, req.restaurant.id);
  });
  audit(req.db, req, 'discount.delete', 'discount_rule', id, { restaurantId: req.restaurant.id });
  ok(res, { deleted: true });
});

// ---------------------------------------------------------------- Excel import / export of dishes (owner)
const sendWorkbook = (res, buffer, name) => {
  res.set({ 'Content-Type': dishSheet.XLSX_MIME, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(buffer);
};
const stamp = () => new Date().toISOString().slice(0, 10);

router.get('/dishes/template.xlsx', requireOwner, async (req, res) => {
  sendWorkbook(res, await dishSheet.buildWorkbook(req.db, req.restaurant, { template: true }), 'foodies-dishes-template.xlsx');
});

router.get('/dishes/export.xlsx', requireOwner, async (req, res) => {
  sendWorkbook(res, await dishSheet.buildWorkbook(req.db, req.restaurant), `foodies-dishes-${stamp()}.xlsx`);
});

// 2 MB, and only a workbook content type: anything else never reaches the parser (the parser checks the ZIP structure again).
const upload = express.raw({ type: [dishSheet.XLSX_MIME, 'application/octet-stream'], limit: '2mb' });
function uploadedFile(req) {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw new HttpError(415, 'unsupported_media', 'Upload an Excel (.xlsx) file (max 2 MB)');
  }
  return req.body;
}
const importMode = (req) => (req.query.mode === 'update' ? 'update' : 'create');

router.post('/dishes/import/preview', requireOwner, upload, async (req, res) => {
  const report = await dishSheet.analyze(req.db, req.restaurant.id, uploadedFile(req), { mode: importMode(req) });
  ok(res, { report: dishSheet.publicReport(report) });
});

router.post('/dishes/import', requireOwner, upload, async (req, res) => {
  const file = uploadedFile(req);
  const mode = importMode(req);
  const skipInvalid = req.query.skipInvalid === '1';
  // The Idempotency-Key makes a double click / retry return the first result instead of importing twice (and re-importing the same
  // file in create mode only skips the dishes that already exist).
  const result = await withIdempotency(req.db,
    { userId: req.user.id, scope: `dish-import:${req.restaurant.id}`, key: req.get('Idempotency-Key'), body: { sha: crypto.createHash('sha256').update(file).digest('hex'), mode, skipInvalid } },
    async () => {
      const out = await dishSheet.commit(req.db, req.restaurant.id, file, { mode, skipInvalid });
      audit(req.db, req, 'dishes.import', 'restaurant', req.restaurant.id, { mode, created: out.created, updated: out.updated, skipped: out.skipped, failed: out.failed });
      return { status: 200, body: { data: { summary: { created: out.created, updated: out.updated, skipped: out.skipped, failed: out.failed }, report: out.report } } };
    });
  if (result.replayed) res.set('Idempotent-Replay', 'true');
  res.status(result.status).json(result.body);
});

module.exports = router;
