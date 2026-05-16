import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/student/weekly-drill-progress
 *
 * Returns this-week drill counts per Bloom level for the calling student,
 * computed from attempt_answers. Used by the active-path tracker on
 * /student/future to render "3 of 5 Apply drills this week" alongside
 * each row, replacing the decorative "Active" pill with a real progress
 * indicator.
 *
 * "This week" = ISO week, Monday 00:00 local through now.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     week_start_iso: string,
 *     by_bloom: { remember: number, understand: number, apply: number, ... },
 *     total: number
 *   }
 *
 * Counts are total per Bloom level — wrong AND right answers count, since
 * the active path measures effort (drilling), not just correctness.
 */
export async function GET(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const admin = supabaseAdmin();

    // Compute Monday 00:00 in UTC for the current week.
    const now = new Date();
    const dow = now.getUTCDay(); // 0=Sun..6=Sat
    const daysSinceMon = (dow + 6) % 7; // 0 if Mon, 1 if Tue, ..., 6 if Sun
    const weekStart = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMon, 0, 0, 0
    ));

    const { data: rows, error: qErr } = await admin
      .from("attempt_answers")
      .select("bloom_level, answered_at")
      .eq("student_id", user.id)
      .not("bloom_level", "is", null)
      .gte("answered_at", weekStart.toISOString())
      .limit(2000);

    if (qErr) {
      // Some installs don't have answered_at — fall back to id ordering only.
      // Return zeros gracefully so the UI never breaks.
      return NextResponse.json({
        ok: true,
        week_start_iso: weekStart.toISOString(),
        by_bloom: zeros(),
        total: 0,
        warning: qErr.message,
      });
    }

    const byBloom: Record<BloomLevel, number> = zeros();
    let total = 0;
    for (const r of rows || []) {
      const lvl = (r as { bloom_level?: string }).bloom_level;
      if (lvl && BLOOM_LEVELS.includes(lvl as BloomLevel)) {
        byBloom[lvl as BloomLevel] += 1;
        total += 1;
      }
    }

    return NextResponse.json({
      ok: true,
      week_start_iso: weekStart.toISOString(),
      by_bloom: byBloom,
      total,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}

function zeros(): Record<BloomLevel, number> {
  return {
    remember: 0,
    understand: 0,
    apply: 0,
    analyze: 0,
    evaluate: 0,
    create: 0,
  };
}
