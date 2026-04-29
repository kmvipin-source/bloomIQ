import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { isBloomLevel, type BloomLevel, BLOOM_META } from "@/lib/bloom";
import { verifyAnswerKeys, type VerifiableQuestion } from "@/lib/qgen";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// POST /api/qbank/[id]/variants
// -----------------------------------------------------------------------------
// Generates 3 isomorphic variants of a teacher's source question — same Bloom
// level, same concept, different numbers/wording/scenarios. Each candidate is
// re-verified by Groq. We return the candidates without saving so the teacher
// can review and pick which (if any) to add to their bank.
// =============================================================================

type SourceRow = {
  id: string;
  owner_id: string;
  topic: string | null;
  bloom_level: string;
  stem: string;
  options: unknown;
  correct_index: number;
  explanation: string | null;
};

type GenVariant = {
  stem: string;
  options: string[];
  correct_index: number;
  explanation?: string;
};

type RouteCtx = { params: Promise<{ id: string }> };

const SYSTEM = `You are an expert curriculum designer producing ISOMORPHIC question variants.

Given a source MCQ, you generate variants that:
- Test the SAME concept and skill at the SAME Bloom's-taxonomy level
- Use DIFFERENT numbers, names, scenarios, phrasing
- Have exactly 4 options with a single unambiguous correct answer
- Are not trivial paraphrases of the original

Return STRICT JSON only.`;

function asOptions(x: unknown): string[] | null {
  if (!Array.isArray(x)) return null;
  if (x.length !== 4) return null;
  if (!x.every((v) => typeof v === "string")) return null;
  return x as string[];
}

export async function POST(req: Request, ctx: RouteCtx) {
  try {
    const { id } = await ctx.params;
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: src, error: srcErr } = await sb
      .from("question_bank")
      .select("id, owner_id, topic, bloom_level, stem, options, correct_index, explanation")
      .eq("id", id)
      .maybeSingle();
    if (srcErr || !src) {
      return NextResponse.json({ error: "Source question not found." }, { status: 404 });
    }
    const source = src as SourceRow;
    if (source.owner_id !== user.id) {
      return NextResponse.json({ error: "You don't own this question." }, { status: 403 });
    }
    if (!isBloomLevel(source.bloom_level)) {
      return NextResponse.json({ error: "Source has invalid Bloom level." }, { status: 400 });
    }
    const opts = asOptions(source.options);
    if (!opts) return NextResponse.json({ error: "Source has malformed options." }, { status: 400 });

    const lvl: BloomLevel = source.bloom_level;
    const userPrompt = `Source question (do NOT repeat verbatim):
Topic: ${source.topic || "(unspecified)"}
Bloom level: ${lvl} — ${BLOOM_META[lvl].description}
Stem: ${source.stem}
A) ${opts[0]}
B) ${opts[1]}
C) ${opts[2]}
D) ${opts[3]}
Correct: ${"ABCD"[source.correct_index]}
Explanation: ${source.explanation || "(none)"}

Generate exactly 3 ISOMORPHIC variants — same concept, same Bloom level, different surface details. Each variant must have 4 options and a single correct_index (0..3).

Return JSON of the form:
{ "variants": [ { "stem": "...", "options": ["A","B","C","D"], "correct_index": 0, "explanation": "..." } ] }`;

    let raw: Record<string, unknown>;
    try {
      raw = await groqJSON(SYSTEM, userPrompt);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Generation failed" }, { status: 502 });
    }
    const arr: GenVariant[] = Array.isArray((raw as { variants?: GenVariant[] })?.variants)
      ? ((raw as { variants: GenVariant[] }).variants)
      : [];

    const cleaned: GenVariant[] = [];
    for (const v of arr) {
      if (!v || typeof v.stem !== "string") continue;
      if (!Array.isArray(v.options) || v.options.length !== 4) continue;
      if (!v.options.every((o) => typeof o === "string")) continue;
      if (!Number.isInteger(v.correct_index) || v.correct_index < 0 || v.correct_index > 3) continue;
      cleaned.push({
        stem: v.stem.trim(),
        options: v.options.map((o) => String(o).trim()),
        correct_index: v.correct_index,
        explanation: typeof v.explanation === "string" ? v.explanation.trim() : "",
      });
    }
    if (cleaned.length === 0) {
      return NextResponse.json({ error: "AI returned no usable variants." }, { status: 502 });
    }

    const verifiable: VerifiableQuestion[] = cleaned.map((v) => ({
      stem: v.stem,
      options: [v.options[0], v.options[1], v.options[2], v.options[3]] as [string, string, string, string],
      correct_index: v.correct_index as 0 | 1 | 2 | 3,
    }));
    const verifyResults = await verifyAnswerKeys(verifiable, 3);

    const out = cleaned
      .map((v, i) => ({
        stem: v.stem,
        options: v.options,
        correct_index: v.correct_index,
        explanation: v.explanation || "",
        bloom_level: lvl,
        topic: source.topic,
        verified: verifyResults[i]?.ok ?? false,
      }))
      .filter((v) => v.verified);

    if (out.length === 0) {
      return NextResponse.json({ error: "All variants failed verification — try again." }, { status: 502 });
    }

    return NextResponse.json({ variants: out });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Variant generation failed" }, { status: 500 });
  }
}
