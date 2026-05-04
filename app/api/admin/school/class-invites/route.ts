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

    const [{ data: invites }, { data: cts }] = await Promise.all([
      admin
        .from("class_teacher_invites")
        .select("class_id, email, status, invited_at, responded_at")
        .in("class_id", classIds)
        .eq("role", "primary")
        .order("invited_at", { ascending: false }),
      admin
        .from("class_teachers")
        .select("class_id, teacher_id, role")
        .in("class_id", classIds)
        .in("role", ["primary", "acting"]),
    ]);

    type Row = { class_id: string; email: string; status: string; invited_at: string; responded_at: string | null };
    const out: Record<string, Row> = {};
    ((invites as Row[] | null) || []).forEach((r) => {
      // First row per class wins (sorted desc by invited_at).
      if (!out[r.class_id]) out[r.class_id] = r;
    });

    // Also surface primary + acting class_teachers rows by class. Reading
    // these via the user-token client raced RLS and made the
    // /school/classes status column show 'Unassigned' even after an
    // invite was accepted — the page never saw the class_teachers row.
    type CtRow = { class_id: string; teacher_id: string; role: "primary" | "acting" };
    const primaryByClass: Record<string, { teacher_id: string }> = {};
    const actingByClass: Record<string, { teacher_id: string }> = {};
    ((cts as CtRow[] | null) || []).forEach((r) => {
      if (r.role === "primary" && !primaryByClass[r.class_id]) primaryByClass[r.class_id] = { teacher_id: r.teacher_id };
      if (r.role === "acting" && !actingByClass[r.class_id])  actingByClass[r.class_id]  = { teacher_id: r.teacher_id };
    });

    // Resolve names for surfaced teacher_ids in one shot.
    const teacherIds = Array.from(new Set([
      ...Object.values(primaryByClass).map((p) => p.teacher_id),
      ...Object.values(actingByClass).map((p) => p.teacher_id),
    ]));
    let nameById = new Map<string, string | null>();
    if (teacherIds.length) {
      const { data: profs } = await admin
        .from("profiles")
        .select("id, full_name")
        .in("id", teacherIds);
      nameById = new Map(
        ((profs as Array<{ id: string; full_name: string | null }> | null) || [])
          .map((p) => [p.id, p.full_name]),
      );
    }
    const primaryByClassNamed: Record<string, { teacher_id: string; full_name: string | null }> = {};
    const actingByClassNamed:  Record<string, { teacher_id: string; full_name: string | null }> = {};
    Object.entries(primaryByClass).forEach(([cid, v]) => { primaryByClassNamed[cid] = { ...v, full_name: nameById.get(v.teacher_id) ?? null }; });
    Object.entries(actingByClass).forEach(([cid, v])  => { actingByClassNamed[cid]  = { ...v, full_name: nameById.get(v.teacher_id) ?? null }; });

    return NextResponse.json({
      ok: true,
      invitesByClass: out,
      primaryByClass: primaryByClassNamed,
      actingByClass:  actingByClassNamed,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
