// Localization guard (run by `npm run check`): the English and Arabic dictionaries must define exactly the same keys, and every
// translation key the frontend uses literally - t('a.b'), data-i18n="a.b", or a key held in a *label / label: 'a.b' property - must exist.
// Keys built at run time (status.<code>, v.<reason>, err.<code> ...) are checked by prefix against the dictionary.
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pub = path.join(root, 'public');

async function load(name) {
  const mod = await import(path.join(pub, 'js', name).replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  return mod.default;
}

function walk(d, exts) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p, exts) : exts.some((x) => p.endsWith(x)) ? [p] : [];
  });
}

(async () => {
  const en = await load('locale-en.js');
  const ar = await load('locale-ar.js');
  let failures = 0;
  const fail = (m) => { failures++; console.error(m); };

  for (const k of Object.keys(en)) if (!(k in ar)) fail(`locale-ar.js is missing "${k}"`);
  for (const k of Object.keys(ar)) if (!(k in en)) fail(`locale-en.js is missing "${k}"`);
  for (const [lang, dict] of [['en', en], ['ar', ar]]) {
    for (const [k, v] of Object.entries(dict)) {
      if (typeof v !== 'string' || !v.trim()) fail(`${lang}: "${k}" is empty`);
      // placeholders must match between languages
      const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
      if (lang === 'ar' && en[k] !== undefined && ph(en[k]) !== ph(v)) fail(`placeholders of "${k}" differ between en and ar`);
    }
  }

  const used = new Set();
  for (const f of walk(path.join(pub, 'js'), ['.js'])) {
    if (/[\\/]locale-(en|ar)\.js$|[\\/]locales[\\/]/.test(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/\b(?:label|title)\s*:\s*'((?:menu|dash|orders|role)\.[\w.]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/\['[a-z_]+',\s*'(orders\.[\w.]+)'\]/g)) used.add(m[1]);
  }
  for (const f of walk(pub, ['.html'])) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/data-i18n(?:-placeholder|-aria-label)?="([\w.]+)"/g)) used.add(m[1]);
  }
  for (const k of used) if (!(k in en)) fail(`used but not defined: "${k}"`);

  // dynamic families: every member must exist
  const families = {
    'status.': ['awaiting_payment', 'pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled', 'rejected'],
    'pay.': ['awaiting_payment', 'paid', 'failed', 'cancelled', 'cod_pending', 'cash_collected', 'refunded', 'partially_refunded'],
    'role.': ['owner', 'staff', 'customer', 'super_admin'],
    'lang.': ['ar', 'en'],
    'gx.cat.': ['drinks', 'sides', 'sauces', 'other'],
    'adm.nav.': ['dashboard', 'restaurants', 'users', 'customers', 'orders', 'payments', 'refunds', 'payouts', 'subscriptions', 'plans', 'reconciliation', 'reports', 'support', 'settings', 'audit', 'system', 'security'],
    'adm.report.': ['revenue', 'orders', 'restaurants', 'customers', 'payments', 'commissions', 'payouts', 'refunds', 'cod', 'finance'],
    'adm.approval.': ['pending', 'approved', 'rejected'],
    'adm.refund.': ['pending', 'succeeded', 'failed'],
    'adm.priority.': ['low', 'normal', 'high', 'urgent'],
    'adm.mode.': ['provider_settled', 'manual_transfer'],
    'adm.onb.': ['not_started', 'in_progress', 'completed', 'rejected'],
    'adm.pas.': ['inactive', 'active', 'restricted'],
    'adm.acct.': ['NOT_ONBOARDED', 'ONBOARDING', 'PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'SUSPENDED', 'DISABLED', 'NOT_STARTED', 'PENDING', 'UNDER_REVIEW'],
    'adm.cap.': ['CONFIGURED', 'NOT_CONFIGURED', 'CONFIGURED_NOT_TESTED', 'MISCONFIGURED', 'HEALTHY', 'ERROR', 'NO_EVENTS_YET', 'VERIFIED', 'NOT_VERIFIED', 'IMPLEMENTED_UNVERIFIED', 'ENABLED_UNVERIFIED', 'NOT_SUPPORTED', 'NOT_AVAILABLE', 'AVAILABLE', 'NOT_CONNECTED', 'CLEAN', 'ATTENTION'],
    'adm.severity.': ['critical', 'warning', 'info'],
    'adm.env.': ['sandbox', 'live', 'production', 'development'],
    'adm.srv.': ['payoutSchedule', 'refundRules', 'settlementProvider', 'settlementPlatform', 'dbPostgres', 'dbSqlite'],
    'report.cat.': ['order', 'payment', 'food', 'restaurant', 'account', 'other'],
    'report.status.': ['open', 'in_progress', 'resolved', 'closed'],
    'sub.status.': ['trialing', 'active', 'past_due', 'cancelled', 'expired', 'suspended'],
    'sub.interval.': ['month', 'year'],
    'sub.inv.': ['open', 'paid', 'void', 'failed'],
    'fin.settle.': ['AWAITING_ACCOUNT_VERIFICATION', 'AWAITING_TAP_SETTLEMENT', 'PROCESSING', 'PAID_BY_TAP', 'FAILED', 'UNKNOWN'],
    'fin.type.': ['sale', 'refund', 'cod_commission'],
    'fin.tap.': ['paid', 'failed', 'processing', 'unknown'],
    'pa.status.': ['VERIFIED', 'UNDER_REVIEW', 'PENDING', 'NOT_STARTED', 'REJECTED', 'SUSPENDED', 'DISABLED'],
    'pa.kycValue.': ['unverified', 'pending', 'verified', 'rejected'],
    'payout.status.': ['pending', 'eligible', 'requested', 'processing', 'paid', 'failed', 'cancelled', 'reversed', 'manual_payout'],
    'pstat.': ['initiated', 'pending', 'succeeded', 'failed', 'cancelled', 'cod_pending', 'cash_collected', 'refunded', 'partially_refunded'],
    'prof.day.': ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    'plan.': ['free.name', 'basic.name', 'pro.name', 'business.name'],
    'menu.filter.': ['all', 'available', 'unavailable', 'out', 'low', 'discounted', 'extras', 'missing'],
    'orders.f.': ['active', 'all'],
    'v.': ['required', 'too_short', 'too_long', 'not_integer', 'out_of_range', 'invalid_email', 'password_short', 'password_long', 'password_weak', 'invalid_phone', 'invalid_mobile',
      'invalid_money', 'discount_not_positive', 'discount_not_lower', 'invalid_category', 'options_count', 'select_range', 'too_many', 'invalid_id', 'use_localized', 'conflict', 'items_required', 'invalid_image_url', 'not_text', 'not_boolean', 'invalid'],
    'err.': ['insufficient_stock', 'out_of_stock', 'item_unavailable', 'option_unavailable', 'option_quantity_exceeded', 'invalid_option', 'invalid_item', 'invalid_option_count',
      'below_minimum', 'email_taken', 'invalid_credentials', 'unauthenticated', 'forbidden', 'not_found', 'rate_limited', 'restaurant_closed', 'not_accepting_orders', 'restaurant_unavailable',
      'card_unavailable', 'invalid_extra', 'extra_unavailable', 'extra_quantity_exceeded', 'account_disabled', 'invalid_code', 'try_again', 'unsupported_media', 'payment_provider_error', 'plan_limit_reached', 'feature_not_in_plan', 'internal_error', 'stock_not_tracked', 'duplicate', 'conflict', 'generic', 'network', 'invalid_transition', 'csrf_blocked', 'plan_limit', 'invalid_token'],
    'field.': ['phone', 'fullName', 'email', 'password', 'name', 'nameAr', 'nameEn', 'description', 'descriptionAr', 'descriptionEn', 'city', 'address', 'originalPriceCents',
      'discountedPriceCents', 'priceCents', 'stockQuantity', 'categoryId', 'ownerName', 'ownerPhone', 'customerName', 'customerPhone', 'deliveryAddress', 'maxSelect', 'minSelect',
      'maxQuantity', 'items', 'quantity', 'instructions', 'whatsapp', 'quantity', 'category', 'extras', 'lang', 'subject', 'orderId', 'legalName', 'registrationNumber', 'contactName',
      'contactPhone', 'contactEmail', 'deliveryFee', 'minOrder', 'tax', 'timezone', 'openingHours'],
  };
  for (const [prefix, members] of Object.entries(families)) {
    for (const mem of members) if (!(`${prefix}${mem}` in en)) fail(`missing dictionary entry "${prefix}${mem}"`);
  }

  if (failures) { console.error(`${failures} localization problem(s)`); process.exit(1); }
  console.log(`i18n: ${Object.keys(en).length} keys in both languages; ${used.size} literal keys used are all defined`);
})();
