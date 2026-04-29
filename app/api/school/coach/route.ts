import { NextResponse } from "next/server";
import { groqText } from "@/lib/groq";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { buildSchoolContext } from "@/lib/schoolContext";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// POST /api/school/coach
// -----------------------------------------------------------------------------
// Body: { message: string, history?: Array<{role:'user'|'assistant', content:string}> }
//
// The Principal AI Coach: chat-style endpoint that lets a school admin
// (super_teacher) ask questions about their school's quiz performance. We
// build a compact JSON snapshot of the school via buildSchoolContext, embed
// it in the system prompt, and let Groq answer in 2-5 short paragraphs or
// bullets. Snapshot is returned alongside the reply so the UI can show
// "based on data as of …".
// =============================================================================

type ChatTurn = { role: "user" | "assistant"; content: string };

const SYSTEM_TEMPLATE = (contextJson: string) => `You are the BloomIQ Principal Coach — a senior data-savvy school administrator who helps the Principal interpret their school's quiz performance data. You have access to the school's current state as a JSON object.

Rules:
- Answer in 2-5 short paragraphs OR a tight bulleted list. Never wall-of-text.
- ALWAYS cite specific numbers from the JSON (avg scores, student names, deltas) — vague answers are useless to a Principal.
- If the data doesn't support a confident answer, say so and ask one clarifying question.
- Never invent data. If a number isn't in the JSON, don't fabricate it.
- Never reveal the JSON structure to the user. Speak as a colleague would.
- Tone: warm but precise, like a trusted senior colleague. No emoji unless the Principal uses them first.

Here is the school's current state:
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
    .map((t) => (t.role === "user" ? `Principal: ${t.content}` : `Coach: ${t.content}`))
    .join("\n");
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Role + school check. We only let super_teachers in — they're the only
    // role that's supposed to see school-wide aggregates.
    const { data: prof } = await sb
      .from("profiles")
      .select("role, school_id")
      .eq("id", user.id)
      .single();
    if (!prof || prof.role !== "super_teacher") {
      return NextResponse.json(
        { error: "Only school admins can use the coach." },
        { status: 403 }
      );
    }
    if (!prof.school_id) {
      return NextResponse.json(
        { error: "Set up your school first to use the coach." },
        { status: 400 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const message = safeString(body.message, 1000);
    const history = normaliseHistory(body.history);
    if (!message) {
      return NextResponse.json({ error: "Message is required." }, { status: 400 });
    }

    const ctx = await buildSchoolContext(prof.school_id as string);
    const ctxJson = JSON.stringify(ctx, null, 2);
    const system = SYSTEM_TEMPLATE(ctxJson);

    const userPrompt = history.length > 0
      ? `${transcript(history)}\n\nPrincipal: ${message}\n\nCoach:`
      : `Principal: ${message}\n\nCoach:`;

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
