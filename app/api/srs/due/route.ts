import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

// =============================================================================
// GET /api/srs/due
// -----------------------------------------------------------------------------
// Returns up to N due review cards for today + queue stats.
// Each card has the question payload joined from question_bank.
// =============================================================================

const DEFAULT_LIMIT = 12;

export async function GET(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(30, Number(url.searchParams.get("limit") || DEFAULT_LIMIT)));

    const today = new Date().toISOString().slice(0, 10);

    // Pull due reviews
    const { data: dueRows } = await sb
      .from("srs_reviews")
      .select("id, question_id, easiness, interval_days, reps, due_at, last_reviewed_at")
      .eq("user_id", user.id)
      .lte("due_at", today)
      .order("due_at", { ascending: true })
      .limit(limit);

    const reviews = (dueRows || []) as Array<{
      id: string; question_id: string; easiness: number; interval_days: number;
      reps: number; due_at: string; last_reviewed_at: string | null;
    }>;

    // Pull queue counts: total, due_today, due_tomorrow, total_overdue
    const { count: totalCount } = await sb
      .from("srs_reviews").select("id", { count: "exact", head: true }).eq("user_id", user.id);
    const { count: dueCount } = await sb
      .from("srs_reviews").select("id", { count: "exact", head: true }).eq("user_id", user.id).lte("due_at", today);

    if (reviews.length === 0) {
      return NextResponse.json({
        ok: true,
        cards: [],
        stats: { total: totalCount || 0, due_today: dueCount || 0 },
      });
    }

    // Hydrate question payloads.
    const qIds = Array.from(new Set(reviews.map((r) => r.question_id)));
    const { data: qs } = await sb
      .from("question_bank")
      .select("id, topic, bloom_level, stem, options, correct_index, explanation")
      .in("id", qIds);

    type Q = {
      id: string; topic: string | null; bloom_level: string;
      stem: string; options: string[]; correct_index: number; explanation: string | null;
    };
    const qMap = new Map<string, Q>();
    ((qs || []) as Q[]).forEach((q) => qMap.set(q.id, q));

    const cards = reviews
      .map((r) => {
        const q = qMap.get(r.question_id);
        if (!q) return null;
        return {
          review_id: r.id,
          question_id: q.id,
          topic: q.topic,
          bloom_level: q.bloom_level,
          stem: q.stem,
          options: q.options,
          correct_index: q.correct_index,
          explanation: q.explanation,
          interval_days: r.interval_days,
          reps: r.reps,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    return NextResponse.json({
      ok: true,
      cards,
      stats: { total: totalCount || 0, due_today: dueCount || 0 },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Due query failed" },
      { status: 500 }
    );
  }
}
