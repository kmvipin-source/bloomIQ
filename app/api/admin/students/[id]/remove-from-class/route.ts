import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/admin/students/[id]/remove-from-class
 *
 * Body: { class_id: string }
 *
 * SOFT removal: deletes the class_members row only. The auth user, profile,
 * quiz attempts, and history are all PRESERVED so the action can be undone
 * via the companion /restore-to-class endpoint, and so a teacher's mistake
 * never destroys data.
 *
 * The duplicate-name check in /api/admin/students filters out students with
 * zero class memberships, so a removed student does not trip a false-positive
 * "duplicate" warning when the teacher creates a new student of the same
 * name.
 *
 * Auth: caller must teach the target class (primary or co-teacher) OR be
 * the school's Admin Head.
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
    if (!classId) {
      return NextResponse.json({ error: "class_id is required" }, { status: 400 });
    }

    const admin = supabaseAdmin();

    const { data: cls } = await admin
      .from("classes")
      .select("id, school_id")
      .eq("id", classId)
      .maybeSingle();
    if (!cls) {
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    }

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

    // Capture the joined_at so /restore can put them back with the original
    // join time if the teacher hits Undo.
    const { data: existing } = await admin
      .from("class_members")
      .select("joined_at")
      .eq("class_id", classId)
      .eq("student_id", studentId)
      .maybeSingle();

    const { error: delErr } = await admin
      .from("class_members")
      .delete()
      .eq("class_id", classId)
      .eq("student_id", studentId);
    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      restorable: true,
      previousJoinedAt: existing?.joined_at || null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to remove student" },
      { status: 500 }
    );
  }
}
