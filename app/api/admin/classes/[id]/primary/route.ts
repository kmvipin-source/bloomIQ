import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/admin/classes/[id]/primary
 *
 * Set or change the primary teacher of a class. Body:
 *   { email: string | null, school_only?: boolean }
 *
 *   email = null  -> remove primary (class becomes unassigned, any pending invite cleared)
 *   email = "..."  -> assign primary by email. Two cases:
 *     a) email matches an existing user account in this school -> link directly,
 *        demote any current primary to co, mirror owner_id.
 *     b) email has no account yet -> store a pending invite. The current primary
 *        is left alone until the new person actually signs up.
 *
 * Auth: Admin Head of the same school.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: classId } = await params;
    if (!classId) return NextResponse.json({ error: "Missing class id" }, { status: 400 });

    const body = await req.json().catch(() => ({}));
    const rawEmail = body?.email;
    let email: string | null =
      rawEmail === null || rawEmail === ""
        ? null
        : String(rawEmail).trim().toLowerCase() || null;
    const teacherIdInput: string | null = body?.teacher_id ? String(body.teacher_id).trim() : null;

    // Allow either the school\u2019s Admin Head OR the class\u2019s current primary
    // teacher. The current primary can hand the role off to another teacher.
    const admin = supabaseAdmin();
    const { data: cls } = await admin
      .from("classes")
      .select("id, school_id")
      .eq("id", classId)
      .maybeSingle();
    if (!cls) return NextResponse.json({ error: "Class not found." }, { status: 404 });

    const { data: me } = await admin
      .from("profiles")
      .select("role, school_id")
      .eq("id", user.id)
      .maybeSingle();
    const isAdminOfSchool = me?.role === "super_teacher" && me.school_id === cls.school_id;

    const { data: callerCt } = await admin
      .from("class_teachers")
      .select("role")
      .eq("class_id", classId)
      .eq("teacher_id", user.id)
      .maybeSingle();
    const isCurrentPrimary = callerCt?.role === "primary";

    if (!isAdminOfSchool && !isCurrentPrimary) {
      return NextResponse.json(
        { error: "Only the school Admin Head or the current primary teacher can change the primary." },
        { status: 403 }
      );
    }

    // If caller passed teacher_id (instead of email), resolve to email via
    // auth.users. This is what powers the "Make primary" button on co-teacher
    // rows where the page only has the teacher_id at hand.
    if (!email && teacherIdInput) {
      const { data: targetUser } = await admin.auth.admin.getUserById(teacherIdInput);
      if (!targetUser?.user?.email) {
        return NextResponse.json({ error: "Teacher account not found." }, { status: 404 });
      }
      email = targetUser.user.email.toLowerCase();
    }

    // === Case: email is null -> unassign primary (and any pending invite) ===
    if (!email) {
      const { data: currentPrimary } = await admin
        .from("class_teachers")
        .select("teacher_id")
        .eq("class_id", classId)
        .eq("role", "primary")
        .maybeSingle();
      if (currentPrimary?.teacher_id) {
        await admin
          .from("class_teachers")
          .update({ role: "co" })
          .eq("class_id", classId)
          .eq("teacher_id", currentPrimary.teacher_id);
      }
      await admin
        .from("class_teacher_invites")
        .delete()
        .eq("class_id", classId)
        .eq("role", "primary");
      await admin.from("classes").update({ owner_id: null }).eq("id", classId);
      return NextResponse.json({ ok: true, status: "unassigned" });
    }

    if (email.endsWith("@bloomiq.invalid")) {
      return NextResponse.json(
        { error: "That email belongs to a school student account, not a teacher." },
        { status: 400 }
      );
    }

    // === Case: email is provided -> resolve to existing account if possible ===
    const { data: usersList, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
    const target = usersList.users.find((u) => u.email?.toLowerCase() === email);

    if (target) {
      // Account exists. Verify it's a teacher (or upgrade them quietly to teacher
      // if they're currently 'student' with no school — happens with fresh test
      // accounts). Reject super_teacher of OTHER schools.
      const { data: tProf } = await admin
        .from("profiles")
        .select("role, school_id")
        .eq("id", target.id)
        .maybeSingle();
      if (!tProf) {
        return NextResponse.json(
          { error: "Account exists but profile missing — ask them to log in once first." },
          { status: 400 }
        );
      }
      if (tProf.role === "super_teacher" && tProf.school_id && tProf.school_id !== me.school_id) {
        return NextResponse.json(
          { error: "That email belongs to the Admin Head of another school." },
          { status: 409 }
        );
      }
      // Pull them into this school as a teacher (covers the case where they
      // signed up as 'student' or are unaffiliated).
      await admin
        .from("profiles")
        .update({ role: "teacher", school_id: me.school_id })
        .eq("id", target.id);

      // Demote current primary, then promote.
      const { data: currentPrimary } = await admin
        .from("class_teachers")
        .select("teacher_id")
        .eq("class_id", classId)
        .eq("role", "primary")
        .maybeSingle();
      if (currentPrimary?.teacher_id && currentPrimary.teacher_id !== target.id) {
        await admin
          .from("class_teachers")
          .update({ role: "co" })
          .eq("class_id", classId)
          .eq("teacher_id", currentPrimary.teacher_id);
      }
      const { error: upErr } = await admin
        .from("class_teachers")
        .upsert(
          { class_id: classId, teacher_id: target.id, role: "primary" },
          { onConflict: "class_id,teacher_id" }
        );
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

      await admin.from("classes").update({ owner_id: target.id }).eq("id", classId);

      // Drop any pending invite for this email + class (no longer pending).
      await admin
        .from("class_teacher_invites")
        .delete()
        .eq("class_id", classId)
        .eq("email", email);

      return NextResponse.json({ ok: true, status: "linked", teacher_id: target.id });
    }

    // === No account yet -> store a pending invite ===
    const { error: invErr } = await admin
      .from("class_teacher_invites")
      .upsert(
        { class_id: classId, email, role: "primary", invited_by: user.id },
        { onConflict: "class_id,email" }
      );
    if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, status: "pending", email });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to change primary" },
      { status: 500 }
    );
  }
}
