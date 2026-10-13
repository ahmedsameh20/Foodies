// The subscription plan an owner picked BEFORE registering. This is only a pointer (the plan code), never a price:
//   * it travels in the URL (?plan=<code>) and is remembered in this browser until the account exists;
//   * registration sends it to the server, which validates it against the plans table and keeps it on the account (users.pending_plan_code);
//   * from then on the server is the source of truth (GET/PUT /api/onboarding/plan), and the price is always read from the plans table.
import { api, money, publicConfig, planName, t } from './common.js';

const KEY = 'foodies.plan';
export const validCode = (c) => /^[a-z0-9_-]{1,30}$/i.test(String(c || ''));

export function chosenPlan() {
  const fromUrl = new URLSearchParams(location.search).get('plan');
  if (validCode(fromUrl)) return fromUrl;
  try { const s = localStorage.getItem(KEY); return validCode(s) ? s : null; } catch { return null; }
}
export function rememberPlan(code) { try { if (validCode(code)) localStorage.setItem(KEY, code); } catch { /* storage blocked */ } }
export function forgetPlan() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

let plansCache;
export const loadPlans = () => { if (!plansCache) plansCache = api('/public/plans').then((r) => r.plans); return plansCache; };

// "Pro — 99.00 SAR / month" in the visitor's language
export async function priceText(plan) {
  const { currency } = await publicConfig();
  return plan.priceCents ? `${money(plan.priceCents, currency)} / ${t(`sub.interval.${plan.billingInterval}`)}` : t('onboarding.free');
}
export async function describePlan(code) {
  if (!validCode(code)) return null;
  let plans;
  try { plans = await loadPlans(); } catch { return null; }
  const plan = plans.find((p) => p.code === code);
  return plan ? { plan, name: planName(plan), price: await priceText(plan) } : null;
}
