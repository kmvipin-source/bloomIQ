import { NextResponse } from "next/server";
import { groqText } from "@/lib/groq";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import { buildSchoolContext } from "@/lib/schoolContext";
import { checkCoachQuota, logCoachCall } from "@/lib/coachQuota";

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

const SYSTEM_TEMPLATE = (contextJson: string) => `You are the ZCORIQ Principal Coach — a senior data-savvy school administrator who helps the Principal interpret their school's quiz performance data. You have access to the school's current state as a JSON object.

Rules:
- Answer in 2-5 short paragraphs OR a tight bulleted list. Never wall-of-text.
- ALWAYS cite specific numbers from the JSON (avg scores, student names, deltas) — vague answers are useless to a Principal.
- When you mention a student by name (top performers, at-risk, anyone), ALWAYS append their class in parentheses, e.g. "Aanya (Grade 7 - Biology B)" — the class name comes from the \`class\` field next to each name in the JSON. A list of names without classes is unusable: the Principal can't tell which teacher to follow up with. If a student's class is null, it's fine to omit.
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
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    // Role + school check. We only let super_teachers in — they're the only
    // role that's supposed to see school-wide aggregates. Use service-role
    // for the lookup so an RLS race on the first request after sign-in
    // doesn't 403 a legitimate Head.
    const adminClient = supabaseAdmin();
    const { data: prof } = await adminClient
      .from("profiles")
      .select("role, school_id")
      .eq("id", user.id)
      .maybeSingle();
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

    // Coach quota gate — Pilot=0, Standard=50/30d, Plus=∞. Returns
    // 402 with the relevant plan + usage so the UI can render an
    // upgrade nudge. We check BEFORE calling the LLM so we don't
    // burn LLM tokens for users over quota.
    const gate = await checkCoachQuota(user.id, "school");
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

    const ctx = await buildSchoolContext(prof.school_id as string);
    const ctxJson = JSON.stringify(ctx, null, 2);
    const system = SYSTEM_TEMPLATE(ctxJson);

    const userPrompt = history.length > 0
      ? `${transcript(history)}\n\nPrincipal: ${message}\n\nCoach:`
      : `Principal: ${message}\n\nCoach:`;

    const reply = await groqText(system, userPrompt);

    // Log AFTER a successful LLM round-trip so transient failures
    // don't burn the user's quota.
    await logCoachCall(user.id, "school");

    return NextResponse.json({
      reply,
      contextSnapshot: { asOf: ctx.asOf, totals: ctx.totals },
      // Echo current quota so the UI can render "12 of 50 used".
      quota: {
        planSlug: gate.planSlug,
        used: gate.used + 1,
        limit: gate.limit,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Coach failed to respond." },
      { status: 500 }
    );
  }
}
