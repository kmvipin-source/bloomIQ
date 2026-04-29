import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/admin/school/transfer
 *
 * Hand the Admin Head role to another user. Body:
 *   { new_admin_email: string }
 *
 * Auth: caller must be the current Admin Head (super_teacher) of a school.
 *
 * Steps performed atomically (best-effort sequence; the unique constraint on
 * schools.super_teacher_id makes the binding step the linchpin):
 *   1. Resolve the target user by email; reject if missing, synthetic, or self.
 *   2. Promote target: profiles.role = 'super_teacher', school_id = our school.
 *   3. Update schools.super_teacher_id to the target. (Unique constraint will
 *      reject this if the target is already Admin Head of another school.)
 *   4. Demote caller: profiles.role = 'teacher' (school_id stays — they
 *      remain a regular teacher in the school).
 *
 * On any DB error mid-flight we return the underlying message so the caller
 * can see exactly what went wrong; rollback is manual since we don't have a
 * single-statement transaction here.
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // 1) Caller must be a super_teacher with a school.
    const { data: me } = await sb
      .from("profiles")
      .select("role, school_id")
      .eq("id", user.id)
      .single();
    if (!me || me.role !== "super_teacher" || !me.school_id) {
      return NextResponse.json(
        { error: "Only the current Admin Head can transfer the role." },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const email = String(body.new_admin_email || "").trim().toLowerCase();
    if (!email) {
      return NextResponse.json({ error: "Enter the new Admin Head\u2019s email." }, { status: 400 });
    }
    if (email.endsWith("@bloomiq.invalid")) {
      return NextResponse.json(
        { error: "That email belongs to a school student account, not a real user." },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();

    // 2) Resolve target user by email.
    const { data: usersList, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
    const target = usersList.users.find((u) => u.email?.toLowerCase() === email);
    if (!target) {
      return NextResponse.json(
        { error: "No account with that email. Ask them to sign up first, then try again." },
        { status: 404 }
      );
    }
    if (target.id === user.id) {
      return NextResponse.json(
        { error: "You\u2019re already the Admin Head. Pick a different person." },
        { status: 400 }
      );
    }

    // 3) Target must already have a profile. We allow them to currently be in
    //    a different school (or none) — the transfer pulls them into ours.
    const { data: targetProf } = await admin
      .from("profiles")
      .select("role, school_id")
      .eq("id", target.id)
      .maybeSingle();
    if (!targetProf) {
      return NextResponse.json(
        { error: "Target account exists but has no profile yet — ask them to log in once first." },
        { status: 400 }
      );
    }

    // 4) Pre-check: target is not already Admin Head of a DIFFERENT school
    //    (the unique constraint would reject the binding update otherwise,
    //    but we want a clearer error than a Postgres conflict).
    const { data: otherSchool } = await admin
      .from("schools")
      .select("id, name")
      .eq("super_teacher_id", target.id)
      .maybeSingle();
    if (otherSchool && otherSchool.id !== me.school_id) {
      return NextResponse.json(
        {
          error: `That person is already Admin Head of "${otherSchool.name}". They must transfer or step down from that school first.`,
        },
        { status: 409 }
      );
    }

    // 5) Promote target — set role + school. on conflict do update via upsert
    //    is not needed because the row already exists.
    const { error: promoteErr } = await admin
      .from("profiles")
      .update({ role: "super_teacher", school_id: me.school_id })
      .eq("id", target.id);
    if (promoteErr) {
      return NextResponse.json({ error: `Promote failed: ${promoteErr.message}` }, { status: 500 });
    }

    // 6) Bind the school to the new Admin Head. Unique constraint enforces
    //    one-to-one at the DB level.
    const { error: bindErr } = await admin
      .from("schools")
      .update({ super_teacher_id: target.id })
      .eq("id", me.school_id);
    if (bindErr) {
      // Best-effort rollback: revert the target to teacher so we don't
      // leave two super_teachers in the same school.
      await admin
        .from("profiles")
        .update({ role: "teacher" })
        .eq("id", target.id);
      return NextResponse.json({ error: `Bind failed: ${bindErr.message}` }, { status: 500 });
    }

    // 7) Demote caller to plain teacher in the same school.
    const { error: demoteErr } = await admin
      .from("profiles")
      .update({ role: "teacher" })
      .eq("id", user.id);
    if (demoteErr) {
      return NextResponse.json(
        {
          error: `Transfer mostly worked, but demoting the previous Admin Head failed: ${demoteErr.message}. Fix manually in Supabase.`,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, new_admin_id: target.id, new_admin_email: email });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Transfer failed" },
      { status: 500 }
    );
  }
}
