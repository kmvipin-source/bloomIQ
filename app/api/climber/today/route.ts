import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 45;

// =============================================================================
// POST /api/climber/today
// -----------------------------------------------------------------------------
// Body: { topic?: string }   — optional override; otherwise we reuse a topic
//                              the student has already studied.
//
// Returns today's Bloom Climber challenge: 3 questions on a chosen topic at
// the next un-mastered Bloom level. The student climbs up the pyramid one
// rung at a time per topic.
// =============================================================================

const SYSTEM = `You are an expert curriculum designer building a 3-question micro-quiz at a SPECIFIC Bloom level.

You will be given a topic and a target Bloom level. Generate exactly 3 MCQs that ALL test that Bloom level (no easier, no harder). Each MCQ:
- has a clear stem
- has 4 options (one correct, three plausible distractors)
- has correct_index 0..3
- has a 1-sentence explanation

Respond with VALID JSON only:
{
  "questions": [
    { "stem": "...", "options": ["a","b","c","d"], "correct_index": 0, "explanation": "..." }
  ]
}`;

type GenQ = { stem: string; options: string[]; correct_index: number; explanation: string };

function nextLevelFor(mastered: Set<BloomLevel>): BloomLevel {
  for (const lvl of BLOOM_LEVELS) {
    if (!mastered.has(lvl)) return lvl;
  }
  // All 6 mastered → loop back to evaluate (so the climber stays interesting).
  return "evaluate";
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let topic: string = String(body.topic || "").trim();

    // If no topic supplied, pick the most recent topic the student has questions on.
    if (!topic) {
      const { data: recentQs } = await sb
        .from("question_bank")
        .select("topic")
        .eq("owner_id", user.id)
        .not("topic", "is", null)
        .order("created_at", { ascending: false })
        .limit(50);
      const seen = new Set<string>();
      for (const r of (recentQs || []) as Array<{ topic: string | null }>) {
        if (r.topic && !seen.has(r.topic)) {
          topic = r.topic;
          break;
        }
        if (r.topic) seen.add(r.topic);
      }
      if (!topic) topic = "General Knowledge";
    }

    // Read current per-topic mastery state to decide which Bloom level is next.
    const { data: stateRows } = await sb
      .from("bloom_climber_state")
      .select("bloom_level, mastered")
      .eq("user_id", user.id)
      .eq("topic", topic);
    const mastered = new Set<BloomLevel>();
    for (const r of (stateRows || []) as Array<{ bloom_level: string; mastered: boolean }>) {
      if (r.mastered && (BLOOM_LEVELS as readonly string[]).includes(r.bloom_level)) {
        mastered.add(r.bloom_level as BloomLevel);
      }
    }
    const target: BloomLevel = nextLevelFor(mastered);

    // Generate the day's questions.
    const userPrompt = `Topic: ${topic}\nBloom level: ${target}\n\nGenerate the JSON now.`;
    const raw = await groqJSON(SYSTEM, userPrompt);
    const arr = (raw as { questions?: unknown }).questions;
    if (!Array.isArray(arr)) {
      return NextResponse.json({ error: "AI did not return questions; please retry." }, { status: 502 });
    }
    const valid: GenQ[] = (arr as unknown[])
      .map((q) => {
        const obj = (q || {}) as Record<string, unknown>;
        const stem = String(obj.stem || "").trim();
        const options = Array.isArray(obj.options) ? (obj.options as unknown[]).map(String) : [];
        const ci = Number(obj.correct_index);
        const expl = String(obj.explanation || "").trim();
        if (!stem || options.length !== 4 || !Number.isInteger(ci) || ci < 0 || ci > 3) return null;
        return { stem, options, correct_index: ci, explanation: expl };
      })
      .filter((q): q is GenQ => q !== null)
      .slice(0, 3);

    if (valid.length === 0) {
      return NextResponse.json({ error: "No usable questions came back." }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      topic,
      bloom_level: target,
      mastered_levels: Array.from(mastered),
      questions: valid,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Climber generation failed" },
      { status: 500 }
    );
  }
}
