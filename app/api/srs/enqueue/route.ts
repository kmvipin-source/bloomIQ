import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { requireFeature } from "@/lib/featureAccess.server";

export const runtime = "nodejs";

// =============================================================================
// POST /api/srs/enqueue
// -----------------------------------------------------------------------------
// Body: { attempt_id: string }   — adds every wrong answer in the attempt to
//                                   the user's SRS review queue, due tomorrow.
//        OR
//        { question_ids: string[] }  — explicit list (used internally / future).
//
// Idempotent: re-enqueueing an already-queued question doesn't create a
// duplicate. We use SELECT → UPDATE/INSERT (the partial-unique pattern) so
// we never trip the ON CONFLICT trap.
// =============================================================================

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Memory Tune-Up is REVIEW-only on Free. Adding new cards requires Premium.
    const featureGate = await requireFeature(user.id, "memory_srs");
    if (!featureGate.allowed) {
      return NextResponse.json(
        {
          error: "Adding new cards to Memory Tune-Up is a Premium feature. Reviews of existing cards stay free.",
          code: "feature_locked",
          required_tier: (featureGate as unknown as { requiredTier: string | null }).requiredTier,
        },
        { status: 403 },
      );
    }

    const body = await req.json().catch(() => ({}));
    let questionIds: string[] = [];

    if (body.attempt_id) {
      const attempt_id = String(body.attempt_id);
      const { data: att } = await sb
        .from("quiz_attempts")
        .select("id, student_id")
        .eq("id", attempt_id)
        .single();
      if (!att || att.student_id !== user.id) {
        return NextResponse.json({ error: "Attempt not found or not yours" }, { status: 403 });
      }
      const { data: ans } = await sb
        .from("attempt_answers")
        .select("question_id, is_correct")
        .eq("attempt_id", attempt_id);
      questionIds = ((ans || []) as Array<{ question_id: string; is_correct: boolean | null }>)
        .filter((a) => a.is_correct === false)
        .map((a) => a.question_id);
    } else if (Array.isArray(body.question_ids)) {
      questionIds = (body.question_ids as unknown[]).map(String).filter(Boolean).slice(0, 200);
    } else {
      return NextResponse.json({ error: "attempt_id or question_ids[] required" }, { status: 400 });
    }

    if (questionIds.length === 0) {
      return NextResponse.json({ ok: true, enqueued: 0, skipped: 0 });
    }

    // Tomorrow as YYYY-MM-DD (UTC) — first review one day after enqueue.
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const dueDate = tomorrow.toISOString().slice(0, 10);

    let enqueued = 0;
    let skipped = 0;

    for (const qid of questionIds) {
      const { data: existing } = await sb
        .from("srs_reviews")
        .select("id")
        .eq("user_id", user.id)
        .eq("question_id", qid)
        .maybeSingle();
      if (existing) {
        skipped += 1;
        continue;
      }
      const { error: insErr } = await sb.from("srs_reviews").insert({
        user_id: user.id,
        question_id: qid,
        easiness: 2.5,
        interval_days: 1,
        reps: 0,
        due_at: dueDate,
      });
      if (!insErr) enqueued += 1;
    }

    return NextResponse.json({ ok: true, enqueued, skipped });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Enqueue failed" },
      { status: 500 }
    );
  }
}
