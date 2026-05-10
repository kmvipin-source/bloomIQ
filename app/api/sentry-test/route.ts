import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sentry-test
 *
 * One-shot smoke test for the Sentry server-side wiring. Captures a
 * deliberate exception via Sentry.captureException so an event lands
 * in the Issues tab within ~30 seconds, then returns 200 with the
 * event id so the operator can search Sentry for that exact id.
 *
 * REMOVE THIS ROUTE after verification — it's intentionally trivially
 * exploitable as a "free Sentry quota burn" if left in prod.
 */
export async function GET() {
  const eventId = Sentry.captureException(
    new Error("BloomIQ Sentry smoke-test event — server route")
  );
  // Force-flush so the event leaves the process before the function
  // exits (Vercel functions die fast otherwise).
  await Sentry.flush(2000);
  return NextResponse.json({ ok: true, eventId, ts: new Date().toISOString() });
}
