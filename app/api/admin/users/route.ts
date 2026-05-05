import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/admin/users
 *
 * Returns every user on the platform — id, email, full_name, role,
 * is_school_student, platform_admin, school_id, school_name, created_at.
 * Restricted to platform_admin callers.
 *
 * Used by /admin/users to power role-grouped tables with edit + delete
 * actions across the entire user base.
 */

async function requirePlatformAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  // Use the service role to read platform_admin to dodge any RLS race
  // on profiles for callers whose JWT is fresh on the edge.
  const admin = supabaseAdmin();
  const { data: me } = await admin
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!me?.platform_admin) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, admin };
}

export async function GET(req: Request) {
  try {
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;
    const { admin } = auth;

    // Pull profiles + schools in one round trip; resolve emails from
    // auth.users via the admin API. listUsers paginates at 1000 — fine
    // for now; if the user base grows past that we'll page here.
    const [{ data: profs, error: pErr }, { data: schools }] = await Promise.all([
      admin
        .from("profiles")
        .select("id, full_name, role, is_school_student, platform_admin, school_id, created_at")
        .order("created_at", { ascending: false }),
      admin.from("schools").select("id, name"),
    ]);
    if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });

    const schoolNameById = new Map<string, string>();
    ((schools as Array<{ id: string; name: string }> | null) || [])
      .forEach((s) => schoolNameById.set(s.id, s.name));

    const { data: usersList, error: uErr } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });
    const emailById = new Map<string, string | null>();
    for (const u of usersList.users) emailById.set(u.id, u.email ?? null);

    type ProfRow = {
      id: string;
      full_name: string | null;
      role: string | null;
      is_school_student: boolean | null;
      platform_admin: boolean | null;
      school_id: string | null;
      created_at: string | null;
    };
    const users = ((profs as ProfRow[] | null) || []).map((p) => ({
      id: p.id,
      full_name: p.full_name,
      email: emailById.get(p.id) ?? null,
      role: p.role,
      is_school_student: !!p.is_school_student,
      platform_admin: !!p.platform_admin,
      school_id: p.school_id,
      school_name: p.school_id ? (schoolNameById.get(p.school_id) ?? null) : null,
      created_at: p.created_at,
    }));

    return NextResponse.json({ ok: true, users });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
