import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST → add an existing teacher account to the Admin Head's school.
 * Body: { email: string }
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Caller must be the Admin Head (super_teacher) with a school
    const { data: me } = await sb.from("profiles").select("role, school_id").eq("id", user.id).single();
    if (!me || me.role !== "super_teacher") {
      return NextResponse.json({ error: "Only the Admin Head can do this." }, { status: 403 });
    }
    if (!me.school_id) {
      return NextResponse.json({ error: "Set up your school first." }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const email: string = String(body.email || "").trim().toLowerCase();
    if (!email) return NextResponse.json({ error: "Email is required" }, { status: 400 });

    const admin = supabaseAdmin();
    const { data: usersList, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
    const u = usersList.users.find((x) => x.email?.toLowerCase() === email);
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
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: me } = await sb.from("profiles").select("role, school_id").eq("id", user.id).single();
    if (!me || me.role !== "super_teacher" || !me.school_id) {
      return NextResponse.json({ error: "Only the Admin Head can do this." }, { status: 403 });
    }

    const admin = supabaseAdmin();
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

    // Fetch emails for those user_ids. listUsers paginates; for the
    // sizes we expect here (a few dozen teachers per school) one page
    // is plenty. If any school grows past 1000 teachers, this would
    // need a paged loop.
    const { data: usersList, error: uErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });
    const emailById = new Map<string, string | null>();
    for (const u of usersList.users) emailById.set(u.id, u.email ?? null);

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
 */
export async function DELETE(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: me } = await sb.from("profiles").select("role, school_id").eq("id", user.id).single();
    if (!me || me.role !== "super_teacher" || !me.school_id) {
      return NextResponse.json({ error: "Not authorised" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const teacherId: string = String(body.teacher_id || "").trim();
    if (!teacherId) return NextResponse.json({ error: "teacher_id is required" }, { status: 400 });

    const admin = supabaseAdmin();
    const { error } = await admin.from("profiles").update({ school_id: null }).eq("id", teacherId).eq("school_id", me.school_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
