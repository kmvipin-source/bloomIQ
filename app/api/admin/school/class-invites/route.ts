import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

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
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

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

    // Pull every class_teachers row in the school (primary + acting +
    // co) so the same endpoint can return co-teacher counts. Previously
    // the /school/classes page fetched coCount with the user-token
    // client, which raced RLS the same way the primary lookup did.
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
        .in("class_id", classIds),
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
    type CtRow = { class_id: string; teacher_id: string; role: "primary" | "acting" | "co" };
    const primaryByClass: Record<string, { teacher_id: string }> = {};
    const actingByClass: Record<string, { teacher_id: string }> = {};
    const coCountByClass: Record<string, number> = {};
    ((cts as CtRow[] | null) || []).forEach((r) => {
      if (r.role === "primary" && !primaryByClass[r.class_id]) primaryByClass[r.class_id] = { teacher_id: r.teacher_id };
      else if (r.role === "acting" && !actingByClass[r.class_id]) actingByClass[r.class_id] = { teacher_id: r.teacher_id };
      else if (r.role === "co") coCountByClass[r.class_id] = (coCountByClass[r.class_id] || 0) + 1;
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
      coCountByClass,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
