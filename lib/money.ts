/**
 * lib/money.ts
 *
 * Single source of truth for rendering INR amounts. Used by /admin/plans,
 * /admin/plans/queue, /pricing, and any other surface that displays
 * paise-denominated values to users.
 *
 * Why centralise:
 *   - Floating-point dependence drift: `(paise/100).toFixed(2)` silently
 *     loses precision on edge cases (e.g. 99999999 paise → 999999.99).
 *     Intl.NumberFormat with `style: "currency"` formats the rupee
 *     amount via integer-aware locale rules.
 *   - Locale grouping: en-IN groups as "1,00,000" not "100,000".
 *     toFixed/toLocaleString-on-divide are inconsistent across pages;
 *     this helper makes the choice once.
 *   - Currency symbol: Intl gives `₹` automatically; no string concat
 *     drift between "₹100" and "Rs. 100".
 */

const INR_FORMATTER = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const INR_FORMATTER_INTEGER = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Format paise as a localised INR string with ₹ symbol.
 * Renders the paise portion only when non-zero.
 */
export function formatPaise(paise: number | null | undefined): string {
  if (paise == null || !Number.isFinite(paise)) return "₹—";
  const rupees = paise / 100;
  // Integer formatter when the value is whole rupees so we don't show
  // "₹999.00" everywhere.
  if (paise % 100 === 0) return INR_FORMATTER_INTEGER.format(rupees);
  return INR_FORMATTER.format(rupees);
}

/**
 * Format an already-rupees-denominated number (e.g. price_rupees in
 * admin queues). Same Intl machinery, just no /100 step.
 */
export function formatRupees(rupees: number | null | undefined): string {
  if (rupees == null || !Number.isFinite(rupees)) return "₹—";
  if (Number.isInteger(rupees)) return INR_FORMATTER_INTEGER.format(rupees);
  return INR_FORMATTER.format(rupees);
}
