import { NextResponse } from "next/server";
import { BLOOM_LEVELS, isBloomLevel, type BloomLevel } from "@/lib/bloom";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

// =============================================================================
// POST /api/climber/complete
// -----------------------------------------------------------------------------
// Body: { topic, bloom_level, score, total }
//
// Records the result of today's climb. If the student got >= 2/3 right, the
// rung is "mastered" — the next rung unlocks. Updates streak based on the
// calendar date in UTC.
// =============================================================================

function todayUTC(): string {
  const d = new Date();
  // YYYY-MM-DD in UTC.
  return d.toISOString().slice(0, 10);
}

function dayDiff(a: string, b: string): number {
  // Whole-day difference between two YYYY-MM-DD strings in UTC.
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db - da) / (24 * 3600 * 1000));
}

export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const body = await req.json().catch(() => ({}));
    const topic: string = String(body.topic || "").trim();
    const bloomRaw: string = String(body.bloom_level || "");
    const score: number = Number(body.score || 0);
    const total: number = Number(body.total || 0);

    if (!topic) return NextResponse.json({ error: "topic required" }, { status: 400 });
    if (!isBloomLevel(bloomRaw)) return NextResponse.json({ error: "invalid bloom_level" }, { status: 400 });
    const bloom_level: BloomLevel = bloomRaw;
    if (total <= 0 || score < 0 || score > total) {
      return NextResponse.json({ error: "invalid score/total" }, { status: 400 });
    }

    // Mastery rule: 2 out of 3 correct (or any >= 2/3 ratio if total !== 3).
    const passRatio = score / total;
    const passed = passRatio >= 2 / 3;

    // ----- Upsert bloom_climber_state -----
    const { data: existing } = await sb
      .from("bloom_climber_state")
      .select("attempts, correct, mastered")
      .eq("user_id", user.id)
      .eq("topic", topic)
      .eq("bloom_level", bloom_level)
      .maybeSingle();

    if (existing) {
      await sb
        .from("bloom_climber_state")
        .update({
          attempts: (existing.attempts || 0) + 1,
          correct: (existing.correct || 0) + score,
          mastered: existing.mastered || passed,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .eq("topic", topic)
        .eq("bloom_level", bloom_level);
    } else {
      await sb.from("bloom_climber_state").insert({
        user_id: user.id,
        topic,
        bloom_level,
        mastered: passed,
        attempts: 1,
        correct: score,
        last_attempt_at: new Date().toISOString(),
      });
    }

    // ----- Update streak -----
    const today = todayUTC();
    const { data: streakRow } = await sb
      .from("bloom_climber_streaks")
      .select("current_streak, longest_streak, total_climbs, last_active_date")
      .eq("user_id", user.id)
      .maybeSingle();

    let current = 1;
    let longest = 1;
    let total_climbs = 1;

    if (streakRow) {
      const last = streakRow.last_active_date as string | null;
      if (last === today) {
        // Already climbed today — keep streak the same, just bump total_climbs.
        current = streakRow.current_streak || 1;
        longest = Math.max(streakRow.longest_streak || 0, current);
        total_climbs = (streakRow.total_climbs || 0) + 1;
      } else if (last && dayDiff(last, today) === 1) {
        // Climbed yesterday and now today — extend the streak.
        current = (streakRow.current_streak || 0) + 1;
        longest = Math.max(streakRow.longest_streak || 0, current);
        total_climbs = (streakRow.total_climbs || 0) + 1;
      } else {
        // Skipped at least a day — streak resets to 1.
        current = 1;
        longest = Math.max(streakRow.longest_streak || 0, 1);
        total_climbs = (streakRow.total_climbs || 0) + 1;
      }
      await sb
        .from("bloom_climber_streaks")
        .update({
          current_streak: current,
          longest_streak: longest,
          total_climbs,
          last_active_date: today,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id);
    } else {
      await sb.from("bloom_climber_streaks").insert({
        user_id: user.id,
        current_streak: 1,
        longest_streak: 1,
        total_climbs: 1,
        last_active_date: today,
      });
    }

    // What rung is now next?
    const { data: nowMastered } = await sb
      .from("bloom_climber_state")
      .select("bloom_level")
      .eq("user_id", user.id)
      .eq("topic", topic)
      .eq("mastered", true);
    const masteredSet = new Set(((nowMastered || []) as Array<{ bloom_level: string }>).map((r) => r.bloom_level));
    let next_level: BloomLevel = "evaluate";
    for (const lvl of BLOOM_LEVELS) {
      if (!masteredSet.has(lvl)) { next_level = lvl; break; }
    }

    return NextResponse.json({
      ok: true,
      passed,
      mastered_now: Array.from(masteredSet),
      next_level,
      streak: { current_streak: current, longest_streak: longest, total_climbs },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Climber complete failed" },
      { status: 500 }
    );
  }
}
