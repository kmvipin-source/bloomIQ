import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/admin/free-trial-settings
 * PATCH /api/admin/free-trial-settings  body: { free_trial_days: number }
 *
 * Platform-admin-only. Reads or sets the Free trial duration for new
 * independent-student sign-ups. Stored in subscription_limits.free_trial_days
 * (singleton row, id=1, capped 0-90 by migration 67).
 */

async function requirePlatformAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const admin = supabaseAdmin();
  const { data: prof } = await admin
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!(prof as { platform_admin?: boolean } | null)?.platform_admin) {
    return { error: NextResponse.json({ error: "Forbidden — platform admin only" }, { status: 403 }) };
  }
  return { admin, userId: user.id };
}

export async function GET(req: Request) {
  try {
    const ctx = await requirePlatformAdmin(req);
    if ("error" in ctx) return ctx.error;
    const { data: row, error } = await ctx.admin
      .from("subscription_limits")
      .select("free_trial_days")
      .eq("id", 1)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({
      ok: true,
      free_trial_days: (row as { free_trial_days?: number } | null)?.free_trial_days ?? 0,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requirePlatformAdmin(req);
    if ("error" in ctx) return ctx.error;
    const body = (await req.json().catch(() => ({}))) as { free_trial_days?: unknown };
    const days = typeof body.free_trial_days === "number" ? Math.round(body.free_trial_days) : NaN;
    if (!Number.isFinite(days) || days < 0 || days > 90) {
      return NextResponse.json(
        { error: "free_trial_days must be an integer 0–90" },
        { status: 400 }
      );
    }
    const { error } = await ctx.admin
      .from("subscription_limits")
      .update({ free_trial_days: days })
      .eq("id", 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, free_trial_days: days });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
