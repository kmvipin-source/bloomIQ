import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/cron/expire-subscriptions
 *
 * Idempotent housekeeping endpoint. Flips subscriptions.status from
 * 'active' to 'expired' for any row whose expires_at < now(). Safe to
 * run as often as you want — re-running is a no-op once everything is
 * already expired.
 *
 * Auth: requires the Authorization header to be `Bearer ${CRON_SECRET}`.
 * CRON_SECRET is an env var you set in .env.local AND in your scheduler
 * (Supabase pg_cron, Vercel Cron, GitHub Actions, cron-job.org, etc.).
 *
 * IMPORTANT: useFeatureAccess already gates by expires_at directly, so
 * even if this cron never runs, expired users see locked features. The
 * status flip is mainly cosmetic — it lets analytics queries cleanly
 * filter "active subscriptions" without checking expires_at every time,
 * and it lets the renewal banner detect expired-and-not-yet-renewed
 * (vs expired-and-renewed) without a race.
 *
 * Recommended schedule: hourly. Daily is fine too — the user-facing
 * gating doesn't depend on this running on time.
 *
 * Sample Supabase pg_cron entry (run from SQL editor):
 *   select cron.schedule(
 *     'expire-subs-hourly',
 *     '0 * * * *',
 *     $$ select net.http_post(
 *          url := 'https://yourdomain.com/api/cron/expire-subscriptions',
 *          headers := '{"Authorization":"Bearer YOUR_CRON_SECRET"}'::jsonb
 *        ) $$
 *   );
 */
export async function POST(req: Request) {
  try {
    const auth = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const expected = `Bearer ${process.env.CRON_SECRET || ""}`;
    if (!process.env.CRON_SECRET) {
      return NextResponse.json(
        { error: "CRON_SECRET is not configured. Add it to .env.local first." },
        { status: 503 }
      );
    }
    if (auth !== expected) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = supabaseAdmin();
    const nowIso = new Date().toISOString();

    // Flip 'active' rows whose expires_at has passed. We use .lt() so
    // expires_at = exactly now() doesn't get flipped — gives the user a
    // brief grace period.
    const { data: flipped, error } = await admin
      .from("subscriptions")
      .update({ status: "expired" })
      .lt("expires_at", nowIso)
      .eq("status", "active")
      .select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      flipped_count: (flipped || []).length,
      checked_at: nowIso,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Cron failed" },
      { status: 500 }
    );
  }
}

/**
 * GET — same logic but easier to test in a browser. Same auth
 * requirement.
 */
export async function GET(req: Request) {
  return POST(req);
}
