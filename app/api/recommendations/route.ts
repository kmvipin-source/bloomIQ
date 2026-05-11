import { NextResponse } from "next/server";
import { groqText } from "@/lib/groq";
import { BLOOM_META, type BloomLevel } from "@/lib/bloom";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

const SYSTEM = `You are a kind, encouraging tutor. Given a student's per-Bloom-level
performance on a quiz, write a short, specific 4-bullet study plan. Speak directly to the student.
Be concrete (e.g. "try summarizing each section in your own words"), not generic.
Keep each bullet to 1-2 sentences. Use simple language a school student can act on today.`;

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const rate = checkRateLimit(user.id, "recommendations", { capacity: 10, refillPerHour: 30 });
    if (!rate.allowed) return NextResponse.json({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });

    const body = await req.json();
    const score: number = body.score || 0;
    const total: number = body.total || 0;
    const quizName: string = body.quizName || "the quiz";
    const levels: { level: BloomLevel; c: number; t: number }[] = body.levels || [];

    const lines = levels
      .filter((l) => l.t > 0)
      .map((l) => `- ${BLOOM_META[l.level].label}: ${l.c}/${l.t} correct (${BLOOM_META[l.level].description})`)
      .join("\n");

    const text = await groqText(
      SYSTEM,
      `Student took "${quizName}" and scored ${score}/${total}.
Per-level performance:
${lines}

Write the study plan now.`
    );

    return NextResponse.json({ text });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
