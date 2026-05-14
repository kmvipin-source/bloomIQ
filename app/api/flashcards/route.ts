import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import {
  loadLearningContext,
  prependLearningContext,
  buildExamAwareTopic,
} from "@/lib/learningContext";
import { buildSkillFewShotBlock } from "@/lib/skillFewShot";
import { consumeDailyQuota } from "@/lib/freeQuota";

export const runtime = "nodejs";

/**
 * POST /api/flashcards
 *
 * Body: { topic?: string, bloom_level?: string, count?: number }
 *
 * Returns 6-10 study flashcards (front=concept, back=explanation) tuned for
 * the given Bloom level. If no topic is given, the cards span common weak
 * areas at that level. Pure helper — no DB writes; the page caches results
 * per session in browser state.
 *
 * Auth: bearer token required. Previously this route accepted anonymous
 * callers and would happily fire Groq generations at company cost; an
 * attacker pointing a loop at it could drain the LLM budget without
 * ever creating an account.
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const dq = await consumeDailyQuota(user.id, "flashcards");
    if (!dq.allowed) return NextResponse.json({ error: dq.reason, code: "free_daily_cap" }, { status: 402 });

    const body = await req.json().catch(() => ({}));
    const topic: string = String(body.topic || "").trim();
    const bloom: string = String(body.bloom_level || "Understand").trim();
    const count = Math.min(Math.max(Number(body.count) || 8, 4), 12);

    const sys = (
      "You are a study coach building flashcards. Return strict JSON only. " +
      "Each card has a short, focused 'front' (concept, definition, or question) " +
      "of 1-2 lines, and a 'back' that's a 2-4 line explanation, " +
      "tuned to the requested Bloom\u2019s taxonomy level. " +
      "Do not include numbering or markdown."
    );
    const lvlHints: Record<string, string> = {
      Remember:   "Front = a fact, term, or definition. Back = the precise meaning.",
      Understand: "Front = a concept question. Back = an explanation in plain language.",
      Apply:      "Front = a small worked-problem prompt. Back = the steps + answer.",
      Analyze:    "Front = a short scenario or comparison prompt. Back = the analytical reasoning that resolves it.",
      Evaluate:   "Front = a judgment-call prompt. Back = the criteria + a defended verdict.",
      Create:     "Front = a design / synthesis prompt. Back = a sample original answer outline.",
    };
    const guide = lvlHints[bloom] || lvlHints.Understand;

    // Learning-context inheritance — flashcards must match the student's
    // exam register. A CAT student studying "Newton's laws" should get
    // cards pitched at CAT difficulty, not Class-10. User can always
    // change their exam_goal from the master settings page.
    const admin = supabaseAdmin();
    const ctx = await loadLearningContext(admin, user.id);
    const contextAwareTopic = buildExamAwareTopic(topic, ctx);
    // Niche-skill few-shot grounding (2026-05-14). When the topic is a
    // niche IT/fintech/security skill (JCL, COBOL, ISO 8583, HSM, RACF,
    // etc.), inject 2-3 real-shape example stems so the LLM doesn't
    // hallucinate generic CS framings. See lib/skillFewShot.ts.
    const contextAwareSys = prependLearningContext(sys, ctx) + buildSkillFewShotBlock(topic);

    const prompt = (
      `Make ${count} flashcards.\n` +
      (topic ? `Topic: ${contextAwareTopic}\n` : "") +
      `Bloom level: ${bloom}\n` +
      `Cards should drill ${bloom}. Guideline: ${guide}\n` +
      "Return JSON: { \"cards\": [{ \"front\": string, \"back\": string }, ...] }"
    );

    const json = (await groqJSON(contextAwareSys, prompt)) as { cards?: Array<{ front: string; back: string }> };
    const cards = (json.cards || [])
      .filter((c) => c && typeof c.front === "string" && typeof c.back === "string")
      .map((c) => ({ front: c.front.trim(), back: c.back.trim() }))
      .slice(0, count);

    return NextResponse.json({ ok: true, cards, bloom_level: bloom, topic: topic || null });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate flashcards" },
      { status: 500 }
    );
  }
}
