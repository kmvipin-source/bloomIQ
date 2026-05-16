import { NextResponse } from "next/server";
import { groqText } from "@/lib/groq";
import { BLOOM_META, type BloomLevel } from "@/lib/bloom";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import { checkRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

const SYSTEM_CLASS = `You are a thoughtful instructional coach for a teacher.
Given class-level Bloom-by-level performance, write 2-3 short paragraphs:
1) Where the class is strong and weak (use level names),
2) Likely root causes,
3) Two concrete classroom interventions for next week.
Keep it warm, specific, and actionable. No bullet points, just clear prose.`;

const SYSTEM_REPORT = `You are a school report-card writer. Given a student's per-Bloom-level performance,
write a single-paragraph teacher comment (3-4 sentences) suitable for a printed report card.
Highlight one strength and one area to develop. Be encouraging but honest. No bullet points.`;

export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;
    const rate = checkRateLimit(user.id, "commentary", { capacity: 10, refillPerHour: 20 });
    if (!rate.allowed) return NextResponse.json({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });

    const body = await req.json();
    const kind: "class_summary" | "report_comment" = body.kind || "class_summary";
    const levels: { level: BloomLevel; correct: number; total: number }[] = body.levels || [];

    const lines = levels
      .filter((l) => l.total > 0)
      .map((l) => `- ${BLOOM_META[l.level].label}: ${l.correct}/${l.total}`)
      .join("\n");

    let prompt = "";
    if (kind === "class_summary") {
      prompt = `Class average: ${body.classAvg || 0}%
Per-level performance:
${lines}
At-risk students (under 50%): ${(body.atRisk || []).join(", ") || "none"}

Write the coach summary now.`;
    } else {
      prompt = `Student: ${body.studentName || "Student"}
Score: ${body.score || 0}/${body.total || 0}
Per-level performance:
${lines}

Write the report-card comment now.`;
    }

    const text = await groqText(kind === "class_summary" ? SYSTEM_CLASS : SYSTEM_REPORT, prompt);
    return NextResponse.json({ text });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
