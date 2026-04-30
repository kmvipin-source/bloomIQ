import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * /api/admin/team — manage the BloomIQ platform admin team.
 *
 * GET    -> list current platform admins
 * POST   -> grant platform_admin to a colleague by email
 * DELETE -> revoke platform_admin from a user by id
 */

async function requireAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: me } = await sb
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .single();
  if (!me?.platform_admin) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, sb };
}

export async function GET(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ("error" in auth) return auth.error;

    const admin = supabaseAdmin();
    const { data: admins, error } = await admin
      .from("profiles")
      .select("id, full_name, platform_admin_granted_at, platform_admin_granted_by")
      .eq("platform_admin", true)
      .order("platform_admin_granted_at", { ascending: true, nullsFirst: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const { data: usersList } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const userById = new Map((usersList?.users || []).map((u) => [u.id, u]));

    const granterIds = Array.from(
      new Set((admins || []).map((a) => a.platform_admin_granted_by).filter(Boolean) as string[])
    );
    let granterNames: Map<string, string> = new Map();
    if (granterIds.length > 0) {
      const { data: granters } = await admin
        .from("profiles")
        .select("id, full_name")
        .in("id", granterIds);
      granterNames = new Map(
        (granters || []).map((g) => [g.id, g.full_name || (userById.get(g.id)?.email ?? "—")])
      );
    }

    const rows = (admins || []).map((a) => {
      const u = userById.get(a.id);
      return {
        id: a.id,
        full_name: a.full_name || null,
        email: u?.email || null,
        granted_at: a.platform_admin_granted_at || null,
        granted_by_id: a.platform_admin_granted_by || null,
        granted_by_name: a.platform_admin_granted_by
          ? granterNames.get(a.platform_admin_granted_by) || null
          : null,
        is_bootstrap: !a.platform_admin_granted_at,
      };
    });

    return NextResponse.json({ ok: true, admins: rows, current_user_id: auth.user.id });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "List failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ("error" in auth) return auth.error;

    const body = await req.json().catch(() => ({}));
    const email: string = String(body.email || "").trim().toLowerCase();
    const fullNameHint: string = String(body.full_name || "").trim();
    if (!email) return NextResponse.json({ error: "Email is required" }, { status: 400 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "That email doesn't look right." }, { status: 400 });
    }
    if (email.endsWith("@bloomiq.invalid")) {
      return NextResponse.json(
        { error: "That email belongs to a synthetic school-student account, not a real inbox." },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();
    const { data: usersList, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
    let target = usersList.users.find((u) => u.email?.toLowerCase() === email);

    let invited = false;
    if (!target) {
      const origin =
        req.headers.get("origin") ||
        req.headers.get("referer")?.replace(/\/[^/]*$/, "") ||
        new URL(req.url).origin;
      const redirectTo = `${origin.replace(/\/$/, "")}/auth/set-password?next=/admin/onboard-school`;
      const { data: inv, error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { role: "teacher", full_name: fullNameHint || email.split("@")[0] },
        redirectTo,
      });
      if (invErr || !inv?.user) {
        return NextResponse.json(
          { error: `Could not invite: ${invErr?.message || "unknown error"}` },
          { status: 500 }
        );
      }
      target = inv.user;
      invited = true;
    }

    // Strategy: UPDATE the flag fields only. profiles.role is NOT NULL so we
    // cannot use upsert (the proposed INSERT row fails the constraint even
    // when ON CONFLICT would have turned it into an UPDATE). If 0 rows
    // match, fall back to a full INSERT with role='teacher'.
    const { data: updRows, error: updErr } = await admin
      .from("profiles")
      .update({
        platform_admin: true,
        platform_admin_granted_at: new Date().toISOString(),
        platform_admin_granted_by: auth.user.id,
        ...(fullNameHint ? { full_name: fullNameHint } : {}),
      })
      .eq("id", target.id)
      .select("id");
    if (updErr) {
      return NextResponse.json(
        { error: `Could not set flag: ${updErr.message}` },
        { status: 500 }
      );
    }

    if (!updRows || updRows.length === 0) {
      const { error: insErr } = await admin
        .from("profiles")
        .insert({
          id: target.id,
          role: "teacher",
          full_name: fullNameHint || target.email || null,
          platform_admin: true,
          platform_admin_granted_at: new Date().toISOString(),
          platform_admin_granted_by: auth.user.id,
        });
      if (insErr) {
        return NextResponse.json(
          { error: `Could not create profile + set flag: ${insErr.message}` },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      ok: true,
      user_id: target.id,
      email: target.email,
      invited,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Grant failed" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ("error" in auth) return auth.error;

    const body = await req.json().catch(() => ({}));
    const userId: string = String(body.user_id || "").trim();
    if (!userId) return NextResponse.json({ error: "user_id is required" }, { status: 400 });

    if (userId === auth.user.id) {
      return NextResponse.json(
        {
          error:
            "You can't revoke your own admin access. Ask another admin to do it for you.",
        },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();

    const { count } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("platform_admin", true);
    if ((count || 0) <= 1) {
      return NextResponse.json(
        { error: "Can't revoke the last admin. Add another admin first." },
        { status: 400 }
      );
    }

    const { error } = await admin
      .from("profiles")
      .update({
        platform_admin: false,
        platform_admin_granted_at: null,
        platform_admin_granted_by: null,
      })
      .eq("id", userId)
      .eq("platform_admin", true);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Revoke failed" },
      { status: 500 }
    );
  }
}
