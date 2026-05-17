import { NextResponse } from "next/server";
import { aiJSON } from "@/lib/aiClient";
import { buildSkillFewShotBlock } from "@/lib/skillFewShot";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  loadLearningContext,
  prependLearningContext,
  buildExamAwareTopic,
} from "@/lib/learningContext";
import { getRecentStemsForExclusion } from "@/lib/recentStemsExclusion";

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
}

GENERIC DOMAIN AWARENESS (applies to ANY topic — no local lookup):
If the topic is a specialized professional / technical / niche domain
(payment switches, mainframe stack, networking protocols, cloud platforms,
legal codes, medical specialties, regulatory frameworks, ERP modules,
industrial control systems, etc.) — USE the precise real-world terminology.
NEVER invent identifiers, opcodes, parameters, syntax, or product features
that don\'t exist. If you don\'t have confident knowledge of a specific
aspect, write content that AVOIDS that aspect rather than fabricating.`;

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
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;
    const rate = checkRateLimit(user.id, "climber.today", { capacity: 10, refillPerHour: 20 });
    if (!rate.allowed) return NextResponse.json({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });

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
      // Most recent non-null topic. The previous loop used a `seen` set
      // that was never populated before the first check, so the second
      // branch was dead code. Simplified to the documented intent.
      const first = ((recentQs || []) as Array<{ topic: string | null }>)
        .find((r) => r.topic && r.topic.trim().length > 0);
      topic = first?.topic ?? "General Knowledge";
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
    // Learning-context inheritance + cross-test non-repetition. The
    // 3-question micro-drill should never repeat questions the student
    // saw in the last 30 days at the same Bloom level on this topic.
    const admin = supabaseAdmin();
    const ctx = await loadLearningContext(admin, user.id);
    const examAwareTopic = buildExamAwareTopic(topic, ctx);
    const exclusion = await getRecentStemsForExclusion(admin, user.id, topic, target, 20);
    const systemPrompt = prependLearningContext(SYSTEM, ctx) + exclusion.promptBlock;

    const userPrompt = `Topic: ${examAwareTopic}\nBloom level: ${target}\n\nGenerate the JSON now.`;
    const raw = await aiJSON(systemPrompt + buildSkillFewShotBlock(topic), userPrompt);
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
