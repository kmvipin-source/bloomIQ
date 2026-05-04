import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/teacher/class-context/[id]
 *
 * Returns the class_teachers roster for [id] plus the caller's own role
 * on this class, via the service role. Reading class_teachers with the
 * user-token client raced RLS and made the primary teacher's class
 * detail page fall back to "Co-teacher view — only the primary teacher
 * can add or remove students" copy with no add controls — even though
 * the caller actually was the primary.
 *
 * Authorisation: caller must have at least one role on the class
 * (primary, co, acting), OR be a super_teacher of the school the class
 * belongs to. Otherwise 403.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: classId } = await params;
    if (!classId) return NextResponse.json({ error: "Missing class id" }, { status: 400 });

    const admin = supabaseAdmin();
    const { data: cls } = await admin
      .from("classes")
      .select("id, school_id")
      .eq("id", classId)
      .maybeSingle();
    if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

    const { data: me } = await admin
      .from("profiles")
      .select("role, school_id")
      .eq("id", user.id)
      .maybeSingle();

    const { data: teachers } = await admin
      .from("class_teachers")
      .select("teacher_id, role, subject")
      .eq("class_id", classId);
    type CtRow = { teacher_id: string; role: "primary" | "co" | "acting"; subject: string | null };
    const ctList = (teachers as CtRow[] | null) || [];

    const isClassMember = ctList.some((r) => r.teacher_id === user.id);
    const isSchoolAdmin =
      me?.role === "super_teacher" && me.school_id === cls.school_id;
    if (!isClassMember && !isSchoolAdmin) {
      return NextResponse.json({ error: "Not authorised" }, { status: 403 });
    }

    const teacherIds = ctList.map((r) => r.teacher_id);
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

    const myRole = ctList.find((r) => r.teacher_id === user.id)?.role || null;
    return NextResponse.json({
      ok: true,
      teachers: ctList.map((r) => ({
        teacher_id: r.teacher_id,
        role: r.role,
        subject: r.subject,
        full_name: nameById.get(r.teacher_id) ?? null,
      })),
      my_role: myRole,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
