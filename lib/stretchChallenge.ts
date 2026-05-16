// lib/stretchChallenge.ts
// =============================================================================
// Stretch-challenge mode for students (P3.13).
// -----------------------------------------------------------------------------
// Why
// ---
// A motivated Class 10 student WANTS to try JEE-difficulty practice as
// preparation. Today the system's categorize() function silently snaps
// the difficulty back to "appropriate for grade" — the student literally
// cannot generate harder questions through the UI. That's a real loss:
// stretch practice is a documented driver of mastery, and ZCORIQ
// already invests heavily in the Bloom-mix to scaffold it.
//
// This module is the opt-in: students who toggle "stretch challenge" on
// generate get a category override (e.g. their profile is class_10_boards
// but they generate jee_main-tier questions), with an amber warning so
// they're not surprised by the difficulty spike.
//
// Pairs with the teacher-side difficulty-mismatch warning added today —
// same severity grading, opposite direction (student CHOOSES to escalate;
// teacher gets warned WHEN they escalate by accident).
// =============================================================================

import { categoryBucket, categoryRank, categoryLabel } from "@/lib/questionCategory";

/** How many tiers above the student's profile category is allowed in
 *  stretch mode. 2 = "primary student → competitive" is allowed; "primary
 *  → corporate" still isn't (different cohort entirely). */
const MAX_STRETCH_RANK_GAP = 2;

export type StretchEligibility = {
  /** True when the user is allowed to opt into the requested target. */
  eligible: boolean;
  /** Human-readable explanation (renderable to UI). */
  message: string;
  /** Tier gap from profile to target. */
  rankGap: number;
  /** Pretty labels for the banner. */
  profileLabel: string;
  targetLabel: string;
};

/**
 * Can this student opt-in to stretching from their profile category to
 * a harder target category? Returns ineligible (with reason) for
 * unsupported jumps so the UI can disable the toggle.
 */
export function stretchEligibility(
  profileCategory: string | null | undefined,
  targetCategory: string | null | undefined,
): StretchEligibility {
  const pBucket = categoryBucket(profileCategory ?? null);
  const tBucket = categoryBucket(targetCategory ?? null);
  const profileLabel = categoryLabel(profileCategory ?? null);
  const targetLabel = categoryLabel(targetCategory ?? null);

  // Unknown anywhere → don't gate.
  if (pBucket === "unknown" || tBucket === "unknown") {
    return {
      eligible: true,
      message: "",
      rankGap: 0,
      profileLabel,
      targetLabel,
    };
  }

  const gap = categoryRank(tBucket) - categoryRank(pBucket);
  if (gap <= 0) {
    // Target is at or below profile — no stretch is happening; nothing to opt into.
    return {
      eligible: true,
      message: "",
      rankGap: gap,
      profileLabel,
      targetLabel,
    };
  }
  if (gap > MAX_STRETCH_RANK_GAP) {
    return {
      eligible: false,
      message: `${targetLabel} is too far above ${profileLabel} for stretch practice — try a category one or two tiers up first.`,
      rankGap: gap,
      profileLabel,
      targetLabel,
    };
  }
  return {
    eligible: true,
    message: `Stretch mode: questions will be at ${targetLabel} difficulty (${gap} tier${gap === 1 ? "" : "s"} above your ${profileLabel} profile). Expect harder framing and longer reasoning.`,
    rankGap: gap,
    profileLabel,
    targetLabel,
  };
}

/**
 * Server-side helper: when an /api/generate request arrives with
 * stretch_challenge=true and a target_category that differs from the
 * profile's exam_goal, decide whether to honour the override. Returns
 * { category, accepted, reason } the route can write to
 * generation_meta.stretch_challenge_acknowledged for provenance.
 *
 * Default behaviour when the toggle isn't set: respect the profile
 * exam_goal. The toggle is the EXPLICIT consent path; routes never
 * silently escalate.
 */
export function resolveStretchCategory(opts: {
  profileCategory: string | null;
  requestedTarget: string | null;
  stretchOptIn: boolean;
}): {
  category: string | null;
  accepted: boolean;
  reason: string;
} {
  if (!opts.stretchOptIn) {
    return {
      category: opts.profileCategory,
      accepted: false,
      reason: "stretch_not_opted_in",
    };
  }
  if (!opts.requestedTarget) {
    return {
      category: opts.profileCategory,
      accepted: false,
      reason: "no_target",
    };
  }
  const eligible = stretchEligibility(opts.profileCategory, opts.requestedTarget);
  if (!eligible.eligible) {
    return {
      category: opts.profileCategory,
      accepted: false,
      reason: "gap_exceeds_max",
    };
  }
  return {
    category: opts.requestedTarget,
    accepted: true,
    reason: "ok",
  };
}
