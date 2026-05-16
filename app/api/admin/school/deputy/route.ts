import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

// F56 note (QA): hardcoded cap of 2 deputies per school. Enterprise
// pilots have asked for 4. Path forward: add plans.max_deputies (nullable
// = use default 2), then look it up via the school's bound plan. Until
// that ships, keep this constant — it's intentional for the v1 launch.
const DEPUTY_CAP = 2;
// F72 note (QA): the deputy promote/demote endpoint deliberately reserves
// the right to manage deputies to the Admin Head only. Lifting the
// schools.super_teacher_id check below would allow deputy-vs-deputy
// power struggles — leave the gate in place.

/**
 * POST /api/admin/school/deputy
 *
 * Promote a teacher to Deputy Admin Head, or demote a Deputy back to teacher.
 *
 * Body:
 *   { teacher_id: string, action: "promote" | "demote" }
 *
 * Auth: caller must be the Head of the school (the profile referenced by
 * schools.super_teacher_id). Deputies cannot promote/demote other Deputies
 * — that power is reserved for the Head, by design, to avoid "deputies fight
 * each other" scenarios.
 *
 * Promote:
 *   - Target must currently be role='teacher' AND school_id = my school.
 *   - Current Deputy count must be < DEPUTY_CAP (2). The cap is intentional:
 *     more Deputies = more diluted accountability, and 2 is enough for
 *     redundancy in any normally-staffed school.
 *   - Effect: target.role = 'super_teacher'. school_id stays. They appear in
 *     Sidebar with the same dashboard as the Head, and can do anything the
 *     Head can do EXCEPT this endpoint and /api/admin/school/transfer.
 *
 * Demote:
 *   - Target must currently be role='super_teacher' AND school_id = my school
 *     AND NOT bound as the Head (schools.super_teacher_id ≠ them).
 *   - Effect: target.role = 'teacher'. They keep their class_teachers rows
 *     and quizzes — only the school-admin powers go away.
 *   - The Head cannot demote themselves through this endpoint (that's what
 *     /api/admin/school/transfer is for; it requires naming a successor).
 */
export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const body = await req.json().catch(() => ({}));
    const teacherId = String(body?.teacher_id || "").trim();
    const action = String(body?.action || "").trim() as "promote" | "demote";
    if (!teacherId) return NextResponse.json({ error: "Missing teacher_id." }, { status: 400 });
    if (action !== "promote" && action !== "demote") {
      return NextResponse.json({ error: "action must be 'promote' or 'demote'." }, { status: 400 });
    }

    const admin = supabaseAdmin();

    // ---- Authorization: caller must be the Head of *some* school ----
    const { data: me } = await admin
      .from("profiles")
      .select("id, role, school_id")
      .eq("id", user.id)
      .maybeSingle();
    if (!me || me.role !== "super_teacher" || !me.school_id) {
      return NextResponse.json(
        { error: "Only school admins can manage deputies." },
        { status: 403 }
      );
    }

    const { data: mySchool } = await admin
      .from("schools")
      .select("id, super_teacher_id, name")
      .eq("id", me.school_id)
      .maybeSingle();
    if (!mySchool) {
      return NextResponse.json({ error: "Your school could not be located." }, { status: 404 });
    }
    if (mySchool.super_teacher_id !== user.id) {
      return NextResponse.json(
        { error: "Only the Admin Head can promote or demote deputies." },
        { status: 403 }
      );
    }

    // ---- Target must be in this school ----
    const { data: target } = await admin
      .from("profiles")
      .select("id, role, school_id, full_name")
      .eq("id", teacherId)
      .maybeSingle();
    if (!target) return NextResponse.json({ error: "Teacher not found." }, { status: 404 });
    if (target.school_id !== me.school_id) {
      return NextResponse.json(
        { error: "That teacher isn't in your school." },
        { status: 400 }
      );
    }
    if (target.id === user.id) {
      return NextResponse.json(
        { error: "You can't change your own role here. Use Transfer Admin Head to step down." },
        { status: 400 }
      );
    }

    if (action === "promote") {
      if (target.role !== "teacher") {
        return NextResponse.json(
          { error: "Only regular teachers can be promoted. Already a deputy or admin." },
          { status: 400 }
        );
      }
      // Cap check — exclude the Head when counting deputies.
      const { data: existing } = await admin
        .from("profiles")
        .select("id")
        .eq("school_id", me.school_id)
        .eq("role", "super_teacher");
      const deputyCount = ((existing as Array<{ id: string }>) || []).filter(
        (r) => r.id !== mySchool.super_teacher_id
      ).length;
      if (deputyCount >= DEPUTY_CAP) {
        return NextResponse.json(
          {
            error: `Your school already has ${DEPUTY_CAP} deputies. Demote one before promoting another.`,
          },
          { status: 409 }
        );
      }
      const { error: promErr } = await admin
        .from("profiles")
        .update({ role: "super_teacher" })
        .eq("id", target.id);
      if (promErr) return NextResponse.json({ error: promErr.message }, { status: 500 });
      return NextResponse.json({
        ok: true,
        action: "promoted",
        teacher_id: target.id,
        full_name: target.full_name,
      });
    }

    // action === "demote"
    if (target.role !== "super_teacher") {
      return NextResponse.json(
        { error: "That teacher isn't a deputy." },
        { status: 400 }
      );
    }
    if (target.id === mySchool.super_teacher_id) {
      // The Head can't be demoted via this endpoint — they'd leave the
      // school without an admin. /api/admin/school/transfer handles
      // succession explicitly.
      return NextResponse.json(
        { error: "The Admin Head can't be demoted here. Use Transfer Admin Head." },
        { status: 400 }
      );
    }
    const { error: demErr } = await admin
      .from("profiles")
      .update({ role: "teacher" })
      .eq("id", target.id);
    if (demErr) return NextResponse.json({ error: demErr.message }, { status: 500 });
    return NextResponse.json({
      ok: true,
      action: "demoted",
      teacher_id: target.id,
      full_name: target.full_name,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/admin/school/deputy
 *
 * List the school's Head + Deputies for the dashboard. Caller must be a
 * super_teacher (Head or Deputy) in the school.
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
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const { data: school } = await admin
      .from("schools")
      .select("id, super_teacher_id")
      .eq("id", me.school_id)
      .maybeSingle();
    if (!school) return NextResponse.json({ error: "School not found" }, { status: 404 });

    const { data: admins } = await admin
      .from("profiles")
      .select("id, full_name")
      .eq("school_id", me.school_id)
      .eq("role", "super_teacher");
    const list = ((admins as Array<{ id: string; full_name: string | null }>) || []).map((a) => ({
      id: a.id,
      full_name: a.full_name,
      is_head: a.id === school.super_teacher_id,
    }));
    return NextResponse.json({
      head_id: school.super_teacher_id,
      caller_is_head: school.super_teacher_id === user.id,
      admins: list,
      cap: DEPUTY_CAP,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
