import { NextResponse } from "next/server";
import { groqText } from "@/lib/groq";
import { BLOOM_META, type BloomLevel } from "@/lib/bloom";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

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
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
