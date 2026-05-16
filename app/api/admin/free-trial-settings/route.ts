import { NextResponse } from "next/server";

export const runtime = "nodejs";

// =============================================================================
// /api/admin/free-trial-settings — DEPRECATED 2026-05-11
// -----------------------------------------------------------------------------
// The free_trial_days knob moved to /admin/free-tier-limits so all Free-plan
// caps + the trial duration live on one consolidated admin surface.
// New canonical endpoint: /api/admin/free-tier-limits (GET + PATCH).
//
// F176 note (QA): if any frontend still POSTs here it gets 410. Audit
// the frontend tree for stale references with:
//   git grep "free-trial-settings"
// =============================================================================

export async function GET() {
  return NextResponse.json(
    { error: "This endpoint has moved to /api/admin/free-tier-limits.", deprecated: true },
    { status: 410 }
  );
}
export async function PATCH() {
  return NextResponse.json(
    { error: "This endpoint has moved to /api/admin/free-tier-limits.", deprecated: true },
    { status: 410 }
  );
}
