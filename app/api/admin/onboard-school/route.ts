import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { generateQuizCode } from "@/lib/utils";

export const runtime = "nodejs";

/**
 * POST /api/admin/onboard-school
 *
 * Provision a new school + invite its Admin Head by email. Used after a
 * paying school has been signed (manual flow today; can be wired to a
 * payment webhook later for full self-serve).
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: me } = await sb
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .single();
    if (!me?.platform_admin) {
      return NextResponse.json(
        { error: "Only platform admins can onboard schools." },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const schoolName: string = String(body.school_name || "").trim();
    const adminEmail: string = String(body.admin_email || "").trim().toLowerCase();
    const adminFullName: string = String(body.admin_full_name || "").trim();

    if (!schoolName) return NextResponse.json({ error: "School name is required." }, { status: 400 });
    if (!adminEmail) return NextResponse.json({ error: "Admin Head email is required." }, { status: 400 });
    if (!adminFullName) return NextResponse.json({ error: "Admin Head full name is required." }, { status: 400 });
    if (adminEmail.endsWith("@bloomiq.invalid")) {
      return NextResponse.json(
        { error: "That email belongs to a synthetic school-student account, not a real inbox." },
        { status: 400 }
      );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
      return NextResponse.json({ error: "That email doesn't look right." }, { status: 400 });
    }

    const admin = supabaseAdmin();

    const { data: usersList, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
    const existing = usersList.users.find((u) => u.email?.toLowerCase() === adminEmail);
    if (existing) {
      return NextResponse.json(
        {
          error:
            "An account with this email already exists. Ask the user to log in with their existing account, " +
            "or transfer the Admin Head role from inside the school dashboard.",
        },
        { status: 409 }
      );
    }

    let joinCode = generateQuizCode();
    for (let i = 0; i < 5; i++) {
      const { data: clash } = await admin
        .from("schools")
        .select("id")
        .eq("join_code", joinCode)
        .maybeSingle();
      if (!clash) break;
      joinCode = generateQuizCode();
    }

    // Invite links auto-authenticate but DO NOT set a password. Route through
    // /auth/set-password so the Admin Head picks a real password before
    // landing on /school.
    const origin =
      req.headers.get("origin") ||
      req.headers.get("referer")?.replace(/\/[^/]*$/, "") ||
      new URL(req.url).origin;
    const redirectTo = `${origin.replace(/\/$/, "")}/auth/set-password?next=/school`;

    const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
      adminEmail,
      {
        data: {
          role: "super_teacher",
          full_name: adminFullName,
        },
        redirectTo,
      }
    );
    if (inviteErr || !invited?.user) {
      return NextResponse.json(
        { error: `Could not send invite: ${inviteErr?.message || "unknown error"}` },
        { status: 500 }
      );
    }
    const newAdminUserId = invited.user.id;

    const { data: school, error: schoolErr } = await admin
      .from("schools")
      .insert({
        name: schoolName,
        super_teacher_id: newAdminUserId,
        join_code: joinCode,
        invited_admin_email: adminEmail,
        invited_at: new Date().toISOString(),
        onboarded_by: user.id,
      })
      .select()
      .single();
    if (schoolErr || !school) {
      try { await admin.auth.admin.deleteUser(newAdminUserId); } catch { /* ignore */ }
      return NextResponse.json(
        { error: `Could not create school row: ${schoolErr?.message || "unknown error"}` },
        { status: 500 }
      );
    }

    const { error: profErr } = await admin
      .from("profiles")
      .update({ school_id: school.id, school: schoolName })
      .eq("id", newAdminUserId);
    if (profErr) {
      return NextResponse.json(
        {
          ok: true,
          warning:
            `Invite sent and school created, but linking the profile failed: ${profErr.message}. ` +
            `Set profiles.school_id = ${school.id} on user ${newAdminUserId} in Supabase.`,
          school_id: school.id,
          admin_user_id: newAdminUserId,
        },
        { status: 200 }
      );
    }

    return NextResponse.json({
      ok: true,
      school_id: school.id,
      school_name: school.name,
      join_code: school.join_code,
      admin_user_id: newAdminUserId,
      admin_email: adminEmail,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Onboard failed" },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: me } = await sb
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .single();
    if (!me?.platform_admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const admin = supabaseAdmin();
    const { data: schools, error } = await admin
      .from("schools")
      .select("id, name, join_code, invited_admin_email, invited_at, super_teacher_id, created_at, onboarded_by")
      .not("invited_admin_email", "is", null)
      .order("invited_at", { ascending: false })
      .limit(50);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const { data: usersList } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const confirmedById = new Map<string, string | null>(
      (usersList?.users || []).map((u) => [u.id, u.email_confirmed_at || u.confirmed_at || null])
    );

    const rows = (schools || []).map((s) => {
      const confirmedAt = s.super_teacher_id ? confirmedById.get(s.super_teacher_id) || null : null;
      return {
        id: s.id,
        name: s.name,
        join_code: s.join_code,
        admin_email: s.invited_admin_email,
        invited_at: s.invited_at,
        accepted_at: confirmedAt,
        status: confirmedAt ? "accepted" : "pending",
      };
    });

    return NextResponse.json({ ok: true, schools: rows });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "List failed" },
      { status: 500 }
    );
  }
}
