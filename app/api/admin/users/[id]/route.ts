import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * PATCH /api/admin/users/[id]
 * Body: { full_name?, role?, is_school_student?, platform_admin? }
 *
 * Edit any user from the platform-admin console. Role changes are
 * destructive enough that the caller is expected to have read the
 * downstream consequences (e.g. demoting a super_teacher of a school
 * leaves the school admin-less). This endpoint does not enforce those
 * invariants — it is the platform admin's responsibility.
 *
 * DELETE /api/admin/users/[id]
 *
 * Fully delete a user — auth.users row + profiles row (cascades take
 * care of class memberships, attempts, quizzes, etc., per the FK
 * definitions). Only platform admins. Cannot delete yourself.
 */

const ALLOWED_ROLES = new Set(["student", "teacher", "super_teacher", "platform_admin"]);

async function requirePlatformAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
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

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;
    const { admin } = auth;

    const { id } = await params;
    if (!id) return NextResponse.json({ error: "Missing user id" }, { status: 400 });

    const body = await req.json().catch(() => ({}));
    const patch: Record<string, unknown> = {};

    if (typeof body.full_name === "string") {
      patch.full_name = body.full_name.trim() || null;
    }
    if (typeof body.role === "string") {
      const role = body.role.trim();
      if (!ALLOWED_ROLES.has(role)) {
        return NextResponse.json({ error: `Invalid role: ${role}` }, { status: 400 });
      }
      patch.role = role;
    }
    if (typeof body.is_school_student === "boolean") {
      patch.is_school_student = body.is_school_student;
    }
    if (typeof body.platform_admin === "boolean") {
      patch.platform_admin = body.platform_admin;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const { error } = await admin.from("profiles").update(patch).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;
    const { user: caller, admin } = auth;

    const { id } = await params;
    if (!id) return NextResponse.json({ error: "Missing user id" }, { status: 400 });
    if (id === caller.id) {
      return NextResponse.json(
        { error: "You can't delete your own account from here." },
        { status: 400 }
      );
    }

    // Profiles row is wiped first so the FK cascades on app tables
    // (class_members, class_teachers, quizzes, etc.) fire before we
    // remove the auth user. Then drop auth.users itself.
    const { error: pErr } = await admin.from("profiles").delete().eq("id", id);
    if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });
    const { error: aErr } = await admin.auth.admin.deleteUser(id);
    if (aErr) return NextResponse.json({ error: aErr.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
