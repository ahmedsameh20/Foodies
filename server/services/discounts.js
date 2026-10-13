// Discount rules (restaurant-wide, per category, per dish) and the ONE pricing function that applies them.
//
// Pricing policy (deterministic, no stacking - documented in docs/MENU.md):
//   1. A dish that carries its own manual discount (products.original_price_cents is set) keeps it: it is the most specific discount.
//   2. Otherwise the most specific ACTIVE rule wins: a dish rule beats a category rule, which beats a restaurant-wide rule.
//      Rules are never combined.
//   3. Among rules of the same level the one giving the lowest final price wins; a tie goes to the oldest rule (lowest id).
//   4. A rule that would make the price zero or negative is simply not applicable to that dish.
// A rule is active when: is_active, now is inside [starts_at, ends_at), and its usage limit is not exhausted.
//
// Two different limits (never confuse them):
//   usage_limit             TOTAL redemptions across all customers (NULL = unlimited). Counted in used_count.
//   max_uses_per_customer   how many times ONE customer may redeem THIS rule (NULL = unlimited; new rules default to 1).
// Every redemption is a row in discount_redemptions (one per rule per order, UNIQUE(rule_id, order_id)):
//   reserved  the order was placed (counts toward both limits)
//   redeemed  the order was delivered (still counts)
//   released  the order was cancelled / rejected / its payment failed or expired (no longer counts; used_count is given back exactly once)
// The per-customer limit is applied by hiding the rule from that customer's prices (menu, cart, order) and is re-checked inside the
// order transaction by recordUse(), which is the authoritative guard.
//
// Rules are evaluated when a price is needed (public menu, cart/checkout, order creation), so editing a rule changes every eligible
// dish without touching the dishes. The result is a copy of the product row whose price_cents / original_price_cents are the effective
// ones, so every existing consumer (formatProduct, priceCart, the order snapshot) uses the same backend-calculated figures.
const { mulDiv } = require('./money');
const { tx } = require('../db');
const {
  HttpError, fail, str, int, bool,
} = require('../utils');

const MAX_PERCENT_BP = 9000; // at most 90 % off
const MAX_FIXED_CENTS = 1e8;
const MAX_RULES = 200;
const LEVEL = { product: 0, category: 1, restaurant: 2 };

// ---------------------------------------------------------------- evaluation (pure functions)
const activeAt = (r, nowIso) => !!r.is_active
  && (!r.starts_at || r.starts_at <= nowIso) && (!r.ends_at || r.ends_at > nowIso)
  && (r.usage_limit === null || r.usage_limit === undefined || r.used_count < r.usage_limit);

function status(r, nowIso) {
  if (!r.is_active) return 'inactive';
  if (r.usage_limit !== null && r.usage_limit !== undefined && r.used_count >= r.usage_limit) return 'exhausted';
  if (r.ends_at && r.ends_at <= nowIso) return 'expired';
  if (r.starts_at && r.starts_at > nowIso) return 'scheduled';
  return 'active';
}

// price after the rule, or null when the rule cannot be applied to this base price
function discounted(rule, base) {
  const off = rule.kind === 'percent' ? mulDiv(base, rule.value, 10000) : rule.value;
  const price = base - off;
  return off > 0 && price > 0 ? price : null;
}

const covers = (rule, p) => (rule.scope === 'restaurant'
  || (rule.scope === 'category' && rule.category_id !== null && rule.category_id === p.category_id)
  || (rule.scope === 'product' && rule.productIds.has(p.id)));

// Which rule (if any) sets the price of product row `p`. Returns { rule, price } or null.
function bestRule(p, rules) {
  if (p.original_price_cents !== null && p.original_price_cents !== undefined && p.original_price_cents > p.price_cents) return null; // manual discount wins
  let best = null;
  for (const r of rules) {
    if (!covers(r, p)) continue;
    const price = discounted(r, p.price_cents);
    if (price === null) continue;
    const better = !best || LEVEL[r.scope] < LEVEL[best.rule.scope]
      || (LEVEL[r.scope] === LEVEL[best.rule.scope] && (price < best.price || (price === best.price && r.id < best.rule.id)));
    if (better) best = { rule: r, price };
  }
  return best;
}

// A copy of the product row with the effective price. `discount_rule_id` is null when no rule applied.
function applyToProduct(p, rules) {
  const hit = rules.length ? bestRule(p, rules) : null;
  if (!hit) return { ...p, discount_rule_id: null, discount_rule_name_ar: null, discount_rule_name_en: null };
  return {
    ...p, original_price_cents: p.price_cents, price_cents: hit.price,
    discount_rule_id: hit.rule.id, discount_rule_name_ar: hit.rule.name_ar, discount_rule_name_en: hit.rule.name_en,
  };
}

// ---------------------------------------------------------------- loading
function attachTargets(db, restaurantId, rules) {
  const links = db.prepare('SELECT rule_id, product_id FROM discount_rule_products WHERE restaurant_id = ?').all(restaurantId);
  const byRule = new Map();
  for (const l of links) {
    if (!byRule.has(l.rule_id)) byRule.set(l.rule_id, new Set());
    byRule.get(l.rule_id).add(l.product_id);
  }
  return rules.map((r) => ({ ...r, productIds: byRule.get(r.id) || new Set() }));
}

// Rules this customer has already used up (per-customer limit reached): ids only.
function exhaustedFor(db, restaurantId, customerId) {
  const rows = db.prepare(
    `SELECT r.id FROM discount_rules r
     WHERE r.restaurant_id = ? AND r.max_uses_per_customer IS NOT NULL
       AND (SELECT COUNT(*) FROM discount_redemptions d WHERE d.rule_id = r.id AND d.customer_id = ? AND d.status != 'released') >= r.max_uses_per_customer`).all(restaurantId, customerId);
  return new Set(rows.map((r) => r.id));
}

// Rules that are active right now for this restaurant (always scoped by restaurant_id: a rule never reaches another restaurant's dishes).
// With a customerId, rules that customer has already used as often as allowed are left out, so the price they see is the price they pay.
function loadActiveRules(db, restaurantId, now = new Date(), { customerId = null } = {}) {
  const iso = now.toISOString();
  const rows = db.prepare(
    `SELECT * FROM discount_rules WHERE restaurant_id = ? AND is_active = 1 AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)
       AND (usage_limit IS NULL OR used_count < usage_limit) ORDER BY id`).all(restaurantId, iso, iso);
  if (!rows.length) return [];
  const spent = customerId ? exhaustedFor(db, restaurantId, customerId) : null;
  const usable = spent && spent.size ? rows.filter((r) => !spent.has(r.id)) : rows;
  return usable.length ? attachTargets(db, restaurantId, usable) : [];
}

const loadAllRules = (db, restaurantId) => attachTargets(db, restaurantId,
  db.prepare('SELECT * FROM discount_rules WHERE restaurant_id = ? ORDER BY id DESC').all(restaurantId));

// ---------------------------------------------------------------- parsing & validation
function parseInstant(v, field) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') fail(field, 'must be a date and time', 'invalid_date');
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) fail(field, 'must be a valid date and time', 'invalid_date');
  return d.toISOString();
}

// percent as a number (20, 12.5) -> basis points, at most two decimals
function percentToBp(v, field) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) fail(field, 'must be a number', 'not_integer');
  const bp = Math.round(n * 100);
  if (Math.abs(bp - n * 100) > 1e-6) fail(field, 'at most two decimals', 'too_many_decimals');
  if (bp < 1 || bp > MAX_PERCENT_BP) fail(field, `must be between 0.01 and ${MAX_PERCENT_BP / 100}`, 'discount_percent_range', { min: 0.01, max: MAX_PERCENT_BP / 100 });
  return bp;
}

const nameOf = (b, key, cur, field, max, optional = false) => str(b[key] !== undefined ? b[key] : cur?.[field], key, { max, optional });

// Validates a create / update body against the restaurant's own data and returns the row values + product ids.
function parseRule(db, restaurantId, b, cur) {
  const scope = b.scope !== undefined ? b.scope : cur?.scope;
  if (!['product', 'category', 'restaurant'].includes(scope)) fail('scope', 'must be product, category or restaurant', 'invalid');
  const kind = b.kind !== undefined ? b.kind : cur?.kind;
  if (!['percent', 'fixed'].includes(kind)) fail('kind', 'must be percent or fixed', 'invalid');

  let value;
  if (kind === 'percent') {
    value = b.percent !== undefined ? percentToBp(b.percent, 'percent') : (cur && cur.kind === 'percent' && b.kind === undefined ? cur.value : null);
    if (value === null) fail('percent', 'is required', 'required');
  } else {
    value = b.amountCents !== undefined ? int(b.amountCents, 'amountCents', { min: 1, max: MAX_FIXED_CENTS }) : (cur && cur.kind === 'fixed' && b.kind === undefined ? cur.value : null);
    if (value === null) fail('amountCents', 'is required', 'required');
  }

  let categoryId = null;
  let productIds = null; // null = unchanged on update
  if (scope === 'category') {
    const raw = b.categoryId !== undefined ? b.categoryId : cur?.category_id;
    if (raw === undefined || raw === null || raw === '') fail('categoryId', 'choose a category', 'required');
    categoryId = int(raw, 'categoryId', { min: 1 });
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ? AND restaurant_id = ?').get(categoryId, restaurantId)) fail('categoryId', 'category does not exist', 'invalid_category');
  }
  if (scope === 'product') {
    const raw = b.productIds !== undefined ? b.productIds : (cur?.scope === 'product' ? [...cur.productIds] : undefined);
    if (!Array.isArray(raw) || raw.length < 1) fail('productIds', 'choose at least one dish', 'required');
    if (raw.length > 200) fail('productIds', 'at most 200 dishes per rule', 'too_many', { max: 200 });
    productIds = [...new Set(raw.map((x, i) => int(x, `productIds[${i}]`, { min: 1 })))];
    const prices = productIds.map((id) => db.prepare('SELECT price_cents, original_price_cents FROM products WHERE id = ? AND restaurant_id = ?').get(id, restaurantId));
    if (prices.some((x) => !x)) fail('productIds', 'one of the dishes does not exist', 'invalid_product');
    // a fixed amount must leave a positive price on every chosen dish; (a manual discount on a dish takes precedence and is left alone)
    if (kind === 'fixed' && prices.some((x) => x.original_price_cents === null && value >= x.price_cents)) {
      fail('amountCents', 'must be lower than the price of every selected dish', 'discount_exceeds_price');
    }
  }
  // category / restaurant scope with a fixed amount: dishes cheaper than the amount are skipped by discounted(), never priced at zero or below

  const startsAt = b.startsAt !== undefined ? parseInstant(b.startsAt, 'startsAt') : (cur?.starts_at ?? null);
  const endsAt = b.endsAt !== undefined ? parseInstant(b.endsAt, 'endsAt') : (cur?.ends_at ?? null);
  if (startsAt && endsAt && startsAt >= endsAt) fail('endsAt', 'must be after the start', 'end_before_start');
  const usageLimit = b.usageLimit !== undefined ? int(b.usageLimit, 'usageLimit', { min: 1, max: 1e7, optional: true }) : (cur?.usage_limit ?? null);
  // per customer: a new rule defaults to ONE use per customer; an empty value means unlimited; rules that existed before keep what they have
  const maxPerCustomer = b.maxUsesPerCustomer !== undefined
    ? int(b.maxUsesPerCustomer, 'maxUsesPerCustomer', { min: 1, max: 1e6, optional: true })
    : (cur ? (cur.max_uses_per_customer ?? null) : 1);
  return {
    row: {
      name_ar: nameOf(b, 'nameAr', cur, 'name_ar', 120),
      name_en: nameOf(b, 'nameEn', cur, 'name_en', 120),
      description_ar: nameOf(b, 'descriptionAr', cur, 'description_ar', 500, true),
      description_en: nameOf(b, 'descriptionEn', cur, 'description_en', 500, true),
      scope, kind, value, category_id: categoryId, starts_at: startsAt, ends_at: endsAt,
      is_active: b.isActive !== undefined ? (bool(b.isActive, 'isActive') ? 1 : 0) : (cur?.is_active ?? 1),
      usage_limit: usageLimit ?? null,
      max_uses_per_customer: maxPerCustomer ?? null,
    },
    productIds,
  };
}

// ---------------------------------------------------------------- persistence
function saveRule(db, restaurantId, id, parsed) {
  return tx(db, () => {
    const r = parsed.row;
    let ruleId = id;
    if (ruleId === null) {
      if (db.prepare('SELECT COUNT(*) c FROM discount_rules WHERE restaurant_id = ?').get(restaurantId).c >= MAX_RULES) {
        throw new HttpError(400, 'validation_error', `discounts: at most ${MAX_RULES} discount rules`, { field: 'discounts', reason: 'too_many', max: MAX_RULES });
      }
      ruleId = Number(db.prepare(
        `INSERT INTO discount_rules (restaurant_id, name_ar, name_en, description_ar, description_en, scope, kind, value, category_id, starts_at, ends_at, is_active, usage_limit, max_uses_per_customer)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(restaurantId, r.name_ar, r.name_en, r.description_ar, r.description_en, r.scope, r.kind, r.value, r.category_id, r.starts_at, r.ends_at, r.is_active, r.usage_limit, r.max_uses_per_customer).lastInsertRowid);
    } else {
      db.prepare(
        `UPDATE discount_rules SET name_ar=?, name_en=?, description_ar=?, description_en=?, scope=?, kind=?, value=?, category_id=?, starts_at=?, ends_at=?, is_active=?, usage_limit=?, max_uses_per_customer=?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND restaurant_id = ?`)
        .run(r.name_ar, r.name_en, r.description_ar, r.description_en, r.scope, r.kind, r.value, r.category_id, r.starts_at, r.ends_at, r.is_active, r.usage_limit, r.max_uses_per_customer, ruleId, restaurantId);
    }
    if (r.scope !== 'product') db.prepare('DELETE FROM discount_rule_products WHERE rule_id = ? AND restaurant_id = ?').run(ruleId, restaurantId);
    else if (parsed.productIds) {
      db.prepare('DELETE FROM discount_rule_products WHERE rule_id = ? AND restaurant_id = ?').run(ruleId, restaurantId);
      for (const pid of parsed.productIds) db.prepare('INSERT INTO discount_rule_products (rule_id, restaurant_id, product_id) VALUES (?,?,?)').run(ruleId, restaurantId, pid);
    }
    return ruleId;
  });
}

// ---------------------------------------------------------------- reporting for the dashboard
// For each rule: how many dishes it can cover, how many it actually prices right now (the rest are taken by a more specific rule or a
// manual discount), and the affected dishes with before / after prices.
function describe(db, restaurantId, now = new Date(), { withItems = false } = {}) {
  const iso = now.toISOString();
  const all = loadAllRules(db, restaurantId);
  const active = all.filter((r) => activeAt(r, iso)).sort((a, b) => a.id - b.id);
  const products = db.prepare('SELECT id, category_id, name, name_ar, name_en, price_cents, original_price_cents FROM products WHERE restaurant_id = ?').all(restaurantId);
  const winners = new Map(); // ruleId -> [{product, price}]
  for (const p of products) {
    const hit = bestRule(p, active);
    if (hit) { if (!winners.has(hit.rule.id)) winners.set(hit.rule.id, []); winners.get(hit.rule.id).push({ p, price: hit.price }); }
  }
  return all.map((r) => {
    const eligible = products.filter((p) => covers(r, p) && discounted(r, p.price_cents) !== null && !(p.original_price_cents !== null && p.original_price_cents > p.price_cents));
    const won = winners.get(r.id) || [];
    return {
      id: r.id, nameAr: r.name_ar, nameEn: r.name_en, descriptionAr: r.description_ar || '', descriptionEn: r.description_en || '',
      scope: r.scope, kind: r.kind, percent: r.kind === 'percent' ? r.value / 100 : null, amountCents: r.kind === 'fixed' ? r.value : null,
      categoryId: r.category_id, productIds: [...r.productIds], startsAt: r.starts_at, endsAt: r.ends_at, isActive: !!r.is_active,
      usageLimit: r.usage_limit, usedCount: r.used_count, maxUsesPerCustomer: r.max_uses_per_customer ?? null, status: status(r, iso),
      eligibleCount: eligible.length, affectedCount: won.length,
      ...(withItems ? { items: won.map(({ p, price }) => ({ productId: p.id, name: p.name, nameAr: p.name_ar || '', nameEn: p.name_en || '', beforeCents: p.price_cents, afterCents: price })) } : {}),
    };
  });
}

// Records one redemption per order for every rule that priced one of its lines. Must run inside the order's transaction: the conditional
// UPDATE (total limit; it also locks the rule row) and the per-customer count are the authoritative guards, so two simultaneous checkouts
// can never both take the last use. Throwing rolls the whole order back.
function recordUse(db, restaurantId, ruleIds, { orderId, customerId }) {
  for (const id of new Set(ruleIds.filter(Boolean))) {
    const done = db.prepare(
      'UPDATE discount_rules SET used_count = used_count + 1 WHERE id = ? AND restaurant_id = ? AND (usage_limit IS NULL OR used_count < usage_limit)').run(id, restaurantId).changes === 1;
    if (!done) throw new HttpError(409, 'discount_changed', 'A discount in your cart is no longer available. Please review the prices and try again.');
    const rule = db.prepare('SELECT max_uses_per_customer FROM discount_rules WHERE id = ? AND restaurant_id = ?').get(id, restaurantId);
    const max = rule ? rule.max_uses_per_customer : null;
    if (max !== null && max !== undefined) {
      const used = db.prepare("SELECT COUNT(*) c FROM discount_redemptions WHERE rule_id = ? AND customer_id = ? AND status != 'released'").get(id, customerId).c;
      if (used >= max) throw new HttpError(409, 'discount_customer_limit', 'You have already used this offer the maximum number of times. Please review the prices and try again.', { ruleId: id, max });
    }
    db.prepare('INSERT INTO discount_redemptions (rule_id, restaurant_id, customer_id, order_id) VALUES (?,?,?,?)').run(id, restaurantId, customerId, orderId);
  }
}

// The order was delivered: its redemptions are final.
function markRedeemed(db, orderId) {
  db.prepare("UPDATE discount_redemptions SET status = 'redeemed', redeemed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE order_id = ? AND status = 'reserved'").run(orderId);
}

// The order was cancelled / rejected / its payment failed or expired: give every use back. Idempotent: only the call that moves a row
// from reserved / redeemed to released also gives the total count back, so retries, duplicate webhooks and late events restore exactly once.
function releaseForOrder(db, orderId) {
  return tx(db, () => {
    let released = 0;
    const rows = db.prepare("SELECT id, rule_id FROM discount_redemptions WHERE order_id = ? AND status != 'released'").all(orderId);
    for (const r of rows) {
      const moved = db.prepare("UPDATE discount_redemptions SET status = 'released', released_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status != 'released'").run(r.id).changes === 1;
      if (!moved) continue;
      db.prepare('UPDATE discount_rules SET used_count = used_count - 1 WHERE id = ? AND used_count > 0').run(r.rule_id);
      released += 1;
    }
    return released;
  });
}

module.exports = {
  MAX_PERCENT_BP, percentToBp, parseInstant, loadActiveRules, exhaustedFor, markRedeemed, releaseForOrder, loadAllRules, applyToProduct, bestRule, parseRule, saveRule, describe, recordUse, status,
};
