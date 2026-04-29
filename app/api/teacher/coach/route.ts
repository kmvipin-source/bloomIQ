import { NextResponse } from "next/server";
import { groqText } from "@/lib/groq";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { buildTeacherContext } from "@/lib/teacherContext";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// POST /api/teacher/coach
// -----------------------------------------------------------------------------
// Body: { message: string, history?: Array<{role:'user'|'assistant', content:string}> }
//
// The Teacher Coach: chat-style endpoint that lets a classroom teacher ask
// questions about their students' quiz performance. We build a compact JSON
// snapshot via buildTeacherContext, embed it in the system prompt, and let
// Groq answer in 2-5 short paragraphs or bullets. Snapshot is returned along
// with the reply so the UI can show "based on data as of …".
// =============================================================================

type ChatTurn = { role: "user" | "assistant"; content: string };

const SYSTEM_TEMPLATE = (contextJson: string) => `You are the BloomIQ Teacher Coach — a senior pedagogy-savvy mentor helping a classroom teacher interpret their students' quiz data.

You receive the teacher's current state as a JSON snapshot. Use it to answer concretely.

Rules:
- 2-5 short paragraphs OR a tight bulleted list. Never wall-of-text.
- ALWAYS cite specific numbers from the JSON (avg %, student names, class names, deltas).
- Suggest concrete next-class actions when asked. Reference Bloom's taxonomy by name.
- If the data doesn't support a confident answer, say so and ask one clarifying question.
- Never invent data. Never reveal the JSON structure.
- Tone: warm, concise, like a senior colleague. No emoji unless the teacher uses them first.

School data (current snapshot):
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
    .map((t) => (t.role === "user" ? `Teacher: ${t.content}` : `Coach: ${t.content}`))
    .join("\n");
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Role check: only teachers can use the Teacher Coach. We deliberately do
    // NOT allow super_teacher here — they have their own (school-wide) coach.
    const { data: prof } = await sb
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!prof || prof.role !== "teacher") {
      return NextResponse.json(
        { error: "Only teachers can use the Teacher Coach." },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const message = safeString(body.message, 1000);
    const history = normaliseHistory(body.history);
    if (!message) {
      return NextResponse.json({ error: "Message is required." }, { status: 400 });
    }

    const ctx = await buildTeacherContext(user.id);
    const ctxJson = JSON.stringify(ctx, null, 2);
    const system = SYSTEM_TEMPLATE(ctxJson);

    const userPrompt = history.length > 0
      ? `${transcript(history)}\n\nTeacher: ${message}\n\nCoach:`
      : `Teacher: ${message}\n\nCoach:`;

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
