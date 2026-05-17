import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { validatePassword } from "@/lib/passwordPolicy";

export const runtime = "nodejs";

/**
 * POST /api/auth/set-password
 *
 * Body: { password: string, tos_version?: string }
 *
 * Sets a password for the currently-authenticated user via the service
 * role, which bypasses the AAL2 requirement that Supabase places on
 * `updateUser({ password })` whenever an MFA factor is enrolled.
 *
 * The AAL2 rule is right for an already-onboarded user who wants to
 * rotate their password — it stops a stolen low-AAL session from also
 * stealing the long-term credential. But it breaks first-time invitees
 * who have a leftover unverified TOTP factor: they have no second factor
 * to challenge, so they can never finish setting a real password.
 *
 * The flow that calls this endpoint always operates on a recovery / invite
 * session, which Supabase already validated by issuing the access token,
 * so admin-side update is safe for our threat model.
 */
// Decode the AMR claim from a Supabase access token without verifying
// the signature — we already trust the token via sb.auth.getUser() which
// hits Supabase's auth server. AMR is informational: tells us whether
// this session was minted by a recovery / invite flow (safe to rotate)
// vs an ordinary password session (must NOT be allowed to rotate
// without re-auth, otherwise an XSS payload can rotate the victim's
// password silently).
function decodeAmr(token: string): string[] {
  try {
    const [, payload] = token.split(".");
    if (!payload) return [];
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const obj = JSON.parse(json) as { amr?: Array<{ method?: string } | string> };
    if (!Array.isArray(obj.amr)) return [];
    return obj.amr.map((m) => typeof m === "string" ? m : String((m && m.method) || ""));
  } catch {
    return [];
  }
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user }, error: userErr } = await sb.auth.getUser();
    if (userErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Refuse to set a password on an ordinary password session. The
    // valid entry points are:
    //   1. A recovery / invite session (AMR contains "recovery" or
    //      "magiclink") — the user clicked the email link.
    //   2. A first-time invitee whose tos_version isn't set yet —
    //      meaning they were just invited and the email link minted
    //      this session.
    // Anything else (plain password sign-in) must go through the
    // Supabase AAL2 flow, not this admin-side override.
    const amr = decodeAmr(token);
    const isRecoveryFlow = amr.some((m) =>
      m === "recovery" || m === "magiclink" || m === "otp" || m === "email/recovery" || m === "email/signup"
    );
    const isFirstTimeInvitee = !(user.user_metadata as { tos_version?: string } | undefined)?.tos_version;
    if (!isRecoveryFlow && !isFirstTimeInvitee) {
      return NextResponse.json(
        { error: "Use Supabase's normal password-reset flow to rotate your password." },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const password = String(body.password || "");
    // F26 fix: shared validator from lib/passwordPolicy.ts. One place
    // to update if the policy ever hardens.
    const policy = validatePassword(password);
    if (!policy.ok) {
      return NextResponse.json({ error: policy.reason }, { status: 400 });
    }
    // Finding #18 fix: refuse arbitrary tos_version strings. Without this
    // guard, a malicious client could record "tos_accepted_at: 2099-12-31"
    // or any made-up version string in user_metadata, polluting the legal
    // audit trail. Keep the allowlist in sync with the TOS_VERSION constant
    // on the login pages.
    const ALLOWED_TOS_VERSIONS = new Set(["2026-04-30"]);
    const requested = String(body.tos_version || "2026-04-30");
    if (!ALLOWED_TOS_VERSIONS.has(requested)) {
      return NextResponse.json(
        { error: "Unknown ToS version. Refresh the page and accept the latest Terms." },
        { status: 400 },
      );
    }
    const tosVersion = requested;

    const admin = supabaseAdmin();

    // Drop any unverified TOTP factors before updating. They aren't
    // protecting anything (status=unverified means the user never finished
    // enrollment) but they cause the AAL2 wall in the first place. Verified
    // factors are left alone — those represent real 2FA and shouldn't be
    // silently torn down.
    try {
      const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId: user.id });
      const stale = (factors?.factors || []).filter((f) => f.status === "unverified");
      for (const f of stale) {
        await admin.auth.admin.mfa.deleteFactor({ userId: user.id, id: f.id });
      }
    } catch { /* best-effort cleanup */ }

    const { error: upErr } = await admin.auth.admin.updateUserById(user.id, {
      password,
      user_metadata: {
        ...(user.user_metadata || {}),
        tos_accepted_at: new Date().toISOString(),
        tos_version: tosVersion,
      },
    });
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
