import { NextResponse } from "next/server";
import { groqText } from "@/lib/groq";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { buildStudentContext } from "@/lib/studentContext";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// POST /api/student/coach
// -----------------------------------------------------------------------------
// Body: { message: string, history?: Array<{role:'user'|'assistant', content:string}> }
//
// The Student Coach: chat-style endpoint that lets a student reflect on their
// own quiz performance and habits. We build a compact JSON snapshot via
// buildStudentContext, embed it in the system prompt, and let Groq answer in
// 2-4 short paragraphs or bullets. The Coach is a PERFORMANCE coach — NOT a
// subject-matter tutor (the Tutor is a separate feature).
// =============================================================================

type ChatTurn = { role: "user" | "assistant"; content: string };

const SYSTEM_TEMPLATE = (contextJson: string) => `You are the BloomIQ Student Coach — a supportive performance coach helping a student understand their own quiz performance and habits. NOT a subject-matter tutor (that's a different feature).

Use the JSON snapshot below to answer concretely.

Rules:
- 2-4 short paragraphs OR a tight bulleted list. Never long essays.
- ALWAYS cite specific numbers from the JSON (your scores, your streak, your bloom levels, your trend).
- Stay encouraging but honest — call out slipping areas without being harsh.
- If asked subject-content questions ("how does photosynthesis work?"), redirect: "I'm your performance coach — for content help try the Tutor. But I can tell you that your Apply level on Photosynthesis is currently 42%."
- Suggest specific next-action study advice (e.g. "try 5 Apply-level questions on Polynomials tonight").
- Never invent data. Never reveal the JSON structure.
- Tone: friendly, motivating, like a senior peer or favorite teacher. Emoji OK if the student uses them.

Your data:
${contextJson}`;

function safeString(x: unknown, max = 4000): string {
  if (typeof x !== "string") return "";
  const trimmed = x.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function normaliseHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as { role?: unknown; content?: unknown };
    const role = obj.role === "user" || obj.role === "assistant" ? obj.role : null;
    const content = safeString(obj.content, 2000);
    if (!role || !content) continue;
    out.push({ role, content });
  }
  // Cap to last 10 turns.
  return out.slice(-10);
}

function transcript(history: ChatTurn[]): string {
  return history
    .map((t) => (t.role === "user" ? `You: ${t.content}` : `Coach: ${t.content}`))
    .join("\n");
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Role check: only students can use the Student Coach.
    const { data: prof } = await sb
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!prof || prof.role !== "student") {
      return NextResponse.json(
        { error: "Only students can use the Student Coach." },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const message = safeString(body.message, 1000);
    const history = normaliseHistory(body.history);
    if (!message) {
      return NextResponse.json({ error: "Message is required." }, { status: 400 });
    }

    const ctx = await buildStudentContext(user.id);
    const ctxJson = JSON.stringify(ctx, null, 2);
    const system = SYSTEM_TEMPLATE(ctxJson);

    const userPrompt = history.length > 0
      ? `${transcript(history)}\n\nYou: ${message}\n\nCoach:`
      : `You: ${message}\n\nCoach:`;

    const reply = await groqText(system, userPrompt);

    return NextResponse.json({
      reply,
      contextSnapshot: { asOf: ctx.asOf, totals: ctx.totals },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Coach failed to respond." },
      { status: 500 }
    );
  }
}
