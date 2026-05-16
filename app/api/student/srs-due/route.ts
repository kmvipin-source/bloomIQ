import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

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
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    // F112 fix: UTC-only date math hid "due today" SRS items from IST
    // students until 5:30am their local time. Anchor to IST. Long-term:
    // per-user timezone preference.
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIst = new Date(Date.now() + IST_OFFSET_MS);
    const yyyy = nowIst.getUTCFullYear();
    const mm = String(nowIst.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(nowIst.getUTCDate()).padStart(2, "0");
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
