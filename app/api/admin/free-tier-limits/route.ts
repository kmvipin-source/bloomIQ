import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
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

async function requireAdmin(req: Request): Promise<{ ok: true } | { ok: false; res: Response }> {
  const token = getBearer(req);
  if (!token) {
    return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const admin = supabaseAdmin();
  const { data: prof } = await admin
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!prof?.platform_admin) {
    return { ok: false, res: NextResponse.json({ error: "Platform admin only." }, { status: 403 }) };
  }
  return { ok: true };
}

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
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.res;

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
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.res;

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
