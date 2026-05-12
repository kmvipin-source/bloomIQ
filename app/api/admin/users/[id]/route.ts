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

// User-management surface only handles students + teachers. Promotions to
// super_teacher (school admin) live behind /school's Transfer Admin Head
// flow; promotions to platform_admin live behind /admin/team. Refuse to
// touch those roles from this endpoint to avoid an accidental demotion
// that orphans a school or locks the platform admin team.
const ALLOWED_ROLES = new Set(["student", "teacher"]);
const PROTECTED_ROLES = new Set(["super_teacher", "platform_admin"]);

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

    // Verify target is a student or teacher (not a school admin or
    // platform admin). The /admin/users surface deliberately excludes
    // those two — they have dedicated management flows.
    const { data: target } = await admin
      .from("profiles")
      .select("role, platform_admin")
      .eq("id", id)
      .maybeSingle();
    if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });
    if (target.platform_admin || PROTECTED_ROLES.has(target.role || "")) {
      return NextResponse.json(
        { error: "Use /admin/team or /school to manage school / platform admins." },
        { status: 403 }
      );
    }

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
    if (typeof body.is_test_account === "boolean") {
      patch.is_test_account = body.is_test_account;
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

    // Refuse to delete school admins or platform admins from this
    // surface — same reasoning as PATCH above.
    const { data: target } = await admin
      .from("profiles")
      .select("role, platform_admin")
      .eq("id", id)
      .maybeSingle();
    if (target?.platform_admin || PROTECTED_ROLES.has(target?.role || "")) {
      return NextResponse.json(
        { error: "Use /admin/team or /school to manage school / platform admins." },
        { status: 403 }
      );
    }

    // Delete the auth.users row first so the on-cascade FK from
    // profiles wipes the profile row in the same transaction. The
    // previous order (profiles first, then auth) left an orphan
    // auth.users entry if the second delete failed — no profile to
    // join against, but the email/UUID was still consumed and could
    // not be reused. Switching the order makes the operation
    // effectively atomic at the DB level.
    const { error: aErr } = await admin.auth.admin.deleteUser(id);
    if (aErr) return NextResponse.json({ error: aErr.message }, { status: 500 });
    // Belt + suspenders: if for any reason the cascade didn't wipe
    // the profile row, do it now. Best-effort — ignore errors.
    await admin.from("profiles").delete().eq("id", id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
