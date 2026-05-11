import { NextResponse } from "next/server";
import { groqText } from "@/lib/groq";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// GET /api/qbank/[id]/solution
// -----------------------------------------------------------------------------
// Generates a worked, step-by-step solution for a question. Any authenticated
// caller may request this — students need it on review pages too.
// We cache results in-memory per process (best-effort); production would back
// this with a real cache, but this keeps repeated views snappy in v1.
// =============================================================================

type SourceRow = {
  id: string;
  stem: string;
  options: unknown;
  correct_index: number;
  explanation: string | null;
  topic: string | null;
  bloom_level: string;
  status: string;
};

type RouteCtx = { params: Promise<{ id: string }> };

const SYSTEM = `You are a patient teacher writing a clear, step-by-step worked solution for an MCQ.

Format: short title line, then a markdown bullet list (5–10 bullets max). Show the reasoning, not just the answer. End with one short reflection sentence ("Watch out for…" or "Common confusion…").
Do NOT include "Answer:" lines — assume the reader already knows the correct option. Plain text + simple markdown only.`;

const cache = new Map<string, { solution: string; generated_at: string }>();

function asOptions(x: unknown): string[] | null {
  if (!Array.isArray(x)) return null;
  if (x.length !== 4) return null;
  if (!x.every((v) => typeof v === "string")) return null;
  return x as string[];
}

export async function GET(req: Request, ctx: RouteCtx) {
  try {
    const { id } = await ctx.params;
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const rate = checkRateLimit(user.id, "qbank.solution", { capacity: 20, refillPerHour: 60 });
    if (!rate.allowed) return NextResponse.json({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });

    const cached = cache.get(id);
    if (cached) return NextResponse.json(cached);

    const { data: q } = await sb
      .from("question_bank")
      .select("id, stem, options, correct_index, explanation, topic, bloom_level, status")
      .eq("id", id)
      .maybeSingle();
    if (!q) return NextResponse.json({ error: "Question not found." }, { status: 404 });
    const source = q as SourceRow;
    const opts = asOptions(source.options);
    if (!opts) return NextResponse.json({ error: "Question has malformed options." }, { status: 400 });

    const correctLetter = "ABCD"[source.correct_index] || "?";
    const userPrompt = `Topic: ${source.topic || "(unspecified)"}
Bloom level: ${source.bloom_level}

Question: ${source.stem}
A) ${opts[0]}
B) ${opts[1]}
C) ${opts[2]}
D) ${opts[3]}

Correct answer: ${correctLetter}) ${opts[source.correct_index]}
Author note (optional): ${source.explanation || "(none)"}

Write a step-by-step worked solution that walks the student through the reasoning. 5–10 bullets. End with one short watch-out reflection.`;

    let solution = "";
    try {
      solution = await groqText(SYSTEM, userPrompt);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Generation failed" }, { status: 502 });
    }
    if (!solution) {
      return NextResponse.json({ error: "AI returned no solution." }, { status: 502 });
    }

    const out = { solution, generated_at: new Date().toISOString() };
    cache.set(id, out);
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Solution failed" }, { status: 500 });
  }
}
