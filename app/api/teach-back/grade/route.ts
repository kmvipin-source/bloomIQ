import { NextResponse } from "next/server";
import { aiJSON } from "@/lib/aiClient";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";
import { aiGate } from "@/lib/aiGate";
import { consumeDailyQuota } from "@/lib/freeQuota";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  loadLearningContext,
  prependLearningContext,
  buildExamAwareTopic,
} from "@/lib/learningContext";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// POST /api/teach-back/grade
// -----------------------------------------------------------------------------
// Body: { topic: string, explanation: string }
//
// Takes a student's free-text "explain it back to me" attempt on a topic, asks
// Groq to grade it on Bloom's taxonomy (0–5 per level, weighted toward higher
// levels), and produces:
//   - strengths: what the student clearly understands
//   - gaps:     specific things they got wrong / didn't say
//   - follow_up_q: a Socratic question that probes the *deepest* gap
//
// We then persist the whole thing to teach_back_sessions so the user can browse
// past attempts and watch their explanations get sharper over time.
// =============================================================================

const SYSTEM = `You are an expert teacher grading a student's explanation of a topic using Bloom's taxonomy.

You score each Bloom level from 0–5 based ONLY on what the student demonstrated:
- remember (0–5): Did they recall correct facts and definitions?
- understand (0–5): Did they explain the concept in their own words, not just regurgitate?
- apply (0–5): Did they show how the concept is used in a real situation?
- analyze (0–5): Did they break the concept down into parts or compare related ideas?
- evaluate (0–5): Did they judge limitations, trade-offs, or when the concept does not apply?
- create (0–5): Did they synthesize new examples, analogies, or extensions?

Lower levels can score high even if higher levels score 0 — that's normal for short explanations.
Be honest and slightly strict: if a student only restated the definition, "understand" is at most 2.

Then write:
- "strengths": 2–4 short bullet points of what the student got right.
- "gaps": 2–4 short bullet points of specific factual or conceptual things they MISSED or got wrong. Be concrete ("did not mention that chlorophyll absorbs blue and red but reflects green").
- "follow_up_q": ONE pointed Socratic question that probes the single biggest gap. Do NOT give the answer in the question.

Respond with VALID JSON only, no commentary:
{
  "bloom_scores": { "remember": 0, "understand": 0, "apply": 0, "analyze": 0, "evaluate": 0, "create": 0 },
  "strengths": ["..."],
  "gaps": ["..."],
  "follow_up_q": "..."
}`;

type Grade = {
  bloom_scores: Record<BloomLevel, number>;
  strengths: string[];
  gaps: string[];
  follow_up_q: string;
};

// Higher Bloom levels carry more weight in the overall composite — a great
// "Apply" answer is worth more than a great "Remember" answer. Weights sum to 1.
const BLOOM_WEIGHTS: Record<BloomLevel, number> = {
  remember: 0.05,
  understand: 0.15,
  apply: 0.20,
  analyze: 0.20,
  evaluate: 0.20,
  create: 0.20,
};

function clamp05(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(5, Math.round(x)));
}

function normalizeGrade(raw: Record<string, unknown>): Grade {
  const rawScores = (raw.bloom_scores as Record<string, unknown>) || {};
  const bloom_scores = {} as Record<BloomLevel, number>;
  for (const lvl of BLOOM_LEVELS) bloom_scores[lvl] = clamp05(rawScores[lvl]);
  // Per-item length cap so the LLM can't pad a single strength/gap with
  // a paragraph that bloats teach_back_sessions rows. follow_up_q also
  // capped — a 4KB question doesn't help anyone.
  const capStr = (s: unknown): string => String(s).trim().replace(/[<>]/g, "").slice(0, 220);
  const strengths = Array.isArray(raw.strengths) ? (raw.strengths as unknown[]).map(capStr).filter(Boolean).slice(0, 6) : [];
  const gaps = Array.isArray(raw.gaps) ? (raw.gaps as unknown[]).map(capStr).filter(Boolean).slice(0, 6) : [];
  const follow_up_q = typeof raw.follow_up_q === "string" ? capStr(raw.follow_up_q).slice(0, 400) : "";
  return { bloom_scores, strengths, gaps, follow_up_q };
}

function compositeOverall(scores: Record<BloomLevel, number>): number {
  // Each level is 0–5, weights sum to 1, so weighted_sum is 0–5. Multiply by 20
  // to get a friendly 0–100 mastery number.
  let acc = 0;
  for (const lvl of BLOOM_LEVELS) acc += (scores[lvl] || 0) * BLOOM_WEIGHTS[lvl];
  return Math.round(acc * 20);
}

export async function POST(req: Request) {
  try {
    const gate = await aiGate(req, {
      route: "teach-back.grade",
      rateLimit: { capacity: 20, refillPerHour: 30 },
    });
    if (!gate.ok) return gate.response;
    const user = { id: gate.userId };

    const dq = await consumeDailyQuota(user.id, "teach_back");
    if (!dq.allowed) return NextResponse.json({ error: dq.reason, code: "free_daily_cap" }, { status: 402 });

    const body = await req.json().catch(() => ({}));
    const topic: string = String(body.topic || "").trim();
    const explanation: string = String(body.explanation || "").trim();
    if (!topic) return NextResponse.json({ error: "Topic is required." }, { status: 400 });
    if (explanation.length < 30) {
      return NextResponse.json(
        { error: "Please write at least a couple of sentences (30+ characters) so we can grade fairly." },
        { status: 400 }
      );
    }
    if (explanation.length > 4000) {
      return NextResponse.json({ error: "Explanation is too long (max 4000 characters)." }, { status: 400 });
    }

    // Service-role client. Previously this route referenced an undeclared
    // `sb` further down — never caught because the AI-gate happy path
    // also threw before reaching the insert in dev. Renamed + declared
    // explicitly. Doubles as the source for loadLearningContext below.
    const sb = supabaseAdmin();

    // Learning-context inheritance — the Socratic follow-up question is
    // NEW content (Vipin caught teach-back as a gap on 2026-05-12). A CAT
    // student explaining "elasticity" should get a CAT-flavoured probe,
    // not a Class-10 physics one. Same pattern as every other generation
    // endpoint; the user can change exam_goal from the master settings.
    const ctx = await loadLearningContext(sb, user.id);
    const contextAwareTopic = buildExamAwareTopic(topic, ctx);
    const contextAwareSystem = prependLearningContext(SYSTEM, ctx);

    const userPrompt = `Topic: ${contextAwareTopic}\n\nStudent's explanation:\n"""\n${explanation}\n"""\n\nGrade it strictly per the rubric and return JSON only.`;
    const raw = await aiJSON(contextAwareSystem, userPrompt);
    const grade = normalizeGrade(raw);
    const overall_score = compositeOverall(grade.bloom_scores);

    const { data: row, error: insErr } = await sb
      .from("teach_back_sessions")
      .insert({
        user_id: user.id,
        topic,
        explanation,
        bloom_scores: grade.bloom_scores,
        overall_score,
        strengths: grade.strengths,
        gaps: grade.gaps,
        follow_up_q: grade.follow_up_q || null,
      })
      .select("id, created_at")
      .single();
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      id: row.id,
      created_at: row.created_at,
      overall_score,
      bloom_scores: grade.bloom_scores,
      strengths: grade.strengths,
      gaps: grade.gaps,
      follow_up_q: grade.follow_up_q,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Teach-Back grading failed" },
      { status: 500 }
    );
  }
}
