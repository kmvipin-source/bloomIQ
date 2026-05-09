import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Helper: caller must be Admin Head of the class\u2019s school OR the
 * primary teacher of the class. Returns null if allowed, else a NextResponse
 * 403/404.
 */
async function authorize(token: string, classId: string) {
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const admin = supabaseAdmin();
  const { data: cls } = await admin
    .from("classes")
    .select("school_id")
    .eq("id", classId)
    .maybeSingle();
  if (!cls) return { err: NextResponse.json({ error: "Class not found." }, { status: 404 }) };

  const { data: me } = await admin
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  const isAdminOfSchool = me?.role === "super_teacher" && me.school_id === cls.school_id;

  const { data: ct } = await admin
    .from("class_teachers")
    .select("role")
    .eq("class_id", classId)
    .eq("teacher_id", user.id)
    .maybeSingle();
  const isPrimary = ct?.role === "primary";

  if (!isAdminOfSchool && !isPrimary) {
    return { err: NextResponse.json(
      { error: "Only the class\u2019s primary teacher or your school Admin Head can manage co-teachers." },
      { status: 403 }
    ) };
  }

  return { user, cls, admin };
}

/**
 * POST /api/admin/classes/[id]/co-teachers
 *
 * Add a co-teacher by email. Body:
 *   { email: string, subject?: string }
 *
 * If the email matches an existing account, the user is linked instantly as
 * a co-teacher (role='co', subject=...). If there\u2019s no account yet, a
 * pending invite is stored and auto-claimed when they sign up.
 *
 * Auth: primary teacher of the class OR Admin Head of the school.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: classId } = await params;
    const auth = await authorize(token, classId);
    if ("err" in auth) return auth.err;
    const { user, admin, cls } = auth;

    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const subject = body.subject ? String(body.subject).trim() : null;

    if (!email) return NextResponse.json({ error: "Email is required." }, { status: 400 });
    if (email.endsWith("@bloomiq.invalid")) {
      return NextResponse.json(
        { error: "That email belongs to a school student account, not a teacher." },
        { status: 400 }
      );
    }

    // Two-sided invite \u2014 never silently link. Sanity-check email if an
    // account already exists (refuse if it's an Admin Head of another school
    // or the same user trying to invite themselves), then create a pending
    // invite. Teacher accepts via their dashboard.
    const { data: usersList, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
    const target = (usersList.users as Array<{ id: string; email?: string | null }>).find((u) => u.email?.toLowerCase() === email);
    if (target) {
      if (target.id === user.id) {
        return NextResponse.json(
          { error: "You\u2019re already a teacher of this class." },
          { status: 400 }
        );
      }
      const { data: tProf } = await admin
        .from("profiles")
        .select("role, school_id")
        .eq("id", target.id)
        .maybeSingle();
      if (tProf?.role === "super_teacher" && tProf.school_id && tProf.school_id !== cls.school_id) {
        return NextResponse.json(
          { error: "That email belongs to the Admin Head of another school." },
          { status: 409 }
        );
      }
    }

    // Reset status so a prior accepted/declined row doesn't keep its old verdict.
    const { error: invErr } = await admin
      .from("class_teacher_invites")
      .upsert(
        {
          class_id: classId,
          email,
          role: "co",
          subject,
          invited_by: user.id,
          status: "pending",
          responded_at: null,
        },
        { onConflict: "class_id,email" }
      );
    if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, status: "pending", email });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Invite failed" }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/classes/[id]/co-teachers
 *
 * Remove a co-teacher (by teacher_id) or a pending co-teacher invite (by email).
 * Body: { teacher_id?: string, email?: string }
 *
 * Auth: primary teacher of the class OR Admin Head of the school.
 * Cannot remove the primary themselves \u2014 use the primary endpoint.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: classId } = await params;
    const auth = await authorize(token, classId);
    if ("err" in auth) return auth.err;
    const { user, admin } = auth;

    const body = await req.json().catch(() => ({}));
    const teacherId: string = String(body.teacher_id || "").trim();
    const email: string = String(body.email || "").trim().toLowerCase();
    if (!teacherId && !email) {
      return NextResponse.json({ error: "Provide teacher_id or email." }, { status: 400 });
    }

    if (teacherId) {
      if (teacherId === user.id) {
        return NextResponse.json(
          { error: "You can\u2019t remove yourself this way. The Admin Head can change the primary." },
          { status: 400 }
        );
      }
      const { error } = await admin
        .from("class_teachers")
        .delete()
        .eq("class_id", classId)
        .eq("teacher_id", teacherId)
        .eq("role", "co");
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (email) {
      await admin
        .from("class_teacher_invites")
        .delete()
        .eq("class_id", classId)
        .eq("email", email)
        .eq("role", "co");
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Remove failed" }, { status: 500 });
  }
}
