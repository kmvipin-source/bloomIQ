// lib/planLegacy.ts
// =============================================================================
// F151 fix (QA phase-7): the LEGACY_SLUG_MAP used to live duplicated in
// app/api/checkout/route.ts and app/api/checkout/verify/route.ts. Two
// copies meant adding a new legacy slug in one and forgetting the other
// would silently break either order creation or verification — extremely
// hard to debug. One source of truth.
//
// Legacy slugs come from the pre-plan-admin era when /pricing hardcoded
// `individual_monthly` / `individual_yearly` plan IDs. After the plan
// admin module shipped (post-migration-30), slugs became
// `premium_monthly` / `premium_annual`. Old browser sessions / cached
// PWA shells may still POST the legacy names.
//
// Adding a new mapping: add a row here, both /api/checkout and
// /api/checkout/verify pick it up automatically.
// =============================================================================

export const LEGACY_SLUG_MAP: Record<string, string> = {
  individual_monthly: "premium_monthly",
  individual_yearly: "premium_annual",
};

/** Returns the canonical slug, mapping legacy names through. */
export function normalizePlanSlug(raw: string): string {
  if (!raw) return "";
  return LEGACY_SLUG_MAP[raw] ?? raw;
}
