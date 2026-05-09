import { NextResponse } from "next/server";
import { isBloomLevel } from "@/lib/bloom";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

// =============================================================================
// POST /api/calibration/log
// -----------------------------------------------------------------------------
// Body: {
//   events: Array<{
//     question_id?: string,
//     attempt_id?: string,
//     source: 'speed' | 'quiz' | 'srs',
//     confidence: 1..4,                        // 1=guess, 4=sure
//     was_correct: boolean,
//     bloom_level?: string,
//     topic?: string
//   }>
// }
//
// Bulk-insert calibration events. Used by the Speed-Accuracy Trainer at
// end-of-session to log per-question confidence + outcome in one round-trip.
// =============================================================================

const VALID_SOURCES = new Set(["speed", "quiz", "srs"]);

type Event = {
  question_id: string | null;
  attempt_id: string | null;
  source: string;
  confidence: number;
  was_correct: boolean;
  bloom_level: "remember" | "understand" | "apply" | "analyze" | "evaluate" | "create" | null;
  topic: string | null;
};

function clean(events: unknown): Event[] {
  if (!Array.isArray(events)) return [];
  return (events as unknown[])
    .map((e) => {
      const o = (e || {}) as Record<string, unknown>;
      const source = String(o.source || "");
      const confidence = Math.round(Number(o.confidence));
      if (!VALID_SOURCES.has(source)) return null;
      if (!Number.isInteger(confidence) || confidence < 1 || confidence > 4) return null;
      if (typeof o.was_correct !== "boolean") return null;
      const bl = typeof o.bloom_level === "string" ? o.bloom_level : "";
      return {
        question_id: typeof o.question_id === "string" && o.question_id ? o.question_id : null,
        attempt_id: typeof o.attempt_id === "string" && o.attempt_id ? o.attempt_id : null,
        source,
        confidence,
        was_correct: o.was_correct,
        bloom_level: isBloomLevel(bl) ? bl : null,
        topic: typeof o.topic === "string" && o.topic.trim() ? String(o.topic).slice(0, 200) : null,
      };
    })
    .filter((e): e is Event => e !== null)
    .slice(0, 100);
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const events = clean(body.events);
    if (events.length === 0) {
      return NextResponse.json({ ok: true, logged: 0 });
    }

    const rows = events.map((e) => ({ ...e, user_id: user.id }));
    const { error: insErr } = await sb.from("confidence_calibrations").insert(rows);
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, logged: events.length });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Log failed" },
      { status: 500 }
    );
  }
}
