import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/student/calibration/weakest-topic?level=<bloom_level>
 *
 * Picks the most-common topic among the caller's INCORRECT
 * calibration_responses, optionally biased to a specific Bloom level.
 * Used by /student/future to surface a concrete "fix this topic" call
 * to action on the Future You reveal screen.
 *
 * Routed through service role to dodge the RLS race that the dashboard
 * already hit on profiles + calibration_responses — service-role
 * client reads bypass the policy evaluation that was occasionally
 * returning zero rows on the edge.
 *
 * The result is scoped strictly to the caller via getUser() on the
 * supplied bearer token; never widens access.
 */
export async function GET(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const targetLevel = url.searchParams.get("level");

    const admin = supabaseAdmin();
    const { data: rows } = await admin
      .from("calibration_responses")
      .select("topic, bloom_level, is_correct")
      .eq("user_id", user.id)
      .eq("is_correct", false)
      .not("topic", "is", null)
      .limit(50);
    let pool: { topic?: string | null; bloom_level?: string | null }[] = rows || [];
    if (targetLevel) {
      const atLevel = pool.filter((r) => r.bloom_level === targetLevel);
      if (atLevel.length > 0) pool = atLevel;
    }
    const counts: Record<string, number> = {};
    for (const r of pool) {
      const tp = (r.topic || "").trim();
      if (tp.length >= 3) counts[tp] = (counts[tp] || 0) + 1;
    }
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const topic = ranked.length > 0 ? ranked[0][0] : null;

    return NextResponse.json({ ok: true, topic });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
