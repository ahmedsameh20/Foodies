// Localization: Arabic (RTL) and English (LTR). No build step, no dependency - the dictionaries are plain modules.
//
//   t('cart.title')                         translated text; falls back to English, then to the key itself
//   t('stock.onlyLeft', { n: 3 })             "{n}" placeholders are interpolated
//   loc(dish, 'name')                       dish.nameAr / dish.nameEn by current language, falling back to the other language and finally to dish.name
//   data-i18n="key" (text) / data-i18n-placeholder / data-i18n-aria-label   for static HTML, applied on load
//
// The language is the visitor's choice (header switcher or ?lang=ar), remembered in localStorage and shared by every page, so it stays
// the same through browsing, cart, checkout and order tracking. Default: the browser language when it is Arabic, otherwise English.
import en from './locale-en.js';
import ar from './locale-ar.js';

const LANG_KEY = 'foodies.lang';
const DICTS = { en, ar };

// Pages that are English-only (the platform admin panel) declare <html data-lang="en">: they ignore the visitor's choice.
const forced = document.documentElement.dataset.lang;
export const langLocked = forced === 'en' || forced === 'ar';

function detect() {
  if (langLocked) return forced;
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'ar' || q === 'en') { localStorage.setItem(LANG_KEY, q); return q; }
  } catch { /* storage or URL unavailable */ }
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'ar' || saved === 'en') return saved;
  } catch { /* storage blocked */ }
  return /^ar\b/i.test(navigator.language || '') ? 'ar' : 'en';
}

export const lang = detect();
export const isRtl = lang === 'ar';
export const locale = isRtl ? 'ar-EG-u-nu-latn' : 'en'; // Latin digits in both languages; Gregorian calendar

document.documentElement.lang = lang;
document.documentElement.dir = isRtl ? 'rtl' : 'ltr';

// A person who is signed in keeps their language across devices: it is saved on the account (PATCH /api/auth/me { lang }) and adopted at
// the next sign-in (adoptLang). The local choice still works for visitors and when the request fails.
const USER_KEY = 'foodies.user';
export function adoptLang(next) {
  if (langLocked || (next !== 'ar' && next !== 'en')) return;
  try { localStorage.setItem(LANG_KEY, next); } catch { /* storage blocked */ }
}

export async function setLang(next) {
  try { localStorage.setItem(LANG_KEY, next); } catch { /* storage blocked */ }
  try {
    const u = JSON.parse(localStorage.getItem(USER_KEY));
    if (u) {
      localStorage.setItem(USER_KEY, JSON.stringify({ ...u, lang: next }));
      const save = fetch('/api/auth/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ lang: next }), keepalive: true }).catch(() => {});
      await Promise.race([save, new Promise((r) => setTimeout(r, 1500))]); // never hold the switch back for long
    }
  } catch { /* not signed in, or storage blocked */ }
  const url = new URL(location.href);
  url.searchParams.delete('lang');
  location.href = url.toString(); // reload: every screen re-renders in the new language and direction (cart, filters and drafts are kept in storage)
}

// True while the stored text is still the unedited English default (used to show the Arabic text of the platform's default plans).
export const isDefaultText = (key, value) => Object.hasOwn(en, key) && en[key] === value;

export const has = (key) => Object.hasOwn(DICTS[lang], key) || Object.hasOwn(en, key);

export function t(key, vars) {
  let s = Object.hasOwn(DICTS[lang], key) ? DICTS[lang][key] : (Object.hasOwn(en, key) ? en[key] : key);
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
  return s;
}

// Text of a bilingual entity: `base` is 'name' | 'description'. Uses the text the owner wrote in the visitor's language; when that is
// missing, the other language's text, then the legacy single-language text. Never returns undefined, never machine-translates.
export function loc(obj, base = 'name') {
  if (!obj) return '';
  const cap = base[0].toUpperCase() + base.slice(1);
  const mine = obj[base + (isRtl ? 'Ar' : 'En')];
  const other = obj[base + (isRtl ? 'En' : 'Ar')];
  return mine || obj[base] || other || '';
}

// For order snapshots / API errors that carry { name, nameAr, nameEn } under a different prefix (e.g. group, option).
export function locKeys(obj, ar, en, legacy) {
  return (isRtl ? obj?.[ar] : obj?.[en]) || obj?.[legacy] || (isRtl ? obj?.[en] : obj?.[ar]) || '';
}

export function applyStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder)); });
  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel)); });
}
applyStatic();
