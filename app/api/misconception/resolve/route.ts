import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

// =============================================================================
// POST /api/misconception/resolve
// -----------------------------------------------------------------------------
// Body: { misconception_id: string, resolved: boolean }
//
// Lets the student manually mark a misconception as resolved (or unresolve it).
// We don't auto-resolve on a passed drill because the student should feel they
// own the call — and one good drill doesn't always equal real mastery.
// =============================================================================

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const misconception_id: string = String(body.misconception_id || "");
    const resolved: boolean = !!body.resolved;
    if (!misconception_id) return NextResponse.json({ error: "misconception_id required" }, { status: 400 });

    const { data: misc, error: mErr } = await sb
      .from("misconceptions")
      .select("id, user_id")
      .eq("id", misconception_id)
      .single();
    if (mErr || !misc) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (misc.user_id !== user.id) return NextResponse.json({ error: "Not yours" }, { status: 403 });

    const { error: upErr } = await sb
      .from("misconceptions")
      .update({ resolved, resolved_at: resolved ? new Date().toISOString() : null })
      .eq("id", misconception_id);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
