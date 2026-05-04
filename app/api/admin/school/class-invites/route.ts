import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/admin/school/class-invites
 *
 * Returns the latest class_teacher_invites row (by invited_at desc) for
 * every class in the caller's school, keyed by class_id. Used by
 * /school/classes to render the Pending / Rejected status pills without
 * tripping the RLS race that intermittently returns nothing when the
 * page reads class_teacher_invites via the user-token client right
 * after login.
 *
 * Caller must be a super_teacher (head or deputy) of a school. We do
 * the gating in code rather than via RLS so this endpoint is identical
 * for every school admin path.
 */
export async function GET(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const admin = supabaseAdmin();
    const { data: me } = await admin
      .from("profiles")
      .select("role, school_id")
      .eq("id", user.id)
      .maybeSingle();
    if (!me || me.role !== "super_teacher" || !me.school_id) {
      return NextResponse.json({ error: "Not authorised" }, { status: 403 });
    }

    const { data: classes } = await admin
      .from("classes")
      .select("id")
      .eq("school_id", me.school_id);
    const classIds = ((classes as Array<{ id: string }> | null) || []).map((c) => c.id);
    if (classIds.length === 0) {
      return NextResponse.json({ ok: true, invitesByClass: {} });
    }

    const { data: invites } = await admin
      .from("class_teacher_invites")
      .select("class_id, email, status, invited_at, responded_at")
      .in("class_id", classIds)
      .eq("role", "primary")
      .order("invited_at", { ascending: false });

    type Row = { class_id: string; email: string; status: string; invited_at: string; responded_at: string | null };
    const out: Record<string, Row> = {};
    ((invites as Row[] | null) || []).forEach((r) => {
      // First row per class wins (sorted desc by invited_at).
      if (!out[r.class_id]) out[r.class_id] = r;
    });
    return NextResponse.json({ ok: true, invitesByClass: out });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
