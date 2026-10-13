// The customer-side price formula, as pure functions (no DOM). The server recomputes every figure from its own data when an order is
// placed (server/services/orders.js priceCart); these are for showing the customer a running total, and tests/frontend.test.js checks
// that both sides agree.
//
//   one dish   = selling price (the discounted price while a discount is active, else the original) + sum(extra price x extra quantity)
//   line total = one dish x dish quantity
// product: { priceCents, optionGroups: [{ options: [{ id, priceCents }] }] }    selected: [{ id, qty }]

export function extrasCents(product, selected) {
  const byId = new Map(product.optionGroups.flatMap((g) => g.options).map((o) => [o.id, o]));
  return selected.reduce((sum, s) => sum + (byId.get(s.id)?.priceCents || 0) * s.qty, 0);
}
export const unitCents = (product, selected) => product.priceCents + extrasCents(product, selected);
export const lineCents = (product, selected, quantity) => unitCents(product, selected) * quantity;
// a general extra is its own order line: its price x its quantity (no dish, no options)
export const extraLineCents = (extra, quantity) => extra.priceCents * quantity;

// whole-number percentage saved, rounded half up in integer maths; 0 when there is no discount
export function discountPercent(originalCents, priceCents) {
  if (!(originalCents > priceCents) || originalCents <= 0) return 0;
  return Math.floor(((originalCents - priceCents) * 100 * 2 + originalCents) / (originalCents * 2));
}
