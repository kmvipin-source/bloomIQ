import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

/**
 * POST /api/admin/students/add-existing
 * Body: { class_id: string, student_id: string }
 *
 * Adds an EXISTING student (already a profile in this school OR in another class
 * the teacher owns) to the target class. No auth user is created — that's the
 * whole point: we don't want a duplicate account just because the teacher
 * happened to type a similar name.
 */
export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const body = await req.json().catch(() => ({}));
    const classId: string = String(body.class_id || "").trim();
    const studentId: string = String(body.student_id || "").trim();
    const rollNumberRaw = body.roll_number;
    const rollNumber: string | null =
      typeof rollNumberRaw === "string" && rollNumberRaw.trim().length > 0
        ? rollNumberRaw.trim()
        : (typeof rollNumberRaw === "number" ? String(rollNumberRaw) : null);
    if (!classId || !studentId) {
      return NextResponse.json({ error: "class_id and student_id are required" }, { status: 400 });
    }
    if (rollNumber !== null && !/^[A-Za-z0-9]+$/.test(rollNumber)) {
      return NextResponse.json({ error: "Roll number must be alphanumeric (letters and digits only)." }, { status: 400 });
    }

    // 1) Caller must own the target class, and the class must be active.
    const { data: cls } = await sb.from("classes").select("id, owner_id, status").eq("id", classId).single();
    if (!cls || cls.owner_id !== user.id) {
      return NextResponse.json({ error: "Class not found or not yours" }, { status: 403 });
    }
    if ((cls as { status?: string | null }).status !== "active") {
      return NextResponse.json(
        { error: "Class is archived. Restore the class before adding students." },
        { status: 409 },
      );
    }

    const admin = supabaseAdmin();

    // 2) Verify the student exists and is reachable to this teacher
    //    (same school OR member of any class this teacher owns)
    const { data: prof } = await admin
      .from("profiles")
      .select("id, role, is_school_student, school_id")
      .eq("id", studentId)
      .maybeSingle();
    if (!prof || prof.role !== "student" || !prof.is_school_student) {
      return NextResponse.json({ error: "Student not found." }, { status: 404 });
    }

    const { data: me } = await admin.from("profiles").select("school_id").eq("id", user.id).maybeSingle();
    const sameSchool = me?.school_id && prof.school_id && me.school_id === prof.school_id;
    let inMyClass = false;
    if (!sameSchool) {
      const { data: myClasses } = await admin.from("classes").select("id").eq("owner_id", user.id);
      const myClassIds = (myClasses as Array<{ id: string }> | null)?.map((c) => c.id) || [];
      if (myClassIds.length > 0) {
        const { count } = await admin
          .from("class_members")
          .select("student_id", { count: "exact", head: true })
          .eq("student_id", studentId)
          .in("class_id", myClassIds);
        inMyClass = (count || 0) > 0;
      }
    }
    if (!sameSchool && !inMyClass) {
      return NextResponse.json({ error: "You don't have permission to reuse that student." }, { status: 403 });
    }

    // 3) Add membership (idempotent — skip if already a member). If a
    // roll_number was supplied AND the student is already in the class,
    // update the existing row's roll_number so the teacher can fix it via
    // re-add without a separate "set roll" UI.
    const { error } = await admin.from("class_members").insert({
      class_id: classId,
      student_id: studentId,
      roll_number: rollNumber,
    });
    const alreadyMember = !!(error && error.message.toLowerCase().includes("duplicate"));
    if (error && !alreadyMember) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (alreadyMember && rollNumber !== null) {
      await admin
        .from("class_members")
        .update({ roll_number: rollNumber })
        .eq("class_id", classId)
        .eq("student_id", studentId);
    }

    return NextResponse.json({ ok: true, alreadyMember });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
