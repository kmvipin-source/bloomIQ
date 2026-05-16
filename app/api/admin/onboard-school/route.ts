import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin, SCHOOL_STUDENT_DOMAIN } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";
import { generateQuizCode } from "@/lib/utils";

// Paged email lookup. listUsers({page:1, perPage:1000}) silently mis-
// resolved emails past 1000 users; paginate until found.
// F54 note (QA): findUserByEmail paginates auth.users at 1000-per-page
// looking for a match. At small school counts this is fine; at >10k auth
// users the cost climbs linearly. Replace with a single email-filtered
// admin.listUsers({ filter: `email.eq.${e}` }) call when Supabase ships
// it (the gotrue admin API is in beta), or move to a profiles.email
// lookup if profiles.email is kept in sync.
async function findUserByEmail(
  admin: ReturnType<typeof supabaseAdmin>,
  email: string
): Promise<{ id: string; email?: string | null } | null> {
  // F73 fix: per-RFC 5321 the local-part is case-sensitive, but every
  // mainstream provider treats it case-insensitively. Document the
  // assumption so a future reader doesn't try to "fix" the lowercasing.
  const target = email.toLowerCase();
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = (data.users as Array<{ id: string; email?: string | null }>) || [];
    const hit = users.find((u) => (u.email || "").toLowerCase() === target);
    if (hit) return hit;
    if (users.length < perPage) return null;
  }
  return null;
}

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
    // F171 fix (QA): inline platform_admin check → shared helper.
    // The "Only platform admins can onboard schools." copy is replaced
    // with the helper's generic "Forbidden" — acceptable because the
    // operator-facing onboard UI surfaces its own auth-error toast.
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;
    const { user } = auth;
    const adminClient = supabaseAdmin();

    const body = await req.json().catch(() => ({}));
    const schoolName: string = String(body.school_name || "").trim();
    const adminEmail: string = String(body.admin_email || "").trim().toLowerCase();
    const adminFullName: string = String(body.admin_full_name || "").trim();

    if (!schoolName) return NextResponse.json({ error: "School name is required." }, { status: 400 });
    if (!adminEmail) return NextResponse.json({ error: "Admin Head email is required." }, { status: 400 });
    if (!adminFullName) return NextResponse.json({ error: "Admin Head full name is required." }, { status: 400 });
    if (adminEmail.endsWith(`@${SCHOOL_STUDENT_DOMAIN}`)) {
      return NextResponse.json(
        { error: "That email belongs to a synthetic school-student account, not a real inbox." },
        { status: 400 }
      );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
      return NextResponse.json({ error: "That email doesn't look right." }, { status: 400 });
    }

    const admin = supabaseAdmin();

    const existing = await findUserByEmail(admin, adminEmail);
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

    // F55 fix: 10 attempts + explicit failure. Previous 5-attempt loop
    // silently used the last colliding code on exhaustion, surfacing as
    // a confusing PG unique-violation 500.
    let joinCode = generateQuizCode();
    let joinCodeFound = false;
    for (let i = 0; i < 10; i++) {
      const { data: clash } = await admin
        .from("schools")
        .select("id")
        .eq("join_code", joinCode)
        .maybeSingle();
      if (!clash) { joinCodeFound = true; break; }
      joinCode = generateQuizCode();
    }
    if (!joinCodeFound) {
      return NextResponse.json(
        { error: "Could not generate a unique school join code after 10 attempts. Please retry." },
        { status: 503 }
      );
    }

    // Invite links auto-authenticate but DO NOT set a password. Route through
    // /auth/set-password so the Admin Head picks a real password before
    // landing on /school.
    //
    // F50 note (QA): Supabase invite links are SINGLE-USE BUT replayable
    // until consumed, and the default TTL is ~24h. For school onboarding
    // that's too generous (a forwarded invite could be claimed by anyone
    // up to a day later). Tighten the TTL in Supabase Auth → Email
    // settings → "Invite link" to 4h. This is a dashboard change, not a
    // code change, so it's flagged here as a deployment checklist item.
    // F75 fix: PUBLIC_ORIGIN env var as a higher-confidence fallback
    // than the request URL (which uses the lambda's internal host).
    const origin =
      req.headers.get("origin") ||
      req.headers.get("referer")?.replace(/\/[^/]*$/, "") ||
      process.env.PUBLIC_ORIGIN ||
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
      // F60 fix: classify common Supabase invite errors so the operator
      // gets actionable text instead of a raw passthrough.
      const raw = inviteErr?.message || "unknown error";
      const lower = raw.toLowerCase();
      let hint = "";
      if (lower.includes("rate")) hint = " (Supabase invite rate-limited — wait a minute and retry.)";
      else if (lower.includes("already") || lower.includes("registered")) hint = " (Account or pending invite already exists for that email.)";
      else if (lower.includes("ban")) hint = " (Email banned at the Supabase project level.)";
      return NextResponse.json(
        { error: `Could not send invite: ${raw}.${hint}` },
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

    // F46 fix: .update().eq() returns success on 0 rows. If the
    // handle_new_user trigger silently failed to insert a profile row,
    // this update would no-op. Force .select() and verify exactly one
    // row was touched.
    const { data: profUpdated, error: profErr } = await admin
      .from("profiles")
      .update({ school_id: school.id, school: schoolName })
      .eq("id", newAdminUserId)
      .select("id")
      .maybeSingle();
    if (profErr || !profUpdated) {
      // Compensating rollback: delete the freshly-created school + the
      // freshly-invited auth user. The previous behaviour returned
      // ok:true with a warning and left an orphan school + a Head
      // profile that had no school_id, requiring manual SQL cleanup.
      try { await admin.from("schools").delete().eq("id", school.id); } catch { /* ignore */ }
      try { await admin.auth.admin.deleteUser(newAdminUserId); } catch { /* ignore */ }
      const errMsg = profErr
        ? `Could not link profile to school: ${profErr.message}. Onboarding rolled back.`
        : "Admin Head profile was not created by the auth trigger; onboarding rolled back.";
      return NextResponse.json({ error: errMsg }, { status: 500 });
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
      // Reject non-school plans bound to a school subscription. Without
      // this guard a platform admin could attach an individual Premium
      // plan to a school's subscription row, which would skew every
      // feature gate downstream.
      if (plan && plan.tier.startsWith("school_")) {
        const legacyTier =
          plan.tier === "school_plus" ? "premium_plus"
          : "premium";
        // Honour the modern-expiry knobs from migration 65 so an
        // onboarded school's clock doesn't start the instant the
        // invite is created. Defaults match the per-school admin
        // page: activation_pending=true (clock starts on first
        // super_teacher sign-in via /api/auth/me), grace_period_days=14.
        // Operator can override either via the onboard form.
        // F61 note (QA): activation_pending defaults to TRUE when body omits
        // the field. Operator UI should make this default visible (e.g.
        // checkbox pre-checked with "Defer activation until first sign-in").
        // F51 note (QA): if plan_id is omitted at onboard time, the school
        // is created without a billing binding and the operator sees no
        // warning. Surface in the response: { warning: "no plan bound;
        // school is on Free until /admin/schools attaches one" }. Pure
        // UX cleanup — the behavior is already safe.
        // F61 note (QA): activation_pending defaults to TRUE when body omits
        // the field. Operator UI should make this default visible (e.g.
        // checkbox pre-checked with "Defer activation until first sign-in").
        const activationPending = body.activation_pending !== false;
        const gracePeriodDays = typeof body.grace_period_days === "number" && body.grace_period_days >= 0
          ? Math.round(body.grace_period_days)
          : 14;
        // F62 fix: explicit zero is ambiguous (operator may have meant
        // unlimited but the model treats 0 as null). Reject so they
        // confirm intent.
        if (typeof body.contracted_students === "number" && body.contracted_students === 0) {
          return NextResponse.json(
            { error: "contracted_students = 0 is ambiguous. Omit for unlimited, or pass a positive number." },
            { status: 400 },
          );
        }
        const contractedStudents = typeof body.contracted_students === "number" && body.contracted_students > 0
          ? Math.round(body.contracted_students)
          : null;
        // started_at: explicit value if provided (academic-year deals),
        // otherwise now() as the placeholder that first sign-in will
        // overwrite when activation_pending is true.
        let startedAt = new Date();
        if (typeof body.started_at === "string" && body.started_at.trim()) {
          const raw = body.started_at.trim();
          const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
          // F52 fix: anchor date-only inputs to UTC midnight, not IST,
          // so non-Indian deployments don't get half-day expiry skews.
          const ts = Date.parse(isDateOnly ? `${raw}T00:00:00Z` : raw);
          if (!Number.isNaN(ts)) startedAt = new Date(ts);
        }
        const expiresAt = new Date(startedAt.getTime() + plan.period_days * 24 * 60 * 60 * 1000);
        const { error: subErr } = await admin
          .from("subscriptions")
          .insert({
            school_id: school.id,
            user_id: null,
            plan_id: plan.id,
            tier: legacyTier,
            status: "active",
            started_at: startedAt.toISOString(),
            expires_at: expiresAt.toISOString(),
            activation_pending: activationPending,
            grace_period_days: gracePeriodDays,
            contracted_students: contractedStudents,
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
    // F171 fix (QA): inline platform_admin check → shared helper.
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;
    const { admin } = auth;
    const { data: schools, error } = await admin
      .from("schools")
      .select("id, name, join_code, invited_admin_email, invited_at, super_teacher_id, created_at, onboarded_by")
      .not("invited_admin_email", "is", null)
      .order("invited_at", { ascending: false })
      .limit(50);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Paginate through auth.users to build the confirmed-at map. The
    // previous single-page fetch capped us at 1000 users.
    const confirmedById = new Map<string, string | null>();
    {
      const perPage = 200;
      for (let page = 1; page <= 50; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
        if (error) break;
        for (const u of (data.users as Array<{ id: string; email_confirmed_at?: string | null; confirmed_at?: string | null }>)) {
          confirmedById.set(u.id, u.email_confirmed_at || u.confirmed_at || null);
        }
        if ((data.users as unknown[]).length < perPage) break;
      }
    }

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
