import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { buildSchoolContext } from "@/lib/schoolContext";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// POST /api/school/digest
// -----------------------------------------------------------------------------
// Generates this week's executive brief for a school principal. No body.
// Same auth + role check as the coach (super_teacher only). We hand the
// JSON school snapshot to Groq with a strict response shape and surface it
// straight back to the UI.
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
  owner: "principal" | "teacher" | "both";
};
type Digest = {
  headline: string;
  issues: DigestIssue[];
  wins: DigestWin[];
  actions: DigestAction[];
};

const SYSTEM = `You are the BloomIQ Principal Coach generating this week's executive brief for a school principal.

Output JSON ONLY in this exact shape:
{
  "headline": "...",
  "issues": [{"title":"...","detail":"...","priority":"high"|"medium"|"low"}],
  "wins":   [{"title":"...","detail":"..."}],
  "actions":[{"title":"...","detail":"...","owner":"principal"|"teacher"|"both"}]
}

Rules:
- 2-4 items per section. No empty arrays — if there are no real issues, write a "monitor" item.
- Each title <= 60 chars; detail <= 200 chars.
- Cite specific numbers (avg %, days, student or class names) from the JSON in the detail field.
- Headline is a single punchy sentence (<= 90 chars) summarising the week.
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
    const priority = o.priority === "high" || o.priority === "low" ? o.priority : "medium";
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
    const owner = o.owner === "principal" || o.owner === "teacher" || o.owner === "both"
      ? o.owner
      : "principal";
    return {
      title: trim(o.title, 60),
      detail: trim(o.detail, 200),
      owner,
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
      .select("role, school_id")
      .eq("id", user.id)
      .single();
    if (!prof || prof.role !== "super_teacher") {
      return NextResponse.json(
        { error: "Only school admins can generate the brief." },
        { status: 403 }
      );
    }
    if (!prof.school_id) {
      return NextResponse.json(
        { error: "Set up your school first to generate the brief." },
        { status: 400 }
      );
    }

    const ctx = await buildSchoolContext(prof.school_id as string);
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
