import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// GET /api/student/srs-due
// -----------------------------------------------------------------------------
// Counts SRS reviews due for the calling student (today or earlier) and
// surfaces the next 5 question_ids so a card can preview them.
// =============================================================================

type SrsRow = { id: string; question_id: string; due_at: string };

export async function GET(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Today as YYYY-MM-DD (UTC). srs_reviews.due_at is a date column.
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(today.getUTCDate()).padStart(2, "0");
    const todayStr = `${yyyy}-${mm}-${dd}`;

    let count = 0;
    let next: SrsRow[] = [];
    try {
      const { count: c } = await sb
        .from("srs_reviews")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .lte("due_at", todayStr);
      count = c || 0;
      const { data } = await sb
        .from("srs_reviews")
        .select("id, question_id, due_at")
        .eq("user_id", user.id)
        .lte("due_at", todayStr)
        .order("due_at", { ascending: true })
        .limit(5);
      next = (data as SrsRow[]) || [];
    } catch {
      // Migration 15 not yet applied — degrade silently.
      return NextResponse.json({ count: 0, next: [] });
    }

    return NextResponse.json({
      count,
      next: next.map((r) => ({ question_id: r.question_id, due_at: r.due_at })),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
