import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { buildTeacherContext } from "@/lib/teacherContext";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// POST /api/teacher/digest
// -----------------------------------------------------------------------------
// Generates this week's brief for a classroom teacher. No body. Same auth +
// role check as the coach (teacher only). We hand the JSON teacher snapshot
// to Groq with a strict response shape and surface it back to the UI.
// =============================================================================

type DigestIssue = {
  title: string;
  detail: string;
  priority: "high" | "medium" | "low";
};
type DigestWin = { title: string; detail: string };
type DigestAction = {
  title: string;
  detail: string;
  when: "this_class" | "this_week" | "this_month";
};
type Digest = {
  headline: string;
  issues: DigestIssue[];
  wins: DigestWin[];
  actions: DigestAction[];
};

const SYSTEM = `You are the BloomIQ Teacher Coach generating this week's executive brief for a classroom teacher.

Output JSON ONLY in this exact shape:
{
  "headline": "...",
  "issues":  [{"title":"...","detail":"...","priority":"high"|"medium"|"low"}],
  "wins":    [{"title":"...","detail":"..."}],
  "actions": [{"title":"...","detail":"...","when":"this_class"|"this_week"|"this_month"}]
}

Rules:
- 2-4 items per section.
- Each title <= 60 chars; detail <= 200 chars.
- Cite specific numbers (avg %, student or class names, days) from the JSON.
- Headline: <= 90 chars, single punchy sentence summarising the week.
- "actions" should be teacher-actionable next steps (e.g. "Re-teach photosynthesis at the Apply level — 38% missed Q3").
- Never invent data.`;

function trim(s: unknown, max: number): string {
  const v = typeof s === "string" ? s : "";
  return v.length > max ? v.slice(0, max) : v;
}

function normaliseDigest(raw: Record<string, unknown>): Digest {
  const headline = trim(raw.headline, 90);

  const issuesRaw = Array.isArray(raw.issues) ? (raw.issues as unknown[]) : [];
  const issues: DigestIssue[] = issuesRaw.slice(0, 4).map((it) => {
    const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    const priority: DigestIssue["priority"] =
      o.priority === "high" || o.priority === "low" ? o.priority : "medium";
    return {
      title: trim(o.title, 60),
      detail: trim(o.detail, 200),
      priority,
    };
  }).filter((i) => i.title);

  const winsRaw = Array.isArray(raw.wins) ? (raw.wins as unknown[]) : [];
  const wins: DigestWin[] = winsRaw.slice(0, 4).map((it) => {
    const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    return { title: trim(o.title, 60), detail: trim(o.detail, 200) };
  }).filter((w) => w.title);

  const actionsRaw = Array.isArray(raw.actions) ? (raw.actions as unknown[]) : [];
  const actions: DigestAction[] = actionsRaw.slice(0, 4).map((it) => {
    const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    const when: DigestAction["when"] =
      o.when === "this_class" || o.when === "this_week" || o.when === "this_month"
        ? o.when
        : "this_week";
    return {
      title: trim(o.title, 60),
      detail: trim(o.detail, 200),
      when,
    };
  }).filter((a) => a.title);

  return { headline, issues, wins, actions };
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

    const ctx = await buildTeacherContext(user.id);
    const userPrompt = JSON.stringify(ctx, null, 2);
    const raw = await groqJSON(SYSTEM, userPrompt);
    const digest = normaliseDigest(raw);

    return NextResponse.json({
      digest,
      asOf: ctx.asOf,
      snapshot: ctx.totals,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate the brief." },
      { status: 500 }
    );
  }
}
