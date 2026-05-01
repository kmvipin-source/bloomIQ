import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * /api/admin/plans/[id]/transition — DEPRECATED in migration 30.
 *
 * The draft → submitted → active workflow no longer exists. Plans are
 * edited in place via PUT /api/admin/plans/[id]. This stub returns 410
 * Gone so any straggler client code surfaces the change loudly instead
 * of silently failing.
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Plan workflow transitions were removed in migration 30. Edit the plan in place via PUT /api/admin/plans/[id] instead.",
    },
    { status: 410 }
  );
}
