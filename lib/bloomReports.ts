// Shared Bloom-taxonomy helpers for the school admin reports surface.
// Extracted from app/school/reports/page.tsx so they can be reused by the
// individual report tab components without duplicating constants.
//
// We keep the order canonical (lowest cognitive demand first) so charts
// always read left-to-right from "Remember" to "Create".
export const BLOOM_LEVELS = [
  "Remember",
  "Understand",
  "Apply",
  "Analyze",
  "Evaluate",
  "Create",
] as const;

export type BloomLevel = (typeof BLOOM_LEVELS)[number];

export const BLOOM_COLORS: Record<BloomLevel, string> = {
  Remember:   "#3b82f6", // blue
  Understand: "#10b981", // emerald
  Apply:      "#f59e0b", // amber
  Analyze:    "#f97316", // orange
  Evaluate:   "#ec4899", // pink
  Create:     "#8b5cf6", // violet
};

/**
 * Coerce a free-form bloom_level string (whatever a teacher or LLM put in
 * the column) into one of our 6 canonical levels, or null if we don't
 * recognise it. Comparison is case-insensitive on the trimmed value.
 */
export function normaliseBloom(raw: string | null | undefined): BloomLevel | null {
  if (!raw) return null;
  const lc = raw.trim().toLowerCase();
  for (const lvl of BLOOM_LEVELS) {
    if (lvl.toLowerCase() === lc) return lvl;
  }
  return null;
}
