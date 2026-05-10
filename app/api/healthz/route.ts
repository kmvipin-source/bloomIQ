import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/healthz
 *
 * App + DB heartbeat. Used by external uptime monitors (UptimeRobot,
 * Checkly, etc.) to detect outages: a stale Supabase connection, a
 * missing env var, a crashed deployment all surface here as a 5xx
 * within ~1 second instead of waiting for the first user to complain.
 *
 * Probes:
 *   1. Service-role Supabase client can read 1 row from public.profiles.
 *      Catches: missing SUPABASE_SERVICE_ROLE_KEY, Supabase outage,
 *      RLS misconfig that broke service-role bypass, expired keys.
 *   2. NEXT_PUBLIC_SUPABASE_URL is set (sanity check on env vars).
 *
 * The endpoint deliberately returns no PII — just a status flag, the
 * checks that ran, and elapsed ms. Safe to expose publicly. Cache is
 * disabled so monitors always hit live state.
 *
 * Response:
 *   200  { ok: true,  ts, elapsed_ms, checks: { ... } }
 *   500  { ok: false, ts, elapsed_ms, error, checks: { ... } }
 */
type Checks = {
  env_supabase_url: "ok" | "missing";
  env_service_role: "ok" | "missing";
  db_read: "ok" | "fail";
};

export async function GET() {
  const startedAt = Date.now();
  const checks: Checks = {
    env_supabase_url: "missing",
    env_service_role: "missing",
    db_read: "fail",
  };
  let dbError: string | null = null;

  if (process.env.NEXT_PUBLIC_SUPABASE_URL) checks.env_supabase_url = "ok";
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) checks.env_service_role = "ok";

  try {
    const admin = supabaseAdmin();
    const { error } = await admin.from("profiles").select("id").limit(1);
    if (error) {
      dbError = error.message;
    } else {
      checks.db_read = "ok";
    }
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  const elapsed_ms = Date.now() - startedAt;
  const ok =
    checks.env_supabase_url === "ok" &&
    checks.env_service_role === "ok" &&
    checks.db_read === "ok";

  const body = ok
    ? { ok: true, ts: new Date().toISOString(), elapsed_ms, checks }
    : { ok: false, ts: new Date().toISOString(), elapsed_ms, checks, error: dbError ?? "missing env var(s)" };

  return NextResponse.json(body, {
    status: ok ? 200 : 500,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
