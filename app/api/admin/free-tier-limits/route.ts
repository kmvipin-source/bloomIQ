import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";
import {
  DAILY_SURFACES,
  LIFETIME_FEATURES,
  dailySurfaceColumn,
  lifetimeFeatureColumn,
  clearFreeQuotaCache,
} from "@/lib/freeQuota";

export const runtime = "nodejs";

// =============================================================================
// /api/admin/free-tier-limits
// -----------------------------------------------------------------------------
// GET   — return the singleton subscription_limits row + a list of columns
//         this page is allowed to edit (so the UI can iterate).
// PATCH — body keyed by column name; updates the row atomically; clears the
//         server-side cache so changes take effect on the next request.
//
// Auth: platform_admin only.
//
// This endpoint is the SINGLE source of truth for every Free-plan knob:
//   - trial duration  (free_trial_days)
//   - daily caps      (free_daily_*)
//   - lifetime caps   (free_lifetime_*)
//   - reset timezone  (daily_reset_timezone)
//   - quiz attempts   (free_daily_attempts, legacy column)
//
// The older /api/admin/free-trial-settings endpoint is deprecated.
// =============================================================================

// F171 fix (QA): local requireAdmin removed; using shared
// requirePlatformAdmin from lib/apiAuth.ts. Call-site error shape
// changes from { ok, res } to discriminated { error } union — patches
// below adjust the two call sites accordingly.

const EDITABLE_DAILY_COLUMNS = DAILY_SURFACES.map(dailySurfaceColumn);
const EDITABLE_LIFETIME_COLUMNS = LIFETIME_FEATURES.map(lifetimeFeatureColumn);
const EDITABLE_EXTRA = [
  "free_daily_attempts",
  "free_trial_days",
  "daily_reset_timezone",
] as const;

const ALL_EDITABLE: readonly string[] = [
  ...EDITABLE_DAILY_COLUMNS,
  ...EDITABLE_LIFETIME_COLUMNS,
  ...EDITABLE_EXTRA,
];

export async function GET(req: Request) {
  const auth = await requirePlatformAdmin(req);
  if ("error" in auth) return auth.error;

  const admin = supabaseAdmin();
  const { data: row, error } = await admin
    .from("subscription_limits")
    .select("*")
    .eq("id", 1)
    .single();
  if (error || !row) {
    return NextResponse.json({ error: error?.message || "Limits row missing" }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    limits: row,
    schema: {
      daily: DAILY_SURFACES.map((s) => ({ surface: s, column: dailySurfaceColumn(s) })),
      lifetime: LIFETIME_FEATURES.map((f) => ({ feature: f, column: lifetimeFeatureColumn(f) })),
      extras: EDITABLE_EXTRA,
    },
  });
}

export async function PATCH(req: Request) {
  const auth = await requirePlatformAdmin(req);
  if ("error" in auth) return auth.error;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Bad JSON body." }, { status: 400 });
  }

  const updates: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!ALL_EDITABLE.includes(k)) continue;
    if (k === "daily_reset_timezone") {
      if (typeof v !== "string" || v.length === 0 || v.length > 64) {
        return NextResponse.json(
          { error: "daily_reset_timezone must be a non-empty IANA tz string." },
          { status: 400 }
        );
      }
      updates[k] = v;
      continue;
    }
    const num = Number(v);
    if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
      return NextResponse.json({ error: `${k} must be a non-negative integer.` }, { status: 400 });
    }
    const ceiling = k === "free_trial_days" ? 90 : 1000;
    if (num > ceiling) {
      return NextResponse.json({ error: `${k} must be between 0 and ${ceiling}.` }, { status: 400 });
    }
    updates[k] = num;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update." }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { data: row, error } = await admin
    .from("subscription_limits")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", 1)
    .select("*")
    .single();
  if (error || !row) {
    return NextResponse.json({ error: error?.message || "Update failed" }, { status: 500 });
  }

  clearFreeQuotaCache();

  return NextResponse.json({ ok: true, limits: row, updated: Object.keys(updates) });
}
