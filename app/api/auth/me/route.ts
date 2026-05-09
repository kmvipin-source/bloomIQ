import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/me
 *
 * Returns the caller's role + platform_admin + is_school_student
 * by reading profiles via the service-role client. The user-token
 * supabase-js client occasionally fails to read profiles from the
 * Vercel edge (RLS race), which broke the /login role-tab gate for
 * legitimate users. This endpoint fixes that by establishing identity
 * via sb.auth.getUser() (bearer token) and looking up the profile
 * with admin privileges.
 *
 * Caller must pass the bearer access token in the Authorization
 * header. Returns 401 if the token doesn't resolve to a user.
 */
function decodeIat(token: string): number | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const obj = JSON.parse(json) as { iat?: number };
    return typeof obj.iat === "number" ? obj.iat : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user }, error: userErr } = await sb.auth.getUser();
    if (userErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const admin = supabaseAdmin();
    const { data: prof } = await admin
      .from("profiles")
      .select("role, is_school_student, platform_admin, school_id, session_iat, full_name, exam_goal, learner_profile")
      .eq("id", user.id)
      .maybeSingle();

    // Single-session enforcement: reject if this JWT was issued before
    // the user's most recently claimed session (i.e. they signed in
    // somewhere else after this token was minted).
    const iat = decodeIat(token);
    if (prof?.session_iat && iat && iat < prof.session_iat) {
      return NextResponse.json({ error: "session_superseded" }, { status: 401 });
    }

    // ─── Activation-pending flip ───
    // When a super_teacher signs in for the first time after onboarding,
    // and their school's subscription was created with activation_pending=
    // true (the operator chose "defer activation until first sign-in" so
    // the school doesn't lose days while finance moves), flip it now:
    // started_at → today, expires_at → today + plan period, flag → false.
    //
    // Why here and not elsewhere: /api/auth/me is the first server-side
    // call on EVERY page load, including the post-invite landing — so
    // the term clock starts the moment the human actually shows up. The
    // flip is idempotent (only runs while activation_pending is still
    // true) and gated to super_teachers so a regular teacher signing in
    // first doesn't trigger it.
    if (prof?.role === "super_teacher" && prof.school_id) {
      const { data: sub } = await admin
        .from("subscriptions")
        .select("id, plan_id, activation_pending")
        .eq("school_id", prof.school_id)
        .maybeSingle();
      if (sub?.activation_pending && sub.id) {
        let periodDays = 365;
        if (sub.plan_id) {
          const { data: planRow } = await admin
            .from("plans")
            .select("period_days")
            .eq("id", sub.plan_id)
            .maybeSingle();
          if (planRow?.period_days) periodDays = planRow.period_days;
        }
        const now = new Date();
        const expiresAt = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);
        await admin
          .from("subscriptions")
          .update({
            started_at: now.toISOString(),
            expires_at: expiresAt.toISOString(),
            activation_pending: false,
          })
          .eq("id", sub.id);
      }
    }

    // ─── Free-plan validity grant on first sign-in ───
    // If the platform admin has set subscription_limits.free_trial_days > 0,
    // every new independent student gets a TIME-BOXED FREE PLAN of N days on
    // first sign-in. This is NOT a Premium trial — they get the Free 3-tests/
    // day cap and Free feature set, but their access is gated to N days. When
    // expires_at passes, the layout interceptor renders a hard upgrade gate.
    //
    // Setting N=0 disables this — students stay on permanent Free (the
    // pre-pivot behaviour, useful for non-monetised testing or schools).
    //
    // Idempotent: only inserts when no subscription row exists. Re-runs are
    // no-ops; expiry is detected separately and surfaced via is_free_expired.
    let isFreeExpired = false;
    if (
      prof &&
      prof.role === "student" &&
      !prof.is_school_student &&
      prof.school_id == null
    ) {
      try {
        const { data: existingSub } = await admin
          .from("subscriptions")
          .select("tier, is_trial, status, expires_at")
          .eq("user_id", user.id)
          .maybeSingle();
        if (!existingSub) {
          // No subscription row yet — auto-grant a time-boxed Free plan if
          // the platform admin has configured a non-zero validity window.
          const { data: limits } = await admin
            .from("subscription_limits")
            .select("free_trial_days")
            .eq("id", 1)
            .maybeSingle();
          const validityDays = (limits as { free_trial_days?: number } | null)?.free_trial_days ?? 0;
          if (validityDays > 0) {
            const startedAt = new Date();
            const expiresAt = new Date(startedAt.getTime() + validityDays * 24 * 60 * 60 * 1000);
            await admin.from("subscriptions").insert({
              user_id: user.id,
              plan_id: null,
              tier: "free",
              status: "active",
              is_trial: true,
              started_at: startedAt.toISOString(),
              expires_at: expiresAt.toISOString(),
            });
          }
        } else {
          // Subscription row exists. Detect the expired-Free-trial state so
          // the layout can render a hard upgrade gate. We ONLY block when:
          //   - tier == "free" (so paid users keep working past expiry)
          //   - is_trial == true (this was an auto-granted Free trial)
          //   - expires_at is in the past
          const sub = existingSub as {
            tier?: string;
            is_trial?: boolean;
            status?: string;
            expires_at?: string | null;
          };
          if (
            sub.tier === "free" &&
            sub.is_trial === true &&
            sub.expires_at &&
            new Date(sub.expires_at).getTime() < Date.now()
          ) {
            isFreeExpired = true;
          }
        }
      } catch {
        // Auto-grant + expiry-detect are both best-effort — never block sign-in.
      }
    }

    const metaRole = String((user.user_metadata as { role?: string } | undefined)?.role || "");
    return NextResponse.json({
      ok: true,
      uid: user.id,
      email: user.email || null,
      role: prof?.role || metaRole || null,
      is_school_student: !!prof?.is_school_student,
      platform_admin: !!prof?.platform_admin,
      school_id: prof?.school_id || null,
      full_name: prof?.full_name || null,
      exam_goal: (prof as { exam_goal?: string | null } | null)?.exam_goal ?? null,
      learner_profile: (prof as { learner_profile?: string | null } | null)?.learner_profile ?? "k12",
      is_free_expired: isFreeExpired,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
