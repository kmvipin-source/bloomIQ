import { NextResponse } from "next/server";
import { groqText } from "@/lib/groq";
import { aiGate } from "@/lib/aiGate";
import { checkDailyQuota, recordDailyUse } from "@/lib/freeQuota";

export const runtime = "nodejs";
export const maxDuration = 30;

// =============================================================================
// POST /api/tutor/chat
// -----------------------------------------------------------------------------
// Body: {
//   context?: { question_stem?: string, options?: string[], correct_index?: number, topic?: string },
//   history: Array<{ role: 'user' | 'assistant', content: string }>,
//   message: string
// }
//
// Stateless Socratic-style tutor. v1 keeps NO server-side persistence — the
// client owns the chat history and sends it back each turn. Lower DB blast
// radius; we can add a tutor_sessions table later if persistence proves worth it.
// =============================================================================

const SYSTEM = `You are a warm, helpful teacher whose job is to actually clarify the concept a student is stuck on. You are NOT a Socratic interrogator — students who are confused don't want a barrage of "what do YOU think?" questions, they want help.

Your style — IMPORTANT:
- Lead with a clear, direct explanation. Give the actual answer or core idea up front, in 2–4 short sentences a student can grasp.
- Use a concrete example or analogy whenever possible. ("Think of it like a bank account where energy is currency...")
- Only AFTER you've explained, ask ONE short check-in question — like "does that part make sense before we go to the next step?" — to see if they followed.
- If they ask for the answer, GIVE the answer plainly. Do not refuse, do not turn it into 5 questions back at them.
- If they're working through a multi-step problem, walk them through each step's reasoning. Show your working, don't hide it behind questions.
- When they get something wrong on a follow-up, gently point out the specific misstep, then re-explain that piece — don't just ask them to try again with no new information.
- Use short paragraphs. Use a bullet list only when listing 3+ comparable items.
- Stay strictly on the topic the student asked about. Don't pivot to broader study advice unless asked.
- Keep replies under ~150 words unless the student explicitly asks for more depth.

You may be given context — a specific question stem and options the student is stuck on. If so, anchor your explanation to it.

Tone: warm, plainspoken, like a tutor sitting next to them. Hindi/English code-mixed input is fine; reply in clean English unless they ask otherwise.`;

type Turn = { role: "user" | "assistant"; content: string };

function clean(turns: unknown): Turn[] {
  if (!Array.isArray(turns)) return [];
  return (turns as unknown[])
    .map((t) => {
      const o = (t || {}) as Record<string, unknown>;
      const role = String(o.role || "");
      const content = String(o.content || "").trim();
      if (!content) return null;
      if (role !== "user" && role !== "assistant") return null;
      return { role, content };
    })
    .filter((t): t is Turn => t !== null)
    .slice(-20); // hard cap so no one balloons the prompt
}

export async function POST(req: Request) {
  try {
    // aiGate: auth + per-user rate limit. Tutor chat is high-volume so
    // capacity is generous (40 burst, ~120/hr steady state).
    const gate = await aiGate(req, {
      route: "tutor.chat",
      rateLimit: { capacity: 40, refillPerHour: 120 },
    });
    if (!gate.ok) return gate.response;

    // Showcase-Free daily cap. Paid users pass through.
    const dq = await checkDailyQuota(gate.userId, "tutor_chat");
    if (!dq.allowed) return NextResponse.json({ error: dq.reason, code: "free_daily_cap" }, { status: 402 });

    const body = await req.json().catch(() => ({}));
    const message: string = String(body.message || "").trim();
    if (!message) return NextResponse.json({ error: "Empty message" }, { status: 400 });
    if (message.length > 2000) return NextResponse.json({ error: "Message too long (max 2000 chars)." }, { status: 400 });

    const history = clean(body.history);
    const ctx = (body.context || {}) as Record<string, unknown>;
    const ctxStem = typeof ctx.question_stem === "string" ? ctx.question_stem.slice(0, 1500) : "";
    const ctxOptions = Array.isArray(ctx.options) ? (ctx.options as unknown[]).map(String).slice(0, 4) : [];
    const ctxCorrect = Number.isInteger(ctx.correct_index) ? Number(ctx.correct_index) : null;
    const ctxTopic = typeof ctx.topic === "string" ? ctx.topic.slice(0, 200) : "";

    // Build a rolling-context prompt. We use groqText (plain text completion)
    // since this is conversational; structured-JSON adds friction here.
    const contextBlock = ctxStem
      ? `Anchor question the student is stuck on:
"""
${ctxStem}
"""
${ctxOptions.length > 0 ? `Options: ${ctxOptions.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(" | ")}\n` : ""}${ctxCorrect !== null ? `Correct option index: ${ctxCorrect}\n` : ""}${ctxTopic ? `Topic: ${ctxTopic}\n` : ""}
Use this as the anchor — don't drift to other questions.

`
      : "";

    const historyBlock = history.length > 0
      ? `Conversation so far:
${history.map((t) => `${t.role === "user" ? "STUDENT" : "TEACHER"}: ${t.content}`).join("\n\n")}

`
      : "";

    const userPrompt = `${contextBlock}${historyBlock}STUDENT: ${message}

TEACHER:`;

    const reply = await groqText(SYSTEM, userPrompt);
    if (!reply) {
      return NextResponse.json({ error: "AI did not return a reply; please retry." }, { status: 502 });
    }

    await recordDailyUse(gate.userId, "tutor_chat");

    return NextResponse.json({ ok: true, reply });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Tutor failed" },
      { status: 500 }
    );
  }
}
