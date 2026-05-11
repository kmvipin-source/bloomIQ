import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 30;

// =============================================================================
// POST /api/teach-back/follow-up
// -----------------------------------------------------------------------------
// Body: { session_id: string, answer: string }
//
// The student answered the AI's Socratic follow-up question. We grade the
// answer and persist the verdict. Light-weight: just one short critique +
// pass/fail-ish judgement, not the full Bloom rubric again.
// =============================================================================

const SYSTEM = `You are a patient teacher reviewing a student's reply to a Socratic follow-up question.

You will be given:
- the original topic
- the student's first explanation
- the follow-up question they were asked
- the student's reply

Write a SHORT verdict (2–4 sentences) that:
1. States plainly whether the reply addresses the gap the question targeted.
2. Points out one specific thing they nailed.
3. Points out one specific thing still missing or wrong.
4. Ends with a single nudge of what to study next.

Respond with VALID JSON only:
{
  "verdict": "..."
}`;

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const rate = checkRateLimit(user.id, "teach-back.follow-up", { capacity: 20, refillPerHour: 30 });
    if (!rate.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Slow down a moment.", code: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } }
      );
    }

    const body = await req.json().catch(() => ({}));
    const session_id: string = String(body.session_id || "");
    const answer: string = String(body.answer || "").trim();
    if (!session_id) return NextResponse.json({ error: "session_id required" }, { status: 400 });
    if (answer.length < 5) return NextResponse.json({ error: "Please type a longer answer." }, { status: 400 });
    if (answer.length > 2000) return NextResponse.json({ error: "Reply too long (max 2000 chars)." }, { status: 400 });

    const { data: session, error: getErr } = await sb
      .from("teach_back_sessions")
      .select("id, user_id, topic, explanation, follow_up_q")
      .eq("id", session_id)
      .single();
    if (getErr || !session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    if (session.user_id !== user.id) return NextResponse.json({ error: "Not yours" }, { status: 403 });
    if (!session.follow_up_q) return NextResponse.json({ error: "No follow-up question to answer." }, { status: 400 });

    const userPrompt = `Topic: ${session.topic}

Original explanation:
"""
${session.explanation}
"""

Follow-up question we asked:
"${session.follow_up_q}"

Student's reply:
"""
${answer}
"""

Write the JSON verdict.`;
    const raw = await groqJSON(SYSTEM, userPrompt);
    const verdict = String((raw as { verdict?: unknown }).verdict || "").trim();
    if (!verdict) {
      return NextResponse.json({ error: "AI did not return a verdict; please try again." }, { status: 502 });
    }

    const { error: upErr } = await sb
      .from("teach_back_sessions")
      .update({ follow_up_a: answer, follow_up_grade: verdict })
      .eq("id", session_id);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, verdict });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Follow-up grading failed" },
      { status: 500 }
    );
  }
}
