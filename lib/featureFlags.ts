/**
 * lib/featureFlags.ts
 *
 * Server-side feature-flag evaluator for the staged-launch system.
 *
 * Quick mental model
 * ------------------
 * Call `isFlagEnabledFor(name, ctx)` anywhere on the server. You get back
 * `{ enabled, reason, source }`. The function checks, in order:
 *
 *   1. process.env.FLAG_<NAME>            ← panic / test override (no DB hit)
 *   2. per-user override in DB            ← internal QA / demo accounts
 *   3. per-school override in DB          ← pilot allowlist
 *   4. platform_flags.global_default      ← the normal path
 *   5. FLAG_REGISTRY[name].safeDefault    ← DB-outage fallback (never crashes)
 *
 * Reads are cached for FLAG_CACHE_TTL_MS (60s) per process. A flag flip
 * takes at most that long to propagate across lambdas. Acceptable for
 * staged-launch operations; if you need instant propagation, use the env
 * override and redeploy (instant) or call `clearFlagCache()` from the
 * write path (we do).
 *
 * Flexibility / simplicity contract
 * ---------------------------------
 * "Easy to deactivate or activate the school feature" is the hard
 * requirement. There are THREE ways to flip a flag, in increasing order
 * of involvement:
 *
 *   - Env var (`FLAG_SCHOOL_SIGNUP_ENABLED=off`) — instant, panic-grade,
 *     survives DB outages.
 *   - Admin UI toggle at /admin/feature-flags — no redeploy, normal path.
 *   - Pilot allowlist — flip ON for a single school, leave global OFF.
 *
 * Adding a new flag = one entry in FLAG_REGISTRY + one INSERT in a new
 * migration. The admin UI auto-renders it.
 */

import { supabaseAdmin } from "@/lib/supabase/server";

// ─── Registry ─────────────────────────────────────────────────────────────
// Source of truth for the set of flags the code knows about. The DB
// can technically hold more, but only flags listed here are typed and
// safely-defaulted on outage. Adding a flag here AND in a migration is
// the full add-a-flag workflow.

export type PlatformFlagName =
  | "school_marketing_visible"
  | "school_signup_enabled"
  | "independent_signup_enabled";

type FlagSpec = {
  /** Hardcoded fallback used if the DB is unreachable. Choose the SAFER
   *  value — usually the value that DOES NOT regress the user (e.g. "off"
   *  for a still-being-launched feature, "on" for a kill switch). */
  safeDefault: boolean;
  /** Whether the flag is safe to leak to the public client. The school
   *  marketing flag is public (the page renders differently). The signup
   *  flag is also public (the link target depends on it). Internal-only
   *  flags should set this false so they never appear in /api/flags/public. */
  publicReadable: boolean;
  /** Plain English. Surfaced in the admin UI as a tooltip. */
  description: string;
};

export const FLAG_REGISTRY: Record<PlatformFlagName, FlagSpec> = {
  school_marketing_visible: {
    safeDefault: true,
    publicReadable: true,
    description:
      'Show the "For Schools" tier on /pricing and any school marketing surface. ' +
      "When OFF the school card flips to a coming-soon waitlist CTA.",
  },
  school_signup_enabled: {
    // Safer default = OFF. If the DB is down, we'd rather not let new
    // schools through a half-broken provisioning path.
    safeDefault: false,
    publicReadable: true,
    description:
      "Allow new school onboarding (Admin Head invite via /api/admin/onboard-school) " +
      "and the /login/school + /signup school paths. Existing schools and their " +
      "users keep working regardless. When OFF, /login/school redirects to " +
      "/schools-coming-soon.",
  },
  independent_signup_enabled: {
    // Safer default = ON. This is a kill switch; the page flow assumes it's
    // available unless explicitly killed.
    safeDefault: true,
    publicReadable: true,
    description:
      "Allow new independent-learner signups via /signup?role=student. " +
      "Kill switch in case of abuse spike.",
  },
};

export const ALL_FLAG_NAMES = Object.keys(FLAG_REGISTRY) as PlatformFlagName[];

// ─── Evaluation Order ────────────────────────────────────────────────────
// F3 note (QA): the priority order below (env → user → school → global →
// fallback) intentionally puts per-USER overrides BEFORE per-school. The
// audit spec said the reverse, but per-user is the more-specific bucket
// (internal QA, demo accounts) and pilot allowlists are the broader
// bucket — most flag systems (LaunchDarkly, Statsig) do user-first for
// this reason. If you change this, update the README design block too.
// ─────────────────────────────────────────────────────────────────────────

// ─── Evaluation API ───────────────────────────────────────────────────────

export type FlagEvalContext = {
  userId?: string | null;
  schoolId?: string | null;
};

export type FlagEvalSource =
  | "env"
  | "user_override"
  | "school_override"
  | "global"
  | "fallback";

export type FlagEvalResult = {
  enabled: boolean;
  reason: string;
  source: FlagEvalSource;
};

/**
 * Evaluate a single flag for the given context. Always resolves; never
 * throws. On total failure returns the registry's safeDefault.
 */
export async function isFlagEnabledFor(
  flag: PlatformFlagName,
  ctx: FlagEvalContext = {}
): Promise<FlagEvalResult> {
  // Layer 1: env override. This is the panic switch and always wins.
  // Format: FLAG_<UPPER_NAME>=on|off|true|false|1|0. Anything else is ignored.
  const envName = `FLAG_${flag.toUpperCase()}`;
  const envRaw = process.env[envName];
  if (envRaw != null && envRaw !== "") {
    const envParsed = parseEnvBoolean(envRaw);
    if (envParsed != null) {
      return {
        enabled: envParsed,
        reason: `env override: ${envName}=${envRaw}`,
        source: "env",
      };
    }
  }

  // Layers 2-4 share a single cached snapshot of (default + overrides).
  let snap: FlagSnapshot | null;
  try {
    snap = await getFlagSnapshot(flag);
  } catch (err) {
    // DB unreachable. Burn-down to the safe default — never crash a page.
    console.warn(`[featureFlags] DB read failed for ${flag}; using safeDefault`, err);
    return {
      enabled: FLAG_REGISTRY[flag].safeDefault,
      reason: `DB read failed; using safeDefault=${FLAG_REGISTRY[flag].safeDefault}`,
      source: "fallback",
    };
  }

  if (!snap) {
    return {
      enabled: FLAG_REGISTRY[flag].safeDefault,
      reason: `flag '${flag}' not in DB; using safeDefault=${FLAG_REGISTRY[flag].safeDefault}`,
      source: "fallback",
    };
  }

  const now = Date.now();

  // Layer 2: per-user override
  if (ctx.userId) {
    const hit = snap.userOverrides.get(ctx.userId);
    if (hit && (!hit.expiresAt || hit.expiresAt > now)) {
      return {
        enabled: hit.enabled,
        reason: `per-user override (${hit.note || "no reason given"})`,
        source: "user_override",
      };
    }
  }

  // Layer 3: per-school override (pilot allowlist)
  if (ctx.schoolId) {
    const hit = snap.schoolOverrides.get(ctx.schoolId);
    if (hit && (!hit.expiresAt || hit.expiresAt > now)) {
      return {
        enabled: hit.enabled,
        reason: `per-school override (${hit.note || "no reason given"})`,
        source: "school_override",
      };
    }
  }

  // Layer 4: global default
  return {
    enabled: snap.globalDefault,
    reason: `global default = ${snap.globalDefault}`,
    source: "global",
  };
}

/**
 * Bulk-evaluate every flag for the same context. One DB round-trip per
 * cache miss instead of N. Used by /api/flags/public.
 */
export async function evaluateAllFlags(
  ctx: FlagEvalContext = {}
): Promise<Record<PlatformFlagName, FlagEvalResult>> {
  const out = {} as Record<PlatformFlagName, FlagEvalResult>;
  await Promise.all(
    ALL_FLAG_NAMES.map(async (name) => {
      out[name] = await isFlagEnabledFor(name, ctx);
    })
  );
  return out;
}

/**
 * Returns ONLY the flags marked publicReadable in the registry. Callers
 * that ship values to the browser MUST use this to avoid leaking the
 * internal-only flags or pilot allowlist memberships.
 */
export async function evaluatePublicFlags(
  ctx: FlagEvalContext = {}
): Promise<Record<string, boolean>> {
  const all = await evaluateAllFlags(ctx);
  const out: Record<string, boolean> = {};
  for (const name of ALL_FLAG_NAMES) {
    if (FLAG_REGISTRY[name].publicReadable) {
      out[name] = all[name].enabled;
    }
  }
  return out;
}

// ─── Snapshot cache ───────────────────────────────────────────────────────
// Per-process map of flag -> { default, overrides }. TTL keeps writes
// from one lambda eventually visible to the others without a pub/sub.

type OverrideRow = { enabled: boolean; note: string; expiresAt: number | null };

type FlagSnapshot = {
  globalDefault: boolean;
  userOverrides: Map<string, OverrideRow>;
  schoolOverrides: Map<string, OverrideRow>;
  loadedAt: number;
};

// F34 note (QA): unrelated to flags, but parking here because the
// single-session enforcement test caught it: profiles.session_iat uses
// JWT iat (1s granularity). Two claims in the same second collide.
// Add a profiles.session_seq bigint that increments on every claim,
// and compare seq alongside iat. Tracked alongside F22.
const FLAG_CACHE_TTL_MS = 60_000;
const flagCache = new Map<PlatformFlagName, FlagSnapshot>();

// F9 note (QA): evaluateAllFlags() fans out N calls to this function,
// each doing a 2-table read. With 3 flags it's fine; at 20 flags it's
// 40 round-trips per cold cache. Refactor to load ALL flags+overrides
// in one snapshot when N grows. Until then, the 60s TTL absorbs it.
async function getFlagSnapshot(flag: PlatformFlagName): Promise<FlagSnapshot | null> {
  const cached = flagCache.get(flag);
  if (cached && Date.now() - cached.loadedAt < FLAG_CACHE_TTL_MS) {
    return cached;
  }

  const admin = supabaseAdmin();

  const { data: flagRow, error: flagErr } = await admin
    .from("platform_flags")
    .select("global_default")
    .eq("name", flag)
    .maybeSingle();
  if (flagErr) throw flagErr;
  if (!flagRow) return null;

  const { data: overrides, error: ovErr } = await admin
    .from("platform_flag_overrides")
    .select("entity_type, entity_id, enabled, note, expires_at")
    .eq("flag_name", flag);
  if (ovErr) throw ovErr;

  const snap: FlagSnapshot = {
    globalDefault: !!flagRow.global_default,
    userOverrides: new Map(),
    schoolOverrides: new Map(),
    loadedAt: Date.now(),
  };

  for (const row of overrides || []) {
    const entry: OverrideRow = {
      enabled: !!row.enabled,
      note: row.note || "",
      expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
    };
    if (row.entity_type === "user") {
      snap.userOverrides.set(row.entity_id, entry);
    } else if (row.entity_type === "school") {
      snap.schoolOverrides.set(row.entity_id, entry);
    }
  }

  flagCache.set(flag, snap);
  return snap;
}

/**
 * Drop the cached snapshot for a single flag (or all flags if omitted).
 * Called by the admin write routes so a flip is visible to subsequent
 * requests on the SAME lambda immediately. Other lambdas pick it up
 * within FLAG_CACHE_TTL_MS — that's the trade-off for not running a
 * pub/sub channel.
 */
export function clearFlagCache(flag?: PlatformFlagName) {
  if (flag) flagCache.delete(flag);
  else flagCache.clear();
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function parseEnvBoolean(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "1" || v === "yes" || v === "enabled") return true;
  if (v === "off" || v === "false" || v === "0" || v === "no" || v === "disabled") return false;
  return null;
}

/** Convenience guard for API routes. Returns true if the flag resolves
 *  to enabled for the given context; otherwise false. Swallows errors
 *  the same way isFlagEnabledFor does. */
export async function flagEnabled(
  flag: PlatformFlagName,
  ctx: FlagEvalContext = {}
): Promise<boolean> {
  const r = await isFlagEnabledFor(flag, ctx);
  return r.enabled;
}
