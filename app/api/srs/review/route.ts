import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

// =============================================================================
// POST /api/srs/review
// -----------------------------------------------------------------------------
// Body: { review_id: string, rating: 0..5 }
//
// SM-2 algorithm (Anki-flavoured). Updates the review row's interval, easiness,
// reps, and due_at based on the student's quality-of-recall rating:
//   0–2: failed → reset reps, schedule for tomorrow
//   3:   hard, but recalled → small interval
//   4:   good
//   5:   easy
// =============================================================================

function computeSm2(prev: { easiness: number; interval_days: number; reps: number }, rating: number) {
  const q = Math.max(0, Math.min(5, Math.round(rating)));

  let { easiness, interval_days, reps } = prev;

  if (q < 3) {
    // Failed — reset.
    reps = 0;
    interval_days = 1;
  } else {
    if (reps === 0) interval_days = 1;
    else if (reps === 1) interval_days = 6;
    else interval_days = Math.round(interval_days * easiness);
    reps += 1;
  }

  // Update easiness factor — never below 1.3.
  easiness = easiness + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (easiness < 1.3) easiness = 1.3;

  // Cap interval to a reasonable max so the queue never goes silent for years.
  interval_days = Math.max(1, Math.min(365, interval_days));

  return { easiness, interval_days, reps };
}

export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const body = await req.json().catch(() => ({}));
    const review_id = String(body.review_id || "");
    const rating = Number(body.rating);
    if (!review_id) return NextResponse.json({ error: "review_id required" }, { status: 400 });
    if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
      return NextResponse.json({ error: "rating must be 0..5" }, { status: 400 });
    }

    const { data: row, error: getErr } = await sb
      .from("srs_reviews")
      .select("id, user_id, easiness, interval_days, reps")
      .eq("id", review_id)
      .single();
    if (getErr || !row) return NextResponse.json({ error: "Review not found" }, { status: 404 });
    if (row.user_id !== user.id) return NextResponse.json({ error: "Not yours" }, { status: 403 });

    const next = computeSm2(
      { easiness: Number(row.easiness), interval_days: Number(row.interval_days), reps: Number(row.reps) },
      rating
    );

    // Compute next due_at = today + interval_days.
    const due = new Date();
    due.setUTCDate(due.getUTCDate() + next.interval_days);
    const dueIso = due.toISOString().slice(0, 10);

    const { error: upErr } = await sb
      .from("srs_reviews")
      .update({
        easiness: next.easiness,
        interval_days: next.interval_days,
        reps: next.reps,
        last_rating: rating,
        last_reviewed_at: new Date().toISOString(),
        due_at: dueIso,
      })
      .eq("id", review_id);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      next_due: dueIso,
      next_interval_days: next.interval_days,
      easiness: Number(next.easiness.toFixed(2)),
      reps: next.reps,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Review failed" },
      { status: 500 }
    );
  }
}
