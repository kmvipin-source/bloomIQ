import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/teacher/invites/respond
 *
 * Body: { class_id: string, action: "accept" | "decline" }
 *
 * Accept:
 *   - upserts a class_teachers row for (class, me, role-from-invite)
 *   - if invite was 'primary': demotes any current primary to 'co' first,
 *     and updates classes.owner_id to me
 *   - if I'm not in a school yet, joins me to the class's school as a teacher
 *   - deletes the invite row
 *
 * Decline:
 *   - just deletes the invite row.
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const myEmail = (user.email || "").toLowerCase();
    if (!myEmail) return NextResponse.json({ error: "Account has no email." }, { status: 400 });

    const body = await req.json().catch(() => ({}));
    const classId = String(body.class_id || "");
    const action = String(body.action || "");
    if (!classId) return NextResponse.json({ error: "class_id required" }, { status: 400 });
    if (action !== "accept" && action !== "decline") {
      return NextResponse.json({ error: "action must be 'accept' or 'decline'" }, { status: 400 });
    }

    const admin = supabaseAdmin();
    // Scope the invite lookup to pending rows only. Without this filter,
    // a previously-declined invite row could coexist with a freshly-
    // issued pending one, making maybeSingle() throw a multiple-rows
    // error and silently fail the accept/decline. Also keeps the
    // accept/decline write below targeted at the row the caller is
    // responding to right now.
    const { data: invite } = await admin
      .from("class_teacher_invites")
      .select("class_id, email, role, subject")
      .eq("class_id", classId)
      .eq("email", myEmail)
      .eq("status", "pending")
      .maybeSingle();
    if (!invite) return NextResponse.json({ error: "No pending invite for this email and class." }, { status: 404 });

    if (action === "decline") {
      await admin
        .from("class_teacher_invites")
        .update({ status: "declined", responded_at: new Date().toISOString() })
        .eq("class_id", classId)
        .eq("email", myEmail)
        .eq("status", "pending");
      return NextResponse.json({ ok: true, status: "declined" });
    }

    // Accept path.
    const { data: cls } = await admin
      .from("classes")
      .select("id, school_id, owner_id")
      .eq("id", classId)
      .maybeSingle();
    if (!cls) return NextResponse.json({ error: "Class not found." }, { status: 404 });

    // Make sure my profile reflects 'teacher' role + the class's school.
    const { data: meProf } = await admin
      .from("profiles")
      .select("role, school_id")
      .eq("id", user.id)
      .maybeSingle();
    const profileUpdates: Record<string, unknown> = {};
    if (meProf?.role !== "teacher" && meProf?.role !== "super_teacher") {
      profileUpdates.role = "teacher";
    }
    if (cls.school_id && meProf?.school_id !== cls.school_id) {
      profileUpdates.school_id = cls.school_id;
    }
    if (Object.keys(profileUpdates).length) {
      await admin.from("profiles").update(profileUpdates).eq("id", user.id);
    }

    if (invite.role === "primary") {
      // Demote any existing primary to co.
      const { data: currentPrimary } = await admin
        .from("class_teachers")
        .select("teacher_id")
        .eq("class_id", classId)
        .eq("role", "primary")
        .maybeSingle();
      if (currentPrimary?.teacher_id && currentPrimary.teacher_id !== user.id) {
        await admin
          .from("class_teachers")
          .update({ role: "co" })
          .eq("class_id", classId)
          .eq("teacher_id", currentPrimary.teacher_id);
      }
    }

    const { error: upErr } = await admin
      .from("class_teachers")
      .upsert(
        {
          class_id: classId,
          teacher_id: user.id,
          role: invite.role || "co",
          subject: invite.subject || null,
        },
        { onConflict: "class_id,teacher_id" }
      );
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    if (invite.role === "primary") {
      await admin.from("classes").update({ owner_id: user.id }).eq("id", classId);
    }

    await admin
      .from("class_teacher_invites")
      .update({ status: "accepted", responded_at: new Date().toISOString() })
      .eq("class_id", classId)
      .eq("email", myEmail)
      .eq("status", "pending");

    return NextResponse.json({ ok: true, status: "accepted", role: invite.role });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
