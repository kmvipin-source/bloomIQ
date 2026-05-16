import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

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
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

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
