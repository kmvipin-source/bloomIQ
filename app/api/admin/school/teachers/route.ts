import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

// In-memory email index, lazy-built on first miss. Supabase's
// listUsers() only returns one page at a time; the previous code
// requested page 1 with perPage:1000 and assumed every account fit on
// it, silently mis-resolving emails for any tenant past 1000 users.
// We page through until we find the requested email, then cache the
// result for the rest of the function instance. Lives for as long as
// the Vercel function instance survives — good enough; misses re-page.
async function findUserByEmail(
  admin: ReturnType<typeof supabaseAdmin>,
  email: string
): Promise<{ id: string; email?: string | null } | null> {
  const target = email.toLowerCase();
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = (data.users as Array<{ id: string; email?: string | null }>) || [];
    const hit = users.find((u) => (u.email || "").toLowerCase() === target);
    if (hit) return hit;
    if (users.length < perPage) return null; // no more pages
  }
  return null;
}

/**
 * POST → add an existing teacher account to the Admin Head's school.
 * Body: { email: string }
 */
export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const admin = supabaseAdmin();
    // Caller-role lookup uses service-role to avoid the RLS race that
    // affects /api/school/digest and /api/school/coach when the
    // dashboard probes a freshly-logged-in head.
    const { data: me } = await admin.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
    if (!me || me.role !== "super_teacher") {
      return NextResponse.json({ error: "Only the Admin Head can do this." }, { status: 403 });
    }
    if (!me.school_id) {
      return NextResponse.json({ error: "Set up your school first." }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const email: string = String(body.email || "").trim().toLowerCase();
    if (!email) return NextResponse.json({ error: "Email is required" }, { status: 400 });

    const u = await findUserByEmail(admin, email);
    if (!u) {
      return NextResponse.json({ error: "No account with that email. Ask them to sign up first." }, { status: 404 });
    }

    const { data: prof } = await admin.from("profiles").select("role, school_id").eq("id", u.id).maybeSingle();
    if (!prof || prof.role !== "teacher") {
      return NextResponse.json({ error: "That account isn't a teacher." }, { status: 400 });
    }
    if (prof.school_id && prof.school_id !== me.school_id) {
      return NextResponse.json({ error: "That teacher already belongs to another school." }, { status: 409 });
    }

    const { error: uErr } = await admin.from("profiles").update({ school_id: me.school_id }).eq("id", u.id);
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

/**
 * GET → list teachers in the Admin Head's school, including email.
 * Email isn't stored on `profiles` (it lives on auth.users), so we
 * read it via the service-role admin client and join in memory.
 *
 * Returns: { teachers: Array<{ id, full_name, email }> }
 */
export async function GET(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const admin = supabaseAdmin();
    const { data: me } = await admin.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
    if (!me || me.role !== "super_teacher" || !me.school_id) {
      return NextResponse.json({ error: "Only the Admin Head can do this." }, { status: 403 });
    }

    // Pull every teacher AND super-teacher in this school. Including
    // super_teacher rows lets the /school/teachers page render the Admin
    // Head + Deputies in the same roster (the page filters them into
    // their own bucket via t.role).
    const { data: profs, error: pErr } = await admin
      .from("profiles")
      .select("id, full_name, role")
      .eq("school_id", me.school_id)
      .in("role", ["teacher", "super_teacher"]);
    if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });
    const profList = ((profs as Array<{ id: string; full_name: string | null; role: string }>) || []);

    if (profList.length === 0) {
      return NextResponse.json({ teachers: [] });
    }

    // Fetch emails by id. getUserById is O(1) and avoids the listUsers
    // pagination trap that capped us at 1000 users globally.
    const emailById = new Map<string, string | null>();
    await Promise.all(
      profList.map(async (p) => {
        try {
          const { data } = await admin.auth.admin.getUserById(p.id);
          emailById.set(p.id, data.user?.email ?? null);
        } catch {
          emailById.set(p.id, null);
        }
      })
    );

    const teachers = profList.map((p) => ({
      id: p.id,
      full_name: p.full_name,
      role: p.role,
      email: emailById.get(p.id) ?? null,
    }));
    return NextResponse.json({ teachers });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

/**
 * DELETE → remove a teacher from the school.
 * Body: { teacher_id: string }
 *
 * Refuses to demote a super_teacher (Head or Deputy) — they must go
 * through the Transfer Admin Head flow or be demoted by the canonical
 * Head first. Refuses to remove the canonical Head outright because
 * that would orphan the school (schools.super_teacher_id would point
 * at a profile with no school_id).
 */
export async function DELETE(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const admin = supabaseAdmin();
    const { data: me } = await admin.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
    if (!me || me.role !== "super_teacher" || !me.school_id) {
      return NextResponse.json({ error: "Not authorised" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const teacherId: string = String(body.teacher_id || "").trim();
    if (!teacherId) return NextResponse.json({ error: "teacher_id is required" }, { status: 400 });

    // Block the orphan-school case: removing the Head themselves
    // would leave schools.super_teacher_id pointing at a school-less
    // profile, and no UI path would let anyone reclaim the school.
    const { data: school } = await admin
      .from("schools")
      .select("super_teacher_id")
      .eq("id", me.school_id)
      .maybeSingle();
    if ((school as { super_teacher_id?: string | null } | null)?.super_teacher_id === teacherId) {
      return NextResponse.json(
        { error: "Use Transfer Admin Head to move this role to someone else first." },
        { status: 400 }
      );
    }

    // Block silently demoting a Deputy through this endpoint. The
    // /school/teachers UI exposes a dedicated demote flow that walks
    // through the consequences. Removing a Deputy via the generic
    // teacher-delete here would skip that confirmation.
    const { data: targetProf } = await admin
      .from("profiles")
      .select("role")
      .eq("id", teacherId)
      .maybeSingle();
    if ((targetProf as { role?: string } | null)?.role === "super_teacher") {
      return NextResponse.json(
        { error: "This account is an Admin (Head or Deputy). Demote it first via the Promote/Demote flow." },
        { status: 400 }
      );
    }

    const { error } = await admin.from("profiles").update({ school_id: null }).eq("id", teacherId).eq("school_id", me.school_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
