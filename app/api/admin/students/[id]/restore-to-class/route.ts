import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/admin/students/[id]/restore-to-class
 *
 * Body: { class_id: string, joined_at?: string }
 *
 * Companion to /remove-from-class. Re-adds a student to the class. Used by
 * the in-page Undo flow. If joined_at is provided, the row is restored with
 * that timestamp so the student doesn't "appear" as a fresh join. Otherwise
 * the join time defaults to now().
 *
 * Auth: same as /remove-from-class - class teacher or school admin.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: studentId } = await params;
    if (!studentId) {
      return NextResponse.json({ error: "Missing student id" }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const classId: string = String(body.class_id || "").trim();
    const joinedAtRaw = body.joined_at ? String(body.joined_at) : null;
    if (!classId) {
      return NextResponse.json({ error: "class_id is required" }, { status: 400 });
    }

    const admin = supabaseAdmin();

    const { data: cls } = await admin
      .from("classes")
      .select("id, school_id")
      .eq("id", classId)
      .maybeSingle();
    if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

    const { data: ct } = await admin
      .from("class_teachers")
      .select("role")
      .eq("class_id", classId)
      .eq("teacher_id", user.id)
      .maybeSingle();
    const isClassTeacher = !!ct;

    let isAdminOfSchool = false;
    if (!isClassTeacher) {
      const { data: me } = await admin
        .from("profiles")
        .select("role, school_id")
        .eq("id", user.id)
        .maybeSingle();
      isAdminOfSchool = me?.role === "super_teacher" && me.school_id === cls.school_id;
    }

    if (!isClassTeacher && !isAdminOfSchool) {
      return NextResponse.json(
        { error: "You do not teach this class." },
        { status: 403 }
      );
    }

    // Verify the student profile still exists - if it was deleted by some
    // other path (older code, school admin, etc.), restore is not possible.
    const { data: stuProf } = await admin
      .from("profiles")
      .select("id")
      .eq("id", studentId)
      .maybeSingle();
    if (!stuProf) {
      return NextResponse.json(
        { error: "That student account no longer exists. You'll need to recreate it." },
        { status: 404 }
      );
    }

    const row: { class_id: string; student_id: string; joined_at?: string } = {
      class_id: classId,
      student_id: studentId,
    };
    if (joinedAtRaw) row.joined_at = joinedAtRaw;

    const { error: insErr } = await admin
      .from("class_members")
      .upsert(row, { onConflict: "class_id,student_id" });
    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to restore student" },
      { status: 500 }
    );
  }
}
