import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

/**
 * POST /api/teacher/question-bank
 * Body: { action: "bulk_tag_category", category: string|null, ids: string[] }
 *
 * Bulk-update the `category` column on a set of question_bank rows the
 * caller owns. Used by /teacher/quizzes/new to let teachers tag legacy
 * (NULL-category) questions in batches — generated before migration 90
 * shipped, so they have no category context yet.
 *
 * Safety: server validates ownership before writing. Category can be set
 * to a slug or NULL (clearing the tag). Returns the number of rows updated.
 */
export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const body = await req.json().catch(() => ({}));
    if (body?.action !== "bulk_tag_category") {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
    const ids = Array.isArray(body?.ids) ? (body.ids as unknown[]).filter((x) => typeof x === "string") as string[] : [];
    if (ids.length === 0) return NextResponse.json({ error: "No ids supplied." }, { status: 400 });
    if (ids.length > 500) return NextResponse.json({ error: "Too many ids (max 500)." }, { status: 400 });
    const rawCat = body?.category;
    const category: string | null =
      rawCat === null ? null
      : typeof rawCat === "string" && rawCat.trim() ? rawCat.trim().toLowerCase()
      : null;

    const admin = supabaseAdmin();
    const { error, count } = await admin
      .from("question_bank")
      .update({ category }, { count: "exact" })
      .in("id", ids)
      .eq("owner_id", user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, updated: count ?? ids.length });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}

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
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

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
