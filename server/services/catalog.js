// Menu domain logic shared by the restaurant dashboard API (routes/manage.js), the public menu (routes/public.js) and ordering
// (services/orders.js): bilingual text, original/discounted pricing, stock availability and restaurant-defined extras.
//
// Money is integer minor units. `products.price_cents` is ALWAYS the price a customer is charged; `original_price_cents`
// is only set while a discount is active and is then strictly greater than price_cents (enforced by a CHECK constraint too).
const { tx } = require('../db');
const { HttpError, fail, str, int, bool, imageUrl } = require('../utils');
const { mulDiv } = require('./money');

const MAX_PRICE_CENTS = 1e8;
const MAX_STOCK = 1e6;
const LOCALIZED_KEYS = ['nameAr', 'nameEn', 'descriptionAr', 'descriptionEn'];

// ---------------------------------------------------------------- pricing & availability (pure functions of a product row)
const originalPriceOf = (p) => (p.original_price_cents != null ? p.original_price_cents : p.price_cents);
const hasDiscount = (p) => p.original_price_cents != null && p.original_price_cents > p.price_cents;
const discountPercent = (p) => (hasDiscount(p) ? mulDiv(p.original_price_cents - p.price_cents, 100, p.original_price_cents) : 0);
const stockLeft = (p) => (p.track_stock ? p.stock_quantity : null); // null = unlimited
// A dish can be ordered when the owner has not switched it off AND (stock is not tracked OR some stock remains).
const isOrderable = (p) => !!p.is_available && (!p.track_stock || p.stock_quantity > 0);

// ---------------------------------------------------------------- formatting
const text = (v) => (v == null ? '' : v);

function formatProduct(p, extra = {}) {
  return {
    id: p.id, categoryId: p.category_id,
    name: p.name, description: p.description,
    nameAr: text(p.name_ar), nameEn: text(p.name_en), descriptionAr: text(p.description_ar), descriptionEn: text(p.description_en),
    // priceCents = what the customer pays (discounted price when a discount is active)
    priceCents: p.price_cents,
    originalPriceCents: originalPriceOf(p),
    discountedPriceCents: hasDiscount(p) ? p.price_cents : null,
    hasDiscount: hasDiscount(p), discountPercent: discountPercent(p),
    // set when an active discount RULE (not the dish's own discounted price) produced the price
    discountRuleId: p.discount_rule_id ?? null, discountRuleNameAr: text(p.discount_rule_name_ar), discountRuleNameEn: text(p.discount_rule_name_en),
    imageUrl: p.image_url, isAvailable: !!p.is_available,
    trackStock: !!p.track_stock, stockQuantity: p.track_stock ? p.stock_quantity : null, stockIsBranchTotal: !!p._branchTotal,
    orderable: isOrderable(p), soldOut: !isOrderable(p),
    // owner-facing hint: which language still has no text of its own
    missingTranslations: [!p.name_ar || !p.description_ar ? 'ar' : null, !p.name_en || !p.description_en ? 'en' : null].filter(Boolean),
    ...extra,
  };
}

const formatOption = (o) => ({
  id: o.id, name: o.name, nameAr: text(o.name_ar), nameEn: text(o.name_en),
  priceCents: o.price_cents, maxQuantity: o.max_quantity, isAvailable: !!o.is_available,
});
const formatGroup = (g, options) => ({
  id: g.id, productId: g.product_id, name: g.name, nameAr: text(g.name_ar), nameEn: text(g.name_en),
  minSelect: g.min_select, maxSelect: g.max_select, required: g.min_select > 0, options: options.map(formatOption),
});

function loadGroups(db, restaurantId, productId) {
  const groups = db.prepare('SELECT * FROM option_groups WHERE product_id = ? AND restaurant_id = ? ORDER BY sort_order, id').all(productId, restaurantId);
  const options = db.prepare(
    `SELECT o.* FROM options o WHERE o.restaurant_id = ? AND o.group_id IN (SELECT id FROM option_groups WHERE product_id = ? AND restaurant_id = ?)
     ORDER BY o.sort_order, o.id`).all(restaurantId, productId, restaurantId);
  return groups.map((g) => formatGroup(g, options.filter((o) => o.group_id === g.id)));
}

// ---------------------------------------------------------------- parsing the dish form
// Localized mode (any of nameAr / nameEn / descriptionAr / descriptionEn present): all four are required, so a dish saved from the
// dashboard always carries text the owner wrote in BOTH languages. Nothing is ever machine-translated. The canonical `name` /
// `description` columns mirror the English text and remain the fallback shown wherever a translation is missing.
// Legacy mode (only `name` / `description`): kept so existing API clients keep working; the dish then has no Arabic/English text.
function parseText(b, cur) {
  const touchesLocalized = LOCALIZED_KEYS.some((k) => b[k] !== undefined);
  if (touchesLocalized) {
    const get = (key, curVal) => (b[key] !== undefined ? b[key] : curVal);
    const nameAr = str(get('nameAr', cur?.name_ar), 'nameAr', { max: 120 });
    const nameEn = str(get('nameEn', cur?.name_en), 'nameEn', { max: 120 });
    const descriptionAr = str(get('descriptionAr', cur?.description_ar), 'descriptionAr', { max: 1000 });
    const descriptionEn = str(get('descriptionEn', cur?.description_en), 'descriptionEn', { max: 1000 });
    return { name: nameEn, description: descriptionEn, name_ar: nameAr, name_en: nameEn, description_ar: descriptionAr, description_en: descriptionEn };
  }
  if (!cur) {
    return { name: str(b.name, 'name', { max: 120 }), description: str(b.description, 'description', { max: 1000, optional: true }) || '', name_ar: null, name_en: null, description_ar: null, description_en: null };
  }
  if (b.name === undefined && b.description === undefined) return null; // text untouched
  if (cur.name_ar || cur.name_en) {
    fail('name', 'this dish has Arabic/English text: send nameAr, nameEn, descriptionAr and descriptionEn', 'use_localized');
  }
  return {
    name: b.name !== undefined ? str(b.name, 'name', { max: 120 }) : cur.name,
    description: b.description !== undefined ? (str(b.description, 'description', { max: 1000, optional: true }) || '') : cur.description,
    name_ar: null, name_en: null, description_ar: null, description_en: null,
  };
}

// originalPriceCents is the price before any discount; discountedPriceCents (optional, null/absent = no discount) the price actually
// charged. The legacy `priceCents` is an alias of originalPriceCents and, when sent alone, clears any discount.
function parsePrices(b, cur) {
  let original = cur ? originalPriceOf(cur) : null;
  let discounted = cur && hasDiscount(cur) ? cur.price_cents : null;
  if (b.originalPriceCents !== undefined) original = int(b.originalPriceCents, 'originalPriceCents', { max: MAX_PRICE_CENTS });
  else if (b.priceCents !== undefined) {
    original = int(b.priceCents, 'priceCents', { max: MAX_PRICE_CENTS });
    if (b.discountedPriceCents === undefined) discounted = null;
  }
  if (b.discountedPriceCents !== undefined) {
    discounted = b.discountedPriceCents === null || b.discountedPriceCents === '' ? null : int(b.discountedPriceCents, 'discountedPriceCents', { max: MAX_PRICE_CENTS });
  }
  if (original === null) fail('originalPriceCents', 'is required', 'required');
  if (discounted !== null) {
    if (discounted <= 0) fail('discountedPriceCents', 'must be greater than zero', 'discount_not_positive');
    if (discounted >= original) fail('discountedPriceCents', 'must be lower than the original price', 'discount_not_lower');
  }
  return { price_cents: discounted ?? original, original_price_cents: discounted !== null ? original : null };
}

function parseStock(b, cur) {
  let track = cur ? cur.track_stock : 0;
  let qty = cur ? cur.stock_quantity : 0;
  if (b.trackStock !== undefined) track = bool(b.trackStock, 'trackStock') ? 1 : 0;
  if (b.stockQuantity !== undefined) qty = int(b.stockQuantity, 'stockQuantity', { max: MAX_STOCK });
  return { track_stock: track, stock_quantity: qty };
}

// ---------------------------------------------------------------- extras (option groups) - parsing
function parseNames(o, path, max) {
  if (o.nameAr !== undefined || o.nameEn !== undefined) {
    const ar = str(o.nameAr, `${path}.nameAr`, { max });
    const en = str(o.nameEn, `${path}.nameEn`, { max });
    return { name: en, name_ar: ar, name_en: en };
  }
  return { name: str(o.name, `${path}.name`, { max }), name_ar: null, name_en: null };
}

function parseGroup(g, path) {
  if (!g || typeof g !== 'object') fail(path, 'must be an object', 'invalid');
  const names = parseNames(g, path, 80);
  const list = g.options;
  if (!Array.isArray(list) || list.length < 1 || list.length > 30) fail(`${path}.options`, 'provide 1-30 extras', 'options_count', { min: 1, max: 30 });
  const options = list.map((o, j) => {
    const p = `${path}.options[${j}]`;
    if (!o || typeof o !== 'object') fail(p, 'must be an object', 'invalid');
    return {
      id: o.id === undefined || o.id === null ? null : int(o.id, `${p}.id`, { min: 1 }),
      ...parseNames(o, p, 80),
      priceCents: int(o.priceCents ?? 0, `${p}.priceCents`, { max: 1e7 }),
      maxQuantity: int(o.maxQuantity ?? 1, `${p}.maxQuantity`, { min: 1, max: 20 }),
      isAvailable: o.isAvailable === undefined ? true : bool(o.isAvailable, `${p}.isAvailable`),
    };
  });
  const localized = g.nameAr !== undefined || g.nameEn !== undefined;
  const minSelect = int(g.minSelect ?? (g.required === true ? 1 : 0), `${path}.minSelect`, { max: 30 });
  // sensible default: with the bilingual form every extra of the group may be chosen; the legacy API defaulted to one choice
  const maxSelect = int(g.maxSelect ?? (localized ? options.length : 1), `${path}.maxSelect`, { min: 1, max: 30 });
  if (minSelect > maxSelect || maxSelect > options.length) fail(`${path}.maxSelect`, 'minSelect/maxSelect are inconsistent with the number of extras', 'select_range');
  return { id: g.id === undefined || g.id === null ? null : int(g.id, `${path}.id`, { min: 1 }), ...names, minSelect, maxSelect, options };
}

function parseGroups(list) {
  if (!Array.isArray(list)) fail('optionGroups', 'must be a list', 'invalid');
  if (list.length > 10) fail('optionGroups', 'at most 10 extra groups per dish', 'too_many', { max: 10 });
  return list.map((g, i) => parseGroup(g, `optionGroups[${i}]`));
}

// ---------------------------------------------------------------- extras - persistence
// Past orders keep their own snapshot rows (order_item_options); before an extra / group / dish is deleted its references are
// detached explicitly (the composite FK would otherwise try to NULL the NOT NULL restaurant_id column and refuse the delete).
function removeOption(db, restaurantId, optionId) {
  db.prepare('UPDATE order_item_options SET option_id = NULL WHERE option_id = ? AND restaurant_id = ?').run(optionId, restaurantId);
  db.prepare('DELETE FROM options WHERE id = ? AND restaurant_id = ?').run(optionId, restaurantId);
}
function removeGroup(db, restaurantId, groupId) {
  db.prepare('UPDATE order_item_options SET option_id = NULL WHERE restaurant_id = ? AND option_id IN (SELECT id FROM options WHERE group_id = ? AND restaurant_id = ?)')
    .run(restaurantId, groupId, restaurantId);
  db.prepare('DELETE FROM option_groups WHERE id = ? AND restaurant_id = ?').run(groupId, restaurantId);
}
function removeProduct(db, restaurantId, productId) {
  return tx(db, () => {
    db.prepare('UPDATE order_items SET product_id = NULL WHERE product_id = ? AND restaurant_id = ?').run(productId, restaurantId);
    db.prepare('UPDATE order_item_options SET option_id = NULL WHERE restaurant_id = ? AND option_id IN (SELECT o.id FROM options o WHERE o.restaurant_id = ? AND o.group_id IN (SELECT id FROM option_groups WHERE product_id = ? AND restaurant_id = ?))')
      .run(restaurantId, restaurantId, productId, restaurantId);
    return db.prepare('DELETE FROM products WHERE id = ? AND restaurant_id = ?').run(productId, restaurantId).changes;
  });
}

// Creates or updates ONE extras group of a dish together with its extras (already parsed). Extras that carry an id keep it (carts and
// history stay linked); extras of the group that are not mentioned are removed. Every id is checked against THIS dish of THIS
// restaurant. `existingGroupIds` are the ids currently stored for the dish. Returns the group id.
function upsertGroup(db, restaurantId, productId, g, sortIndex, existingGroupIds, path = 'optionGroups[0]') {
  return tx(db, () => {
    let gid = g.id;
    if (gid !== null) {
      if (!existingGroupIds.includes(gid)) fail(`${path}.id`, 'that group does not belong to this dish', 'invalid_id');
      db.prepare('UPDATE option_groups SET name = ?, name_ar = ?, name_en = ?, min_select = ?, max_select = ?, sort_order = ? WHERE id = ? AND restaurant_id = ?')
        .run(g.name, g.name_ar, g.name_en, g.minSelect, g.maxSelect, sortIndex, gid, restaurantId);
    } else {
      gid = Number(db.prepare('INSERT INTO option_groups (restaurant_id, product_id, name, name_ar, name_en, min_select, max_select, sort_order) VALUES (?,?,?,?,?,?,?,?)')
        .run(restaurantId, productId, g.name, g.name_ar, g.name_en, g.minSelect, g.maxSelect, sortIndex).lastInsertRowid);
    }
    const existingOptions = db.prepare('SELECT id FROM options WHERE group_id = ? AND restaurant_id = ?').all(gid, restaurantId).map((r) => r.id);
    const kept = new Set();
    g.options.forEach((o, oi) => {
      if (o.id !== null) {
        if (!existingOptions.includes(o.id)) fail(`${path}.options[${oi}].id`, 'that extra does not belong to this group', 'invalid_id');
        db.prepare('UPDATE options SET name = ?, name_ar = ?, name_en = ?, price_cents = ?, max_quantity = ?, is_available = ?, sort_order = ? WHERE id = ? AND restaurant_id = ?')
          .run(o.name, o.name_ar, o.name_en, o.priceCents, o.maxQuantity, o.isAvailable ? 1 : 0, oi, o.id, restaurantId);
        kept.add(o.id);
      } else {
        kept.add(Number(db.prepare('INSERT INTO options (restaurant_id, group_id, name, name_ar, name_en, price_cents, max_quantity, is_available, sort_order) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(restaurantId, gid, o.name, o.name_ar, o.name_en, o.priceCents, o.maxQuantity, o.isAvailable ? 1 : 0, oi).lastInsertRowid));
      }
    });
    for (const oid of existingOptions) if (!kept.has(oid)) removeOption(db, restaurantId, oid);
    return gid;
  });
}

// Makes the stored groups of a dish equal to `groups` (already parsed): groups with an id are updated in place, the others created,
// and groups not mentioned are removed. Atomic - runs inside the caller's transaction or its own.
function syncGroups(db, restaurantId, productId, groups) {
  return tx(db, () => {
    const existing = db.prepare('SELECT id FROM option_groups WHERE product_id = ? AND restaurant_id = ?').all(productId, restaurantId).map((r) => r.id);
    const kept = new Set();
    groups.forEach((g, gi) => kept.add(upsertGroup(db, restaurantId, productId, g, gi, existing, `optionGroups[${gi}]`)));
    for (const gid of existing) if (!kept.has(gid)) removeGroup(db, restaurantId, gid);
  });
}

const stockError = (p, requested) => {
  const left = Math.max(0, p.stock_quantity);
  return left === 0
    ? new HttpError(422, 'out_of_stock', `"${p.name}" is out of stock`, { productId: p.id, available: 0, name: p.name, nameAr: p.name_ar, nameEn: p.name_en })
    : new HttpError(422, 'insufficient_stock', `Only ${left} of "${p.name}" left (you asked for ${requested})`, { productId: p.id, available: left, requested, name: p.name, nameAr: p.name_ar, nameEn: p.name_en });
};

// ---------------------------------------------------------------- general (order-level) extras
// Items a customer adds to an order WITHOUT choosing a dish (water, fries, sauces ...). They belong to the restaurant
// (restaurant_extras), are priced from this table at order time, and are completely separate from the dish-specific extras above.
const EXTRA_CATEGORIES = ['drinks', 'sides', 'sauces', 'other'];
const MAX_EXTRA_QTY = 50;
// listing order: drinks, sides, sauces, other (then the owner's order); a plain ORDER BY category would sort alphabetically
const EXTRA_ORDER = "CASE category WHEN 'drinks' THEN 0 WHEN 'sides' THEN 1 WHEN 'sauces' THEN 2 ELSE 3 END, sort_order, id";
const isExtraOrderable = (e) => !!e.is_available && (!e.track_stock || e.stock_quantity > 0);

const formatExtra = (e) => ({
  id: e.id, name: e.name, nameAr: text(e.name_ar), nameEn: text(e.name_en),
  descriptionAr: text(e.description_ar), descriptionEn: text(e.description_en),
  category: e.category, priceCents: e.price_cents, imageUrl: e.image_url,
  isAvailable: !!e.is_available, trackStock: !!e.track_stock, stockQuantity: e.track_stock ? e.stock_quantity : null,
  maxQuantity: e.max_quantity, sortOrder: e.sort_order,
  orderable: isExtraOrderable(e), soldOut: !isExtraOrderable(e),
  missingTranslations: [!e.name_ar ? 'ar' : null, !e.name_en ? 'en' : null].filter(Boolean),
});

// Both names are required (the owner writes each language himself - nothing is machine translated); descriptions are optional.
// `cur` is the stored row on update: fields that are not sent keep their stored value.
function parseExtra(b, cur) {
  const get = (key, curVal) => (b[key] !== undefined ? b[key] : curVal);
  const nameAr = str(get('nameAr', cur?.name_ar), 'nameAr', { max: 80 });
  const nameEn = str(get('nameEn', cur?.name_en), 'nameEn', { max: 80 });
  const descriptionAr = str(get('descriptionAr', cur?.description_ar), 'descriptionAr', { max: 300, optional: true });
  const descriptionEn = str(get('descriptionEn', cur?.description_en), 'descriptionEn', { max: 300, optional: true });
  const category = b.category !== undefined ? b.category : (cur?.category ?? 'other');
  if (!EXTRA_CATEGORIES.includes(category)) fail('category', 'must be drinks, sides, sauces or other', 'invalid');
  const price = b.priceCents !== undefined ? int(b.priceCents, 'priceCents', { max: 1e7 }) : cur?.price_cents;
  if (price === undefined || price === null) fail('priceCents', 'is required', 'required');
  const track = b.trackStock !== undefined ? (bool(b.trackStock, 'trackStock') ? 1 : 0) : (cur?.track_stock ?? 0);
  const qty = b.stockQuantity !== undefined ? int(b.stockQuantity, 'stockQuantity', { max: MAX_STOCK }) : (cur?.stock_quantity ?? 0);
  const max = b.maxQuantity !== undefined ? int(b.maxQuantity, 'maxQuantity', { min: 1, max: MAX_EXTRA_QTY }) : (cur?.max_quantity ?? 20);
  return {
    name: nameEn, name_ar: nameAr, name_en: nameEn, description_ar: descriptionAr, description_en: descriptionEn,
    category, price_cents: price,
    image_url: b.imageUrl !== undefined ? imageUrl(b.imageUrl) : (cur?.image_url ?? null),
    is_available: b.isAvailable !== undefined ? (bool(b.isAvailable, 'isAvailable') ? 1 : 0) : (cur?.is_available ?? 1),
    track_stock: track, stock_quantity: qty, max_quantity: max,
  };
}

const extraStockError = (e, requested) => {
  const left = Math.max(0, e.stock_quantity);
  const names = { extraId: e.id, name: e.name, nameAr: e.name_ar, nameEn: e.name_en };
  return left === 0
    ? new HttpError(422, 'out_of_stock', `"${e.name}" is out of stock`, { ...names, available: 0 })
    : new HttpError(422, 'insufficient_stock', `Only ${left} of "${e.name}" left (you asked for ${requested})`, { ...names, available: left, requested });
};

module.exports = {
  MAX_PRICE_CENTS, originalPriceOf, hasDiscount, discountPercent, stockLeft, isOrderable,
  formatProduct, formatOption, formatGroup, loadGroups,
  parseText, parsePrices, parseStock, parseGroup, parseGroups, upsertGroup, syncGroups, removeOption, removeGroup, removeProduct, stockError,
  EXTRA_CATEGORIES, EXTRA_ORDER, MAX_EXTRA_QTY, isExtraOrderable, formatExtra, parseExtra, extraStockError,
};
