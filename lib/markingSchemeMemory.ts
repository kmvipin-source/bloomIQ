/**
 * lib/markingSchemeMemory.ts
 *
 * Sticky per-user marking-scheme preference. Read once, write on every
 * test creation. Every test surface — Speed Trainer, Sprint, Drill,
 * Adaptive Practice, Generate, Teacher quiz builder — pre-fills its
 * <MarkingSchemePicker /> with the value returned by readLastMarkingScheme
 * and persists the user's pick back via writeLastMarkingScheme.
 *
 * Storage:
 *   profiles.last_marking_scheme JSONB NULL  (see migration 77)
 *
 * Fallback chain when nothing has been stored yet:
 *   readLastMarkingScheme(userId)
 *     → profile.last_marking_scheme (if not null)
 *     → suggestPresetForGoal(profile.exam_goal) resolved to a full scheme
 *     → LEGACY_DEFAULT_SCHEME (PRACTICE +1/0)
 *
 * That fallback lives in resolveStickyScheme below so every API can call
 * one helper and get a fully-populated MarkingScheme, never null.
 *
 * Why server-side (not localStorage):
 *   - Pilot students sometimes hop laptop ↔ phone; localStorage would
 *     forget their pick on each device.
 *   - Single source of truth keeps the marking-scheme value and the
 *     exam_goal aligned on the same row.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type MarkingScheme,
  resolveScheme,
  LEGACY_DEFAULT_SCHEME,
} from "./scoring";
import {
  SCORING_PRESETS,
  suggestPresetForGoal,
  type ScoringPresetKey,
} from "./scoringPresets";

// ─── Internal: convert a preset key to a full MarkingScheme ─────────────

/**
 * Build a MarkingScheme from a preset key. Used for the second tier of
 * the fallback chain (exam_goal → preset → scheme).
 */
function schemeFromPreset(preset: ScoringPresetKey): MarkingScheme {
  const cfg = SCORING_PRESETS[preset];
  if (!cfg) return LEGACY_DEFAULT_SCHEME;
  return {
    preset,
    negative_marks_enabled: cfg.negative_default,
    rules: { default: { ...cfg.rule } },
  };
}

// ─── Read ───────────────────────────────────────────────────────────────

/**
 * Return the user's last-used marking scheme, OR a goal-suggested default
 * if they've never picked, OR the legacy +1/0/0 default if nothing else
 * applies. Never returns null — callers can use the result directly.
 *
 * @param sb     Service-role Supabase client (admin) — required so RLS
 *               doesn't block reading the profile column.
 * @param userId Caller auth user id.
 */
export async function resolveStickyScheme(
  sb: SupabaseClient,
  userId: string,
): Promise<MarkingScheme> {
  try {
    const { data } = await sb
      .from("profiles")
      .select("last_marking_scheme, exam_goal")
      .eq("id", userId)
      .maybeSingle();
    const row = data as { last_marking_scheme?: unknown; exam_goal?: string | null } | null;
    // (1) Honour the user's most recent explicit pick if present.
    if (row?.last_marking_scheme != null) {
      return resolveScheme(row.last_marking_scheme);
    }
    // (2) Otherwise suggest based on exam_goal.
    const preset = suggestPresetForGoal(row?.exam_goal ?? null);
    if (preset && SCORING_PRESETS[preset]) {
      return schemeFromPreset(preset);
    }
  } catch {
    // Fall through to legacy default on any error — never block the
    // request just because we couldn't read the preference.
  }
  // (3) Legacy default if everything else missed.
  return LEGACY_DEFAULT_SCHEME;
}

/**
 * Lower-level read — returns the raw scheme or null. Most callers want
 * resolveStickyScheme instead; this is here for diagnostic / settings
 * surfaces that need to distinguish "user has explicitly picked" from
 * "we're showing the goal-suggested default."
 */
export async function readLastMarkingScheme(
  sb: SupabaseClient,
  userId: string,
): Promise<MarkingScheme | null> {
  try {
    const { data } = await sb
      .from("profiles")
      .select("last_marking_scheme")
      .eq("id", userId)
      .maybeSingle();
    const raw = (data as { last_marking_scheme?: unknown } | null)?.last_marking_scheme;
    if (raw == null) return null;
    return resolveScheme(raw);
  } catch {
    return null;
  }
}

// ─── Write ──────────────────────────────────────────────────────────────

/**
 * Persist the user's chosen scheme as their new last-used. Called by every
 * test-creation endpoint AFTER the test row is successfully inserted —
 * never on a failed insert (avoids polluting the preference with a scheme
 * the user never actually committed to).
 *
 * Best-effort: if the write fails (RLS race, column not yet migrated on
 * the live DB), we swallow the error rather than fail the user's test
 * creation. The next successful submit will retry.
 *
 * Pass `null` to clear the preference (e.g., a future "reset to default"
 * affordance in settings).
 */
export async function writeLastMarkingScheme(
  sb: SupabaseClient,
  userId: string,
  scheme: MarkingScheme | null,
): Promise<void> {
  try {
    await sb
      .from("profiles")
      .update({ last_marking_scheme: scheme })
      .eq("id", userId);
  } catch {
    // Silent — see docstring. Surface via PostHog if we ever wire it.
  }
}
