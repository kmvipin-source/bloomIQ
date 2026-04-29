import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";

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
 */
export async function POST(req: Request) {
  try {
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

    const user = (
      `Make ${count} flashcards.\n` +
      (topic ? `Topic: ${topic}\n` : "") +
      `Bloom level: ${bloom}\n` +
      `Cards should drill ${bloom}. Guideline: ${guide}\n` +
      "Return JSON: { \"cards\": [{ \"front\": string, \"back\": string }, ...] }"
    );

    const json = (await groqJSON(sys, user)) as { cards?: Array<{ front: string; back: string }> };
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
