import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
// Finding #17 fix: shared decodeIat (was duplicated locally).
import { decodeIat } from "@/lib/apiAuth";

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
        .select("id, plan_id, activation_pending, started_at, status")
        .eq("school_id", prof.school_id)
        .maybeSingle();
      // Finding #16 fix: refuse to activate a cancelled/suspended sub.
      // An admin who pre-cancelled or pre-suspended a school's subscription
      // before its super_teacher first signed in should not have that
      // intent silently overwritten by an automatic activation flip.
      const subStatus = (sub as { status?: string | null } | null)?.status ?? null;
      const statusAllowsActivation = subStatus === null || subStatus === "active" || subStatus === "" ;
      if (sub?.activation_pending && sub.id && statusAllowsActivation) {
        // Finding #14 fix (F30 closure): resolve period_days strictly from the
        // plan row. If we cannot (plan_id missing, plan deleted, or period_days
        // null/zero), log a warning and SKIP the flip instead of silently
        // defaulting to 365 — which lies for quarterly/term plans.
        let periodDays: number | null = null;
        if (sub.plan_id) {
          const { data: planRow } = await admin
            .from("plans")
            .select("period_days")
            .eq("id", sub.plan_id)
            .maybeSingle();
          const pd = (planRow as { period_days?: number | null } | null)?.period_days ?? null;
          if (typeof pd === "number" && pd > 0) periodDays = pd;
        }
        if (periodDays === null) {
          // eslint-disable-next-line no-console
          console.warn(
            "[auth/me] activation flip skipped: cannot resolve period_days for subscription " +
              sub.id + " (plan_id=" + String(sub.plan_id) + "). Operator must edit the plan or set started_at/expires_at manually.",
          );
        } else {
        // If the operator deliberately set started_at to a future date
        // (academic-year deal: onboard early, term starts 1 Aug), don't
        // overwrite that anchor — clear only the pending flag and let
        // the explicit term boundaries stand. Otherwise (no anchor or
        // past anchor), this IS the moment the human showed up, so
        // anchor here.
        const now = new Date();
        const existingStartedAt = sub.started_at ? new Date(sub.started_at) : null;
        const useExistingAnchor = existingStartedAt && existingStartedAt.getTime() > now.getTime();
        const anchor = useExistingAnchor ? existingStartedAt! : now;
        const expiresAt = new Date(anchor.getTime() + periodDays * 24 * 60 * 60 * 1000);
        const patch: Record<string, unknown> = {
          activation_pending: false,
          expires_at: expiresAt.toISOString(),
        };
        if (!useExistingAnchor) patch.started_at = anchor.toISOString();
        await admin
          .from("subscriptions")
          .update(patch)
          .eq("id", sub.id);
        }
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
          if (validityDays === 0) {
            // F33 fix: visible warning when an operator has set
            // free_trial_days to 0 — silently disables the free-trial
            // product for all new independent students.
            // eslint-disable-next-line no-console
            console.warn(
              "[auth/me] subscription_limits.free_trial_days = 0 — free-trial auto-grant disabled.",
            );
          }
          if (validityDays > 0) {
            const startedAt = new Date();
            const expiresAt = new Date(startedAt.getTime() + validityDays * 24 * 60 * 60 * 1000);
            // Upsert keyed on user_id so two concurrent first-sign-in
            // requests can't race past the existence check above and
            // both insert a duplicate row. ignoreDuplicates keeps the
            // existing row when one already landed between the
            // existence read and this write.
            await admin.from("subscriptions").upsert({
              user_id: user.id,
              plan_id: null,
              tier: "free",
              status: "active",
              is_trial: true,
              started_at: startedAt.toISOString(),
              expires_at: expiresAt.toISOString(),
            }, { onConflict: "user_id", ignoreDuplicates: true });
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
          // F164 fix: detect-and-log legacy is_trial=true rows on a
          // PAID tier (data inconsistency from earlier migrations).
          // Without this they'd hit the hard upgrade gate even though
          // they're paying. Hard-fail-safe: never block when tier !=
          // "free", just warn loudly.
          if (
            sub.tier &&
            sub.tier !== "free" &&
            sub.is_trial === true
          ) {
            // eslint-disable-next-line no-console
            console.warn(
              "[auth/me] inconsistent subscription: tier=" + sub.tier + " AND is_trial=true. " +
                "Should never gate this user as free-expired.",
            );
          }
          // Finding #15 fix: treat suspended/cancelled Free trials as expired
          // for the layout gate. Without this, an admin-suspended student keeps
          // accessing Free features until natural expiry.
          const subStatus = (sub as { status?: string | null }).status || "";
          const adminBlocked = subStatus === "suspended" || subStatus === "cancelled";
          if (
            sub.tier === "free" &&
            sub.is_trial === true &&
            (
              adminBlocked ||
              (sub.expires_at && new Date(sub.expires_at).getTime() < Date.now())
            )
          ) {
            isFreeExpired = true;
          }
        }
      } catch {
        // Auto-grant + expiry-detect are both best-effort — never block sign-in.
      }
    }

    // Indicate whether the independent student has completed ZCORIQ
    // calibration yet. Powers the first-run gate in the student layout
    // — without a calibration row, /api/student/score/recompute is a
    // no-op so the student would silently fall off the ZCORIQ Bloom Score
    // funnel. Only meaningful for individual students; school students
    // skip calibration entirely.
    let hasCalibration = false;
    if (
      prof &&
      prof.role === "student" &&
      !prof.is_school_student &&
      prof.school_id == null
    ) {
      const { data: calRow } = await admin
        .from("calibrations")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();
      hasCalibration = !!calRow;
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
      has_calibration: hasCalibration,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}