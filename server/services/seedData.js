const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { tx } = require('../db');
const { mulDiv } = require('./money');

// Feature tiers assigned to restaurants by the platform admin. Marketplace revenue is commission; tiers only
// gate product features (menu size, staff, branches, analytics).
const PLANS = [
  { code: 'free', name: 'Free', description: 'Try the platform with a small menu.', price: 0, interval: 'month', trial: 0, items: 10, branches: 1, staff: 1, orders: 100, analytics: 0, advanced: 0, sort: 1,
    features: ['Up to 10 menu items', '100 orders per month', '1 staff account', 'Cash and card orders'] },
  { code: 'basic', name: 'Starter', description: 'For restaurants getting started with online ordering.', price: 2900, interval: 'month', trial: 14, items: 100, branches: 3, staff: 3, orders: 1000, analytics: 1, advanced: 0, sort: 2,
    features: ['Up to 100 menu items', '1,000 orders per month', '3 staff accounts', 'Sales analytics'] },
  { code: 'pro', name: 'Pro', description: 'Growing restaurants that want reporting and more staff.', price: 7900, interval: 'month', trial: 14, items: 1000, branches: 10, staff: 10, orders: 10000, analytics: 1, advanced: 1, sort: 3,
    features: ['Up to 1,000 menu items', '10,000 orders per month', '10 staff accounts', 'Advanced reports and CSV export'] },
  { code: 'business', name: 'Business', description: 'Unlimited menu and staff for large operations.', price: 14900, interval: 'month', trial: 14, items: null, branches: 50, staff: null, orders: null, analytics: 1, advanced: 1, sort: 4,
    features: ['Unlimited menu items', 'Unlimited orders', 'Unlimited staff', 'Advanced reports and CSV export'] },
];

// INSERT OR IGNORE: never overwrites plans (names, prices, limits) a platform admin has edited. The prices above are
// starting points for a NEW platform; set your real prices in Admin -> Plans before launch.
function ensurePlans(db) {
  const st = db.prepare(
    `INSERT OR IGNORE INTO plans (code, name, description, price_cents, currency, billing_interval, trial_days, max_menu_items, max_branches,
       max_staff, max_orders_per_month, analytics, advanced_reports, features, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const p of PLANS) {
    st.run(p.code, p.name, p.description, p.price, config.currency, p.interval, p.trial, p.items, p.branches, p.staff, p.orders, p.analytics, p.advanced, JSON.stringify(p.features), p.sort);
  }
}

// Creates (or leaves alone) the first platform administrator. The password is supplied by the operator.
function createAdmin(db, { email, name, password }) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return { id: existing.id, created: false };
  const info = db.prepare("INSERT INTO users (email, password_hash, name, role, email_verified_at) VALUES (?,?,?,'super_admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
    .run(email, bcrypt.hashSync(password, config.bcryptRounds), name);
  return { id: Number(info.lastInsertRowid), created: true };
}

// ---- Sample catalogue for LOCAL DEVELOPMENT ONLY -------------------------------------------------------
// The original static site hard-coded each restaurant's menu in HTML. These pages are parsed into sample
// restaurants so developers have realistic content. Never run in production (see seed.js).
const SAMPLE = [
  { file: 'dominos.html', slug: 'sample-dominos', name: "Domino's (sample)", logo: 'dominos.jpg', blurb: 'Sample pizza menu.' },
  { file: 'paradise.html', slug: 'sample-paradise', name: 'Paradise (sample)', logo: 'paradise.jpg', blurb: 'Sample biryani menu.' },
  { file: 'Barbeque.html', slug: 'sample-barbeque', name: 'Barbeque (sample)', logo: 'barbeque.jpg', blurb: 'Sample grill menu.' },
  { file: 'ksbakers.html', slug: 'sample-ks-bakers', name: 'KS Bakers (sample)', logo: 'ksbakers.png', blurb: 'Sample bakery menu.' },
];

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();

function parseLegacyMenu(html) {
  const events = [];
  for (const m of html.matchAll(/<h4>([^<]+)<\/h4>/g)) {
    const t = decode(m[1]);
    if (t) events.push({ at: m.index, type: 'cat', name: t });
  }
  const box = /<img src="([^"]+)"[^>]*>\s*<h3>([^<]+)<\/h3>[\s\S]*?<span>([^<]+)<\/span>/g;
  for (const m of html.matchAll(box)) {
    if (!m[1].includes('/Images/Dishes/')) continue;
    const units = Number((m[3].match(/\d+(?:\.\d+)?/) || [])[0]);
    if (!units) continue;
    events.push({
      at: m.index, type: 'item', name: decode(m[2]),
      // legacy prices were INR/EGP whole units: scaled to roughly equivalent USD cents (x1.2) for sample data
      priceCents: mulDiv(Math.round(units), 12, 10),
      image: encodeURI(m[1].replace(/^\.\//, '/')),
    });
  }
  events.sort((a, b) => a.at - b.at);
  let cat = 'Menu';
  const items = [];
  const seen = new Set();
  for (const e of events) {
    if (e.type === 'cat') cat = e.name;
    else if (!seen.has(`${cat}|${e.name}`)) { seen.add(`${cat}|${e.name}`); items.push({ ...e, category: cat }); }
  }
  return items;
}

function importSampleRestaurant(db, def, legacyDir) {
  if (db.prepare('SELECT 1 FROM restaurants WHERE slug = ?').get(def.slug)) return null;
  const html = fs.readFileSync(path.join(legacyDir, def.file), 'utf8');
  const items = parseLegacyMenu(html);
  return tx(db, () => {
    const rid = Number(db.prepare(
      `INSERT INTO restaurants (slug, name, description, logo_url, city, address, currency, delivery_fee_cents, is_demo, approval_status)
       VALUES (?,?,?,?,?,?,?,?,1,'approved')`)
      .run(def.slug, def.name, `${def.blurb} Sample data for development.`, `/Images/Restaurants/${def.logo}`, 'Riyadh', 'Sample address', config.currency, 300).lastInsertRowid);
    const plan = db.prepare('SELECT id FROM plans WHERE code = ?').get('pro');
    db.prepare("INSERT INTO subscriptions (restaurant_id, plan_id, status, provider) VALUES (?,?,'active','platform')").run(rid, plan.id);
    db.prepare('INSERT INTO restaurant_payment_accounts (restaurant_id, payment_provider) VALUES (?,?)').run(rid, config.paymentProvider);
    const cats = new Map();
    const insCat = db.prepare('INSERT INTO categories (restaurant_id, name, sort_order) VALUES (?,?,?)');
    const insProd = db.prepare('INSERT INTO products (restaurant_id, category_id, name, price_cents, image_url) VALUES (?,?,?,?,?)');
    for (const it of items) {
      if (!cats.has(it.category)) cats.set(it.category, Number(insCat.run(rid, it.category, cats.size).lastInsertRowid));
      // The legacy HTML references a few images that were never committed; fall back to the UI placeholder.
      const imageOk = fs.existsSync(path.join(config.ROOT, decodeURI(it.image)));
      insProd.run(rid, cats.get(it.category), it.name, it.priceCents, imageOk ? it.image : null);
    }
    return { id: rid, items: items.length };
  });
}

// Imports sample restaurants and (optionally) one owner + one customer with a RANDOM password that is
// returned to the caller to print once. No fixed credentials exist anywhere in the repository.
function seedSample(db, { log = () => {}, createUsers = true } = {}) {
  if (config.isProd) throw new Error('Sample data must never be loaded in production');
  ensurePlans(db);
  const legacyDir = path.join(config.ROOT, 'legacy');
  const created = [];
  for (const def of SAMPLE) {
    if (!fs.existsSync(path.join(legacyDir, def.file))) continue;
    const r = importSampleRestaurant(db, def, legacyDir);
    if (r) { created.push(def.slug); log(`  imported ${def.name} (${r.items} menu items)`); }
  }
  let credentials = null;
  if (createUsers && !db.prepare("SELECT 1 FROM users WHERE email = 'owner@sample.test'").get()) {
    const password = `${crypto.randomBytes(9).toString('base64url')}a1`;
    const hash = bcrypt.hashSync(password, config.bcryptRounds);
    const rid = db.prepare("SELECT id FROM restaurants WHERE slug = 'sample-dominos'").get()?.id || null;
    const ins = db.prepare("INSERT INTO users (email, password_hash, name, role, restaurant_id, email_verified_at) VALUES (?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
    const ownerId = Number(ins.run('owner@sample.test', hash, 'Sample Owner', 'owner', rid).lastInsertRowid);
    if (rid) db.prepare('UPDATE restaurants SET owner_id = ? WHERE id = ?').run(ownerId, rid);
    ins.run('customer@sample.test', hash, 'Sample Customer', 'customer', null);
    credentials = { password, accounts: ['owner@sample.test', 'customer@sample.test'] };
  }
  return { created, credentials };
}

// Operator-only recovery (needs shell access to the server): turns 2FA off for an admin who lost both their
// authenticator and backup codes and revokes their sessions. They must enrol again at the next sign-in.
function resetAdminTwoFactor(db, email) {
  const u = db.prepare("SELECT id FROM users WHERE email = ? AND role = 'super_admin'").get(email);
  if (!u) return false;
  tx(db, () => {
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL, token_version = token_version + 1 WHERE id = ?').run(u.id);
    db.prepare('DELETE FROM backup_codes WHERE user_id = ?').run(u.id);
    db.prepare("INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id) VALUES (NULL, 'system', 'admin.2fa_reset_cli', 'user', ?)").run(String(u.id));
  });
  return true;
}

module.exports = { ensurePlans, createAdmin, resetAdminTwoFactor, seedSample, parseLegacyMenu, PLANS };
