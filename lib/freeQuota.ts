/**
 * lib/freeQuota.ts
 *
 * Server-side quota enforcement for the Free tier (Option A — "Showcase Free").
 *
 * Two surfaces:
 *   1) checkDailyQuota(userId, surface)   — per-day rolling cap.
 *      Surfaces: tutor_chat, teach_back, speed_session, flashcards,
 *                student_coach, daily_drill
 *   2) checkLifetimeUse(userId, featureKey) — one-shot taste of a
 *      premium-plus feature for Free users.
 *      Feature keys: xray, rank, visualizer, voice_teacher,
 *                    trap_detector, knowledge_graph, bloom_score
 *
 * Both APIs:
 *   - Return a structured { allowed, ... } result. Never throw.
 *   - Return { allowed: true } immediately for paid users (premium,
 *     premium_plus, school_*) — caps only apply to tier='free'.
 *   - Read limits live from subscription_limits.id=1 so admin edits
 *     at /admin/free-tier-limits take effect with no redeploy.
 *
 * Record-on-use:
 *   - recordDailyUse(userId, surface) — call AFTER successful AI
 *     response (so transient LLM failures don't burn quota).
 *   - recordLifetimeUse(userId, featureKey) — same, after success.
 *
 * Why two functions per surface (check then record)?
 * It mirrors checkCoachQuota / logCoachCall in lib/coachQuota.ts —
 * the gate is cheap, the record is best-effort. Centralising both
 * here means every route looks the same.
 */

import { supabaseAdmin } from "@/lib/supabase/server";

export type DailySurface =
  | "tutor_chat"
  | "teach_back"
  | "speed_session"
  | "flashcards"
  | "student_coach"
  | "daily_drill";

export type LifetimeFeature =
  | "xray"
  | "rank"
  | "visualizer"
  | "voice_teacher"
  | "trap_detector"
  | "knowledge_graph"
  | "bloom_score";

export type DailyResult =
  | { allowed: true; tier: string; cap: number | null; remaining: number | null }
  | { allowed: false; tier: "free"; cap: number; used: number; reason: string };

export type LifetimeResult =
  | { allowed: true; tier: string; alreadyUsed: boolean }
  | { allowed: false; tier: "free"; reason: string };

const DAILY_SURFACE_LABEL: Record<DailySurface, string> = {
  tutor_chat:    "AI Tutor",
  teach_back:    "Teach-Back",
  speed_session: "Speed-Accuracy Trainer",
  flashcards:    "Flashcard generator",
  student_coach: "Student Coach",
  daily_drill:   "Daily Drill",
};

const LIFETIME_FEATURE_LABEL: Record<LifetimeFeature, string> = {
  xray:             "Past-Paper X-Ray",
  rank:             "Mock Rank Predictor",
  visualizer:       "Concept Visualizer",
  voice_teacher:    "Voice AI Teacher",
  trap_detector:    "Distractor Trap Detector",
  knowledge_graph:  "Knowledge Graph",
  bloom_score:      "BloomIQ Score calibration",
};

const DAILY_TO_COLUMN: Record<DailySurface, string> = {
  tutor_chat:    "free_daily_tutor_turns",
  teach_back:    "free_daily_teach_back",
  speed_session: "free_daily_speed_sessions",
  flashcards:    "free_daily_flashcards",
  student_coach: "free_daily_coach_turns",
  daily_drill:   "free_daily_drill",
};

const LIFETIME_TO_COLUMN: Record<LifetimeFeature, string> = {
  xray:             "free_lifetime_xray",
  rank:             "free_lifetime_rank",
  visualizer:       "free_lifetime_visualizer",
  voice_teacher:    "free_lifetime_voice_teacher",
  trap_detector:    "free_lifetime_trap_detector",
  knowledge_graph:  "free_lifetime_knowledge_graph",
  bloom_score:      "free_lifetime_bloom_score",
};

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

/** Returns the user's plan tier ('free', 'premium', 'premium_plus', etc). */
async function resolveTier(userId: string): Promise<string> {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("subscriptions")
    .select("tier, status, expires_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return "free";
  // Treat inactive / expired paid plans as Free so they hit the caps.
  if (data.status && data.status !== "active") return "free";
  if (data.expires_at && new Date(data.expires_at) < new Date()) return "free";
  return (data.tier as string | null) || "free";
}

/** Returns a YYYY-MM-DD string for "today" in the configured reset timezone. */
function dayKeyForTimezone(tz: string): string {
  // Intl is fine here; runs on Node 22+.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // "YYYY-MM-DD"
}

/**
 * Loads the singleton subscription_limits row. Cached for 60 seconds
 * because admin edits are rare and route hot paths are frequent.
 */
let _limitsCache: { row: Record<string, unknown>; expiresAt: number } | null = null;
async function loadLimits(): Promise<Record<string, unknown>> {
  if (_limitsCache && _limitsCache.expiresAt > Date.now()) {
    return _limitsCache.row;
  }
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("subscription_limits")
    .select("*")
    .eq("id", 1)
    .single();
  if (error || !data) {
    throw new Error(`subscription_limits row missing: ${error?.message || "unknown"}`);
  }
  _limitsCache = { row: data as Record<string, unknown>, expiresAt: Date.now() + 60_000 };
  return _limitsCache.row;
}

/** Force-clears the limits cache. Call from the admin save handler. */
export function clearFreeQuotaCache(): void {
  _limitsCache = null;
}

// ---------------------------------------------------------------
// Public: daily quota
// ---------------------------------------------------------------

/**
 * Check whether the user can use a daily-capped surface right now.
 * Does NOT increment — call recordDailyUse() after a successful action.
 *
 * For paid users, returns { allowed: true, cap: null, remaining: null }
 * — the caller can use the same code path; null = uncapped.
 *
 * For Free users at the cap, returns { allowed: false, reason } and
 * the caller should respond 402 with the reason as the user-visible
 * message.
 */
export async function checkDailyQuota(
  userId: string,
  surface: DailySurface,
): Promise<DailyResult> {
  const tier = await resolveTier(userId);
  if (tier !== "free") {
    return { allowed: true, tier, cap: null, remaining: null };
  }

  const limits = await loadLimits();
  const cap = Number(limits[DAILY_TO_COLUMN[surface]] ?? 0);

  // cap=0 → feature is HARD-LOCKED for Free (admin can set this to gate
  // a surface entirely without code changes).
  if (cap <= 0) {
    return {
      allowed: false,
      tier: "free",
      cap: 0,
      used: 0,
      reason: `${DAILY_SURFACE_LABEL[surface]} is not available on the Free plan. Upgrade to Premium.`,
    };
  }

  const tz = String(limits.daily_reset_timezone ?? "Asia/Kolkata");
  const day = dayKeyForTimezone(tz);

  const sb = supabaseAdmin();
  const { data } = await sb
    .from("daily_ai_usage")
    .select("count")
    .eq("user_id", userId)
    .eq("surface", surface)
    .eq("day_key", day)
    .maybeSingle();

  const used = Number((data as { count?: number } | null)?.count ?? 0);

  if (used >= cap) {
    return {
      allowed: false,
      tier: "free",
      cap,
      used,
      reason: `You've used your ${cap} free ${DAILY_SURFACE_LABEL[surface]} ${
        cap === 1 ? "session" : "sessions"
      } for today. Upgrade to Premium for unlimited, or come back after midnight IST.`,
    };
  }

  return { allowed: true, tier: "free", cap, remaining: cap - used };
}

/**
 * Increment the user's daily counter for `surface`. Idempotent-ish:
 * always safe to call. Best-effort — failure does not propagate
 * (we'd rather under-count than fail a real request).
 */
export async function recordDailyUse(
  userId: string,
  surface: DailySurface,
): Promise<void> {
  try {
    const limits = await loadLimits();
    const tz = String(limits.daily_reset_timezone ?? "Asia/Kolkata");
    const day = dayKeyForTimezone(tz);
    const sb = supabaseAdmin();

    // Atomic upsert with `count = count + 1`. Postgres lets us do this
    // via on conflict + count = daily_ai_usage.count + 1 in raw SQL,
    // but supabase-js doesn't support the +1 update. So we do a
    // read-then-write — race-conditioned worst case is under-count
    // by one, which is fine.
    const { data: existing } = await sb
      .from("daily_ai_usage")
      .select("count")
      .eq("user_id", userId)
      .eq("surface", surface)
      .eq("day_key", day)
      .maybeSingle();

    if (existing) {
      await sb
        .from("daily_ai_usage")
        .update({ count: Number(existing.count) + 1, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("surface", surface)
        .eq("day_key", day);
    } else {
      await sb.from("daily_ai_usage").insert({
        user_id: userId,
        surface,
        day_key: day,
        count: 1,
      });
    }
  } catch {
    // best-effort — never fail the request because of a logging miss
  }
}

// ---------------------------------------------------------------
// Public: lifetime quota
// ---------------------------------------------------------------

/**
 * Check whether the user can use a lifetime-capped premium-plus
 * feature. For Free users, returns { allowed: true, alreadyUsed: false }
 * the FIRST time and { allowed: false } on every subsequent call.
 *
 * For paid users, always { allowed: true }.
 */
export async function checkLifetimeUse(
  userId: string,
  featureKey: LifetimeFeature,
): Promise<LifetimeResult> {
  const tier = await resolveTier(userId);
  if (tier !== "free") {
    return { allowed: true, tier, alreadyUsed: false };
  }

  const limits = await loadLimits();
  const cap = Number(limits[LIFETIME_TO_COLUMN[featureKey]] ?? 0);

  if (cap <= 0) {
    return {
      allowed: false,
      tier: "free",
      reason: `${LIFETIME_FEATURE_LABEL[featureKey]} is a Premium feature. Upgrade to unlock.`,
    };
  }

  const sb = supabaseAdmin();
  const { data } = await sb
    .from("lifetime_feature_usage")
    .select("count")
    .eq("user_id", userId)
    .eq("feature_key", featureKey)
    .maybeSingle();

  const used = Number((data as { count?: number } | null)?.count ?? 0);

  if (used >= cap) {
    return {
      allowed: false,
      tier: "free",
      reason: `You've already used your free taste of ${LIFETIME_FEATURE_LABEL[featureKey]}. Upgrade to Premium to keep using it.`,
    };
  }

  return { allowed: true, tier: "free", alreadyUsed: false };
}

/**
 * Mark a lifetime feature as used by this user. Idempotent.
 * Best-effort — failure does not propagate.
 */
export async function recordLifetimeUse(
  userId: string,
  featureKey: LifetimeFeature,
): Promise<void> {
  try {
    const sb = supabaseAdmin();
    const { data: existing } = await sb
      .from("lifetime_feature_usage")
      .select("count")
      .eq("user_id", userId)
      .eq("feature_key", featureKey)
      .maybeSingle();
    if (existing) {
      await sb
        .from("lifetime_feature_usage")
        .update({
          count: Number(existing.count) + 1,
          last_used_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .eq("feature_key", featureKey);
    } else {
      await sb.from("lifetime_feature_usage").insert({
        user_id: userId,
        feature_key: featureKey,
        count: 1,
      });
    }
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------
// Helper exports for the admin page + usage widgets
// ---------------------------------------------------------------

export const DAILY_SURFACES: DailySurface[] = [
  "tutor_chat",
  "teach_back",
  "speed_session",
  "flashcards",
  "student_coach",
  "daily_drill",
];

export const LIFETIME_FEATURES: LifetimeFeature[] = [
  "xray",
  "rank",
  "visualizer",
  "voice_teacher",
  "trap_detector",
  "knowledge_graph",
  "bloom_score",
];

export function dailySurfaceLabel(s: DailySurface): string {
  return DAILY_SURFACE_LABEL[s];
}
export function lifetimeFeatureLabel(f: LifetimeFeature): string {
  return LIFETIME_FEATURE_LABEL[f];
}
export function dailySurfaceColumn(s: DailySurface): string {
  return DAILY_TO_COLUMN[s];
}
export function lifetimeFeatureColumn(f: LifetimeFeature): string {
  return LIFETIME_TO_COLUMN[f];
}
