import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { checkDailyQuota, recordDailyUse } from "@/lib/freeQuota";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// POST /api/speed/start
// -----------------------------------------------------------------------------
// Body: { topic?: string, count?: number }
//
// Generates a mixed-Bloom-level batch of MCQs for the Speed-Accuracy Trainer.
// Each question is returned with a `target_ms` derived from its Bloom level —
// this is the "examiner-pace budget" the student should beat. The mix is
// deliberately weighted toward Apply/Analyze since those are the dominant
// Bloom levels in JEE/NEET-style competitive papers.
// =============================================================================

const SYSTEM = `You are an expert curriculum designer building a mixed-Bloom-level practice batch for a competitive-exam student.

You will be given a topic and a target count. Generate exactly that many MCQs, distributed across Bloom levels per the provided weights. Each MCQ:
- has a clear stem (no preamble)
- has 4 options (one correct, three plausible distractors)
- has correct_index 0..3
- has bloom_level (one of: remember, understand, apply, analyze, evaluate, create)
- has a 1-sentence explanation

Respond with VALID JSON only:
{
  "questions": [
    { "stem": "...", "options": ["a","b","c","d"], "correct_index": 0, "bloom_level": "apply", "explanation": "..." }
  ]
}`;

// Per-Bloom-level time budget in ms. These match the rule of thumb that
// JEE/NEET coaches use — ~30–90 seconds depending on cognitive load.
const TARGET_MS: Record<BloomLevel, number> = {
  remember: 30_000,
  understand: 45_000,
  apply: 75_000,
  analyze: 90_000,
  evaluate: 90_000,
  create: 120_000,
};

// Distribution favoring Apply/Analyze (the Bloom levels competitive exams test most).
const WEIGHTS: Record<BloomLevel, number> = {
  remember: 0.10,
  understand: 0.15,
  apply: 0.35,
  analyze: 0.25,
  evaluate: 0.10,
  create: 0.05,
};

function levelMix(count: number): Record<BloomLevel, number> {
  const out: Record<BloomLevel, number> = {
    remember: 0, understand: 0, apply: 0, analyze: 0, evaluate: 0, create: 0,
  };
  // Allocate using floors then distribute remainder by largest fractional.
  const fracs: Array<[BloomLevel, number]> = BLOOM_LEVELS.map((l) => [l, count * WEIGHTS[l]]);
  fracs.forEach(([l, n]) => { out[l] = Math.floor(n); });
  let remainder = count - BLOOM_LEVELS.reduce((s, l) => s + out[l], 0);
  // Sort by largest fractional remainder
  const sorted = fracs
    .map(([l, n]) => [l, n - Math.floor(n)] as [BloomLevel, number])
    .sort((a, b) => b[1] - a[1]);
  for (const [l] of sorted) {
    if (remainder <= 0) break;
    out[l] += 1;
    remainder -= 1;
  }
  return out;
}

type GenQ = { stem: string; options: string[]; correct_index: number; bloom_level: BloomLevel; explanation: string };

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const gate = await checkDailyQuota(user.id, "speed_session");
    if (!gate.allowed) {
      return NextResponse.json(
        { error: gate.reason, code: "free_daily_cap", cap: gate.cap, used: gate.used },
        { status: 402 }
      );
    }

    const body = await req.json().catch(() => ({}));
    let topic: string = String(body.topic || "").trim();
    const requestedCount: number = Number(body.count || 8);
    const count = Math.max(5, Math.min(15, Math.floor(requestedCount)));

    // If no topic, pick the student's most recent topic.
    if (!topic) {
      const { data: recent } = await sb
        .from("question_bank")
        .select("topic")
        .eq("owner_id", user.id)
        .not("topic", "is", null)
        .order("created_at", { ascending: false })
        .limit(20);
      const t = ((recent || []) as Array<{ topic: string | null }>).find((r) => r.topic);
      topic = t?.topic || "General Knowledge";
    }

    const mix = levelMix(count);
    const userPrompt = `Topic: ${topic}
Total questions: ${count}
Distribution by Bloom level:
${BLOOM_LEVELS.map((l) => `- ${l}: ${mix[l]}`).join("\n")}

Generate the JSON now.`;

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
        const bl = String(obj.bloom_level || "").toLowerCase().trim();
        const expl = String(obj.explanation || "").trim();
        if (!stem || options.length !== 4 || !Number.isInteger(ci) || ci < 0 || ci > 3) return null;
        if (!(BLOOM_LEVELS as readonly string[]).includes(bl)) return null;
        return { stem, options, correct_index: ci, bloom_level: bl as BloomLevel, explanation: expl };
      })
      .filter((q): q is GenQ => q !== null)
      .slice(0, count);

    if (valid.length === 0) {
      return NextResponse.json({ error: "No usable questions came back. Try a different topic." }, { status: 502 });
    }

    // Attach target_ms based on bloom level. Send everything to client; the
    // client times the answer interaction and reports back via /submit.
    const enriched = valid.map((q) => ({ ...q, target_ms: TARGET_MS[q.bloom_level] }));

    await recordDailyUse(user.id, "speed_session");

    return NextResponse.json({ ok: true, topic, count: enriched.length, questions: enriched });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not start speed session" },
      { status: 500 }
    );
  }
}
