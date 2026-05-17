import { NextResponse } from "next/server";
import { aiText } from "@/lib/aiClient";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import { checkCoachQuota, logCoachCall } from "@/lib/coachQuota";
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

const SYSTEM_TEMPLATE = (contextJson: string) => `You are the ZCORIQ Teacher Coach — a senior pedagogy-savvy mentor helping a classroom teacher interpret their students' quiz data.

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
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement now applied to the teacher-coach mutating route.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    // Role check: only teachers can use the Teacher Coach. We deliberately do
    // NOT allow super_teacher here — they have their own (school-wide) coach.
    const { data: prof } = await sb
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!prof || prof.role !== "teacher") {
      // F108 fix: super_teacher has their own school-wide coach at
      // /api/school/coach. Point them there instead of a generic 403.
      const isSuper = prof?.role === "super_teacher";
      return NextResponse.json(
        {
          error: isSuper
            ? "Use the school-wide Coach at /api/school/coach instead — it has cross-class context."
            : "Only teachers can use the Teacher Coach.",
        },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const message = safeString(body.message, 1000);
    const history = normaliseHistory(body.history);
    if (!message) {
      return NextResponse.json({ error: "Message is required." }, { status: 400 });
    }

    // Coach quota gate — see lib/coachQuota.ts. Teachers inherit
    // the school's plan, so the same Pilot=0 / Standard=50 / Plus=∞
    // ladder applies. Returns 402 when over quota.
    const gate = await checkCoachQuota(user.id, "teacher");
    if (!gate.allowed) {
      return NextResponse.json(
        {
          error: gate.reason,
          code: "coach_quota_exceeded",
          planSlug: gate.planSlug,
          used: gate.used,
          limit: gate.limit,
        },
        { status: 402 }
      );
    }

    const ctx = await buildTeacherContext(user.id);
    const ctxJson = JSON.stringify(ctx, null, 2);
    const system = SYSTEM_TEMPLATE(ctxJson);

    const userPrompt = history.length > 0
      ? `${transcript(history)}\n\nTeacher: ${message}\n\nCoach:`
      : `Teacher: ${message}\n\nCoach:`;

    const reply = await aiText(system, userPrompt);

    // Log AFTER the LLM responds so transient failures don't burn quota.
    await logCoachCall(user.id, "teacher");

    return NextResponse.json({
      reply,
      contextSnapshot: { asOf: ctx.asOf, totals: ctx.totals },
      quota: { planSlug: gate.planSlug, used: gate.used + 1, limit: gate.limit },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Coach failed to respond." }, { status: 500 });
  }
}
