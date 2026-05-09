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

    // Service-role read avoids the RLS race that 403'd legit platform
    // admins on the Vercel edge.
    const adminClient = supabaseAdmin();
    const { data: me } = await adminClient
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .maybeSingle();
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

    // ---------- 8) Optional: bind a plan immediately ----------
    // The onboard form may include plan_id so the platform admin can
    // pick the school's plan in the same step instead of going down to
    // the recent-onboardings dropdown afterwards. We accept it as
    // optional — if missing or invalid, the school is still created
    // and the admin can set the plan later from the list.
    let boundPlan: { id: string; label: string; tier: string } | null = null;
    const requestedPlanId: string | null = (body.plan_id ?? null) || null;
    if (requestedPlanId) {
      const { data: plan } = await admin
        .from("plans")
        .select("id, label, tier, period_days")
        .eq("id", requestedPlanId)
        .maybeSingle();
      if (plan) {
        const legacyTier =
          plan.tier === "school_plus" ? "premium_plus"
          : plan.tier.startsWith("school_") ? "premium"
          : plan.tier;
        const expiresAt = new Date(Date.now() + plan.period_days * 24 * 60 * 60 * 1000).toISOString();
        const { error: subErr } = await admin
          .from("subscriptions")
          .insert({
            school_id: school.id,
            user_id: null,
            plan_id: plan.id,
            tier: legacyTier,
            status: "active",
            started_at: new Date().toISOString(),
            expires_at: expiresAt,
          });
        if (!subErr) {
          boundPlan = { id: plan.id, label: plan.label, tier: plan.tier };
        }
        // Soft-fail intentionally — we don't want to roll back the whole
        // school creation just because the plan binding hiccuped. The
        // platform admin can pick a plan from the list dropdown.
      }
    }

    return NextResponse.json({
      ok: true,
      school_id: school.id,
      school_name: school.name,
      join_code: school.join_code,
      admin_user_id: newAdminUserId,
      admin_email: adminEmail,
      bound_plan: boundPlan,
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

    // Read platform_admin via the service-role client so a transient
    // RLS race on profiles (the user-token client occasionally can't
    // see the just-created profile row from the Vercel edge) doesn't
    // 403 a real platform admin off their own page.
    const admin = supabaseAdmin();
    const { data: me } = await admin
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .maybeSingle();
    if (!me?.platform_admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
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

    // Pull current school subscriptions in one query so we can join in
    // each school's plan_id without a per-school round trip. School
    // subscriptions are keyed by school_id (not user_id), so this is the
    // authoritative bind point used by useFeatureAccess for school students.
    const schoolIds = (schools || []).map((s) => s.id);
    const planBySchool = new Map<string, {
      plan_id: string | null;
      plan_label: string | null;
      plan_tier: string | null;
      expires_at: string | null;
    }>();
    if (schoolIds.length > 0) {
      const { data: subs } = await admin
        .from("subscriptions")
        .select("school_id, plan_id, expires_at, plan:plans!subscriptions_plan_id_fkey(label, tier)")
        .in("school_id", schoolIds)
        .eq("status", "active");
      type SubRow = {
        school_id: string;
        plan_id: string | null;
        expires_at: string | null;
        plan: { label: string | null; tier: string | null } | null;
      };
      for (const s of (subs as unknown as SubRow[]) || []) {
        planBySchool.set(s.school_id, {
          plan_id: s.plan_id,
          plan_label: s.plan?.label ?? null,
          plan_tier: s.plan?.tier ?? null,
          expires_at: s.expires_at,
        });
      }
    }

    // Available school plans for the inline dropdown — every catalogue
    // row whose tier starts with school_*. Returned alongside the schools
    // so the UI can render the selector without a second fetch.
    const { data: schoolPlans } = await admin
      .from("plans")
      .select("id, slug, tier, label")
      .like("tier", "school_%")
      .order("tier", { ascending: true });

    // Derive expiry status the same way every admin surface does:
    //   active   = expiry > 30 days away
    //   expiring = expiry within next 30 days (warn the operator)
    //   expired  = expiry already past
    //   null     = no plan / no expiry recorded
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    function expiryStatus(iso: string | null): "active" | "expiring" | "expired" | null {
      if (!iso) return null;
      const t = new Date(iso).getTime();
      if (Number.isNaN(t)) return null;
      const days = Math.round((t - now) / DAY);
      if (days < 0) return "expired";
      if (days <= 30) return "expiring";
      return "active";
    }

    const rows = (schools || []).map((s) => {
      const confirmedAt = s.super_teacher_id ? confirmedById.get(s.super_teacher_id) || null : null;
      const sub = planBySchool.get(s.id);
      return {
        id: s.id,
        name: s.name,
        join_code: s.join_code,
        admin_email: s.invited_admin_email,
        invited_at: s.invited_at,
        accepted_at: confirmedAt,
        status: confirmedAt ? "accepted" : "pending",
        current_plan_id: sub?.plan_id ?? null,
        current_plan_label: sub?.plan_label ?? null,
        current_plan_tier: sub?.plan_tier ?? null,
        expires_at: sub?.expires_at ?? null,
        expiry_status: expiryStatus(sub?.expires_at ?? null),
      };
    });

    return NextResponse.json({
      ok: true,
      schools: rows,
      available_school_plans: schoolPlans || [],
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "List failed" },
      { status: 500 }
    );
  }
}
