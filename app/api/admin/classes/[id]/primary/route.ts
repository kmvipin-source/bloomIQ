import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/admin/classes/[id]/primary
 *
 * Set or change the primary teacher of a class. Body shapes:
 *
 *   { email: null }
 *     -> remove primary entirely (class becomes unassigned, any pending
 *        invite cleared, owner_id null). The previous primary is demoted
 *        to co-teacher so they keep class access.
 *
 *   { email: "..." }
 *     -> upsert a PENDING INVITE on class_teacher_invites. The new teacher
 *        must accept via their dashboard before class_teachers /
 *        classes.owner_id are touched. This is the right path for normal
 *        onboarding where the school admin doesn't want to forcibly move
 *        a teacher into the role.
 *
 *   { teacher_id, immediate: true }   <-- BUSINESS-CONTINUITY (Option B)
 *     -> add `teacher_id` as ACTING COVER on this class. The canonical
 *        primary stays primary (keeps title + ownership). The acting cover
 *        gets primary-equivalent privileges via RLS (is_class_primary now
 *        accepts both roles after migration 48). Used when the canonical
 *        primary is on unplanned leave; when they return, the admin clicks
 *        "End acting cover" (mode end_acting below) to remove the acting
 *        row — no re-reassign required.
 *
 *   { end_acting: true }
 *     -> remove any acting cover from this class. Idempotent: returns ok
 *        even if no acting row existed. Used when the canonical primary
 *        returns from leave.
 *
 * Auth: Admin Head OR Deputy (super_teacher in same school) for immediate /
 * end_acting. Email-invite path additionally allows the class's current
 * primary teacher.
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
      rawEmail == null || rawEmail === ""
        ? null
        : String(rawEmail).trim().toLowerCase() || null;
    const teacherIdInput: string | null = body?.teacher_id ? String(body.teacher_id).trim() : null;
    const immediate: boolean = !!body?.immediate;
    const endActing: boolean = !!body?.end_acting;

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

    // === END ACTING COVER ===
    // Remove any 'acting' row on this class. Idempotent; nothing to do if
    // there's no cover. Reserved to school admins (Head + Deputies).
    if (endActing) {
      if (!isAdminOfSchool) {
        return NextResponse.json(
          { error: "Only the Admin Head or a Deputy can end an acting cover." },
          { status: 403 }
        );
      }
      const { error: delErr } = await admin
        .from("class_teachers")
        .delete()
        .eq("class_id", classId)
        .eq("role", "acting");
      if (delErr) {
        return NextResponse.json({ error: delErr.message }, { status: 500 });
      }
      return NextResponse.json({ ok: true, status: "acting_ended" });
    }

    // If caller passed teacher_id (instead of email) and is NOT in immediate
    // mode, resolve to email so the invite flow can target a real address.
    if (!email && teacherIdInput && !immediate) {
      const { data: targetUser } = await admin.auth.admin.getUserById(teacherIdInput);
      if (!targetUser?.user?.email) {
        return NextResponse.json({ error: "Teacher account not found." }, { status: 404 });
      }
      email = targetUser.user.email.toLowerCase();
    }

    // === Case: email is null and not immediate -> unassign primary ===
    // Removes the previous primary from THIS class (deletes the
    // class_teachers row + clears classes.owner_id + clears any pending
    // primary invite). Does NOT touch profiles.school_id — a teacher who
    // joined the school via the join code stays in the school even after
    // a class unassign. To evict them from the school entirely, the admin
    // uses the explicit Remove action on /school/teachers.
    if (!email && !immediate) {
      const { data: currentPrimary } = await admin
        .from("class_teachers")
        .select("teacher_id")
        .eq("class_id", classId)
        .eq("role", "primary")
        .maybeSingle();
      const prevTeacherId = currentPrimary?.teacher_id || null;
      if (prevTeacherId) {
        await admin
          .from("class_teachers")
          .delete()
          .eq("class_id", classId)
          .eq("teacher_id", prevTeacherId);
      }
      // Clear any acting cover — class is being fully unassigned.
      await admin
        .from("class_teachers")
        .delete()
        .eq("class_id", classId)
        .eq("role", "acting");
      await admin
        .from("class_teacher_invites")
        .delete()
        .eq("class_id", classId)
        .eq("role", "primary");
      await admin.from("classes").update({ owner_id: null }).eq("id", classId);
      return NextResponse.json({ ok: true, status: "unassigned" });
    }

    // === BUSINESS-CONTINUITY PATH: immediate ACTING COVER (Option B) ===
    // The canonical primary stays untouched. The picked teacher is added
    // as 'acting' — primary-level privileges via RLS, but distinct from
    // the title-holder. When the original primary returns, the admin
    // clicks "End acting cover" and the acting row vanishes.
    //
    // owner_id is intentionally NOT mirrored here (acting is a temporary
    // cover, not an ownership transfer). owner_id stays on the canonical
    // primary so legacy queries that key off owner_id still resolve to
    // the title-holder.
    if (immediate) {
      if (!isAdminOfSchool) {
        return NextResponse.json(
          { error: "Only the Admin Head or a Deputy can set an acting cover." },
          { status: 403 }
        );
      }
      if (!teacherIdInput) {
        return NextResponse.json(
          { error: "Acting cover requires an in-school teacher_id." },
          { status: 400 }
        );
      }
      const { data: targetProf } = await admin
        .from("profiles")
        .select("id, school_id, role, full_name")
        .eq("id", teacherIdInput)
        .maybeSingle();
      if (!targetProf) {
        return NextResponse.json({ error: "Teacher not found." }, { status: 404 });
      }
      if (targetProf.school_id !== cls.school_id) {
        return NextResponse.json(
          { error: "That teacher is not in this school. Use the email path to invite them." },
          { status: 400 }
        );
      }
      if (targetProf.role !== "teacher" && targetProf.role !== "super_teacher") {
        return NextResponse.json(
          { error: "Target must be a teacher or school admin." },
          { status: 400 }
        );
      }

      // Don't let someone be both primary and acting on the same class —
      // that's nonsensical. If they're already primary, the admin doesn't
      // need a cover; just say so.
      const { data: existingRow } = await admin
        .from("class_teachers")
        .select("role")
        .eq("class_id", classId)
        .eq("teacher_id", teacherIdInput)
        .maybeSingle();
      if (existingRow?.role === "primary") {
        return NextResponse.json(
          { error: "That teacher is already the primary of this class." },
          { status: 400 }
        );
      }

      // Replace any existing acting cover (only one acting per class —
      // enforced by ct_one_acting_per_class).
      await admin
        .from("class_teachers")
        .delete()
        .eq("class_id", classId)
        .eq("role", "acting");

      // Upsert target as 'acting'. If they were already a 'co' on this
      // class we update the role; otherwise we insert.
      const { error: upErr } = await admin
        .from("class_teachers")
        .upsert(
          { class_id: classId, teacher_id: teacherIdInput, role: "acting" },
          { onConflict: "class_id,teacher_id" }
        );
      if (upErr) {
        return NextResponse.json(
          { error: `Could not set acting cover: ${upErr.message}` },
          { status: 500 }
        );
      }
      // Don't touch classes.owner_id — acting is a cover, not a transfer.
      // Don't clear the pending invite either (it's about the canonical
      // primary slot, not the acting cover).
      return NextResponse.json({
        ok: true,
        status: "acting_set",
        teacher_id: teacherIdInput,
        full_name: targetProf.full_name,
      });
    }

    if (email && email.endsWith("@bloomiq.invalid")) {
      return NextResponse.json(
        { error: "That email belongs to a school student account, not a teacher." },
        { status: 400 }
      );
    }

    // === Email path ===
    // Two outcomes depending on who owns this email:
    //
    //   (a) The email already belongs to a teacher of THIS school — do a
    //       DIRECT TRANSFER. No invite, no waiting. We demote the previous
    //       primary to co-teacher, install the target as primary, and
    //       update classes.owner_id. This is the natural intent when the
    //       admin types the email of someone already on staff.
    //
    //   (b) The email belongs to no one, or to someone in a different
    //       school — fall through to the existing PENDING INVITE flow. The
    //       new teacher must accept from their dashboard before joining.
    //
    // Pre-fix behaviour was always (b), which meant existing in-school
    // teachers got a redundant invite and the flow looked broken — the
    // class stayed Pending and the target's dashboard showed a "Join your
    // school" card because the invite path momentarily decoupled their
    // school binding. Defects 3 + 4 both close here.
    let directTransferTargetId: string | null = null;
    let directTransferTargetName: string | null = null;
    if (email) {
      const { data: usersList, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
      const target = usersList.users.find((u) => u.email?.toLowerCase() === email);
      if (target) {
        const { data: tProf } = await admin
          .from("profiles")
          .select("id, role, school_id, full_name, is_school_student")
          .eq("id", target.id)
          .maybeSingle();
        if (tProf?.role === "super_teacher" && tProf.school_id && tProf.school_id !== me?.school_id) {
          return NextResponse.json(
            { error: "That email belongs to the Admin Head of another school." },
            { status: 409 }
          );
        }
        // Direct-transfer eligibility: same school, teacher role (or
        // super_teacher acting as teacher), not a school student.
        const sameSchool = tProf?.school_id && tProf.school_id === cls.school_id;
        const isTeacherish = tProf?.role === "teacher" || tProf?.role === "super_teacher";
        if (sameSchool && isTeacherish && !tProf?.is_school_student) {
          directTransferTargetId = tProf.id;
          directTransferTargetName = tProf.full_name;
        }
      }
    }

    if (directTransferTargetId) {
      // 1) Demote the existing primary on this class to 'co' so they keep
      //    class access but lose the title.
      const { data: prevPrimary } = await admin
        .from("class_teachers")
        .select("teacher_id")
        .eq("class_id", classId)
        .eq("role", "primary")
        .maybeSingle();
      const prevId = prevPrimary?.teacher_id || null;
      if (prevId && prevId !== directTransferTargetId) {
        await admin
          .from("class_teachers")
          .update({ role: "co" })
          .eq("class_id", classId)
          .eq("teacher_id", prevId);
      }
      // 2) Upsert target as primary. If they were already on the class as
      //    co or acting, this rewrites their role to 'primary'.
      const { error: upErr } = await admin
        .from("class_teachers")
        .upsert(
          { class_id: classId, teacher_id: directTransferTargetId, role: "primary" },
          { onConflict: "class_id,teacher_id" }
        );
      if (upErr) return NextResponse.json({ error: `Could not set primary: ${upErr.message}` }, { status: 500 });
      // 3) Mirror onto classes.owner_id so legacy queries keyed off it
      //    stay correct.
      await admin.from("classes").update({ owner_id: directTransferTargetId }).eq("id", classId);
      // 4) Clear any stale pending invite for this class — the role is
      //    now filled.
      await admin
        .from("class_teacher_invites")
        .delete()
        .eq("class_id", classId)
        .eq("role", "primary");

      return NextResponse.json({
        ok: true,
        status: "linked",
        teacher_id: directTransferTargetId,
        full_name: directTransferTargetName,
      });
    }

    // Fall-through: invite flow for emails that DON'T match an existing
    // in-school teacher.
    const { error: invErr } = await admin
      .from("class_teacher_invites")
      .upsert(
        {
          class_id: classId,
          email,
          role: "primary",
          invited_by: user.id,
          status: "pending",
          responded_at: null,
        },
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
