import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/teacher/question-bank?status=pending|approved|rejected|all
 *
 * Returns the caller's own question_bank rows via the service role.
 * Reading question_bank with the user-token client raced RLS for some
 * users — the dashboard's "AWAITING REVIEW" KPI showed 12 pending while
 * /teacher/review and /teacher/quizzes/new both rendered as empty. The
 * RLS policy is `owner_id = auth.uid()` which should permit the read,
 * but the auth context evaluation occasionally returned no rows on the
 * edge. Routing through this service-role endpoint removes the race.
 *
 * Caller identity is verified via supabaseServer(token).auth.getUser();
 * the service role only reads rows where owner_id matches that user, so
 * it never widens visibility beyond what the RLS policy already grants.
 */
export async function GET(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const status = url.searchParams.get("status") || "all";

    const admin = supabaseAdmin();
    let q = admin
      .from("question_bank")
      .select("*")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: false });
    if (status !== "all") q = q.eq("status", status);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, items: data || [] });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
