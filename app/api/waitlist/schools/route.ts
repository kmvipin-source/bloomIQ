import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/waitlist/schools
 *
 * Public, anonymous-friendly endpoint that captures a school waitlist
 * lead. Posted to from /schools-coming-soon when the
 * school_marketing_visible flag is OFF.
 *
 * Validation rules
 * ----------------
 *  - email: required, simple shape check (don't gold-plate — a few
 *    invalid leads are cheaper than dropping real ones).
 *  - school_name: optional, trimmed, capped at 200 chars.
 *  - duplicate email → returns 200 with already_on_list:true rather
 *    than an error so the front-end success state is honest either way.
 *
 * Light abuse mitigation
 * ----------------------
 *  - The remote IP (best-effort from x-forwarded-for / x-real-ip) is
 *    SHA-256-hashed with a daily salt and stored as ip_hash. We never
 *    store the raw IP. This still lets us notice a burst from one
 *    source if we ever need to.
 *  - Maximum body size enforced via Next's default 1MB limit; we don't
 *    bypass it.
 *  - No CAPTCHA. The volume of school leads is tiny enough that human
 *    moderation of the resulting table is fine for v1. Add a CAPTCHA
 *    if abuse materializes.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  // Day-bucket salt so the same IP across days produces different
  // hashes — limits long-term linkability while still letting us spot
  // a same-day burst.
  const day = new Date().toISOString().slice(0, 10);
  return createHash("sha256").update(`${day}::${ip}`).digest("hex").slice(0, 32);
}

function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return null;
}

export async function POST(req: Request) {
  let body: { email?: unknown; school_name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const email = String(body.email || "").trim().toLowerCase();
  const schoolName = String(body.school_name || "").trim().slice(0, 200);

  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "A valid email is required." },
      { status: 400 }
    );
  }

  const ipHash = hashIp(clientIp(req));
  const userAgent = (req.headers.get("user-agent") || "").slice(0, 500);

  // Service role bypasses RLS — anonymous inserts policy exists too,
  // but using service role keeps the route consistent with the rest of
  // the admin-write code paths.
  let admin: ReturnType<typeof supabaseAdmin>;
  try {
    admin = supabaseAdmin();
  } catch (err) {
    // If service role isn't configured we still don't want to lose the
    // lead — log and return 503 so the client can surface a clear
    // "save failed, please email us" message instead of pretending all
    // is fine.
    console.error("[waitlist/schools] supabaseAdmin failed", err);
    return NextResponse.json(
      { error: "Waitlist temporarily unavailable. Please email hello@bloomiq.app." },
      { status: 503 }
    );
  }

  const { error } = await admin
    .from("school_waitlist")
    .insert({
      email,
      school_name: schoolName || null,
      ip_hash: ipHash,
      user_agent: userAgent || null,
    });

  if (error) {
    // Duplicate email = unique index violation (23505) — that's a
    // success from the user's perspective, not an error.
    if (error.code === "23505") {
      return NextResponse.json({ ok: true, already_on_list: true });
    }
    console.error("[waitlist/schools] insert failed", error);
    return NextResponse.json(
      { error: "Could not save your details. Please try again or email hello@bloomiq.app." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
