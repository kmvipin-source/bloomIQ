import { NextResponse } from "next/server";
import { aiJSON } from "@/lib/aiClient";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import { buildSchoolContext } from "@/lib/schoolContext";
import { requireFeature } from "@/lib/featureAccess.server";

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

const SYSTEM = `You are the ZCORIQ Principal Coach generating this week's executive brief for a school principal.

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
- When you mention a student by name (at-risk, top performer, anyone), ALWAYS append their class in parentheses, e.g. "Aanya Joshi (Grade 7 - Biology B)" — the class is in the \`class\` field next to each name in the JSON. A list of names without classes makes it impossible for the principal to know which teacher to follow up with. If a student's class is null, omit the parens.
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
    const priority = (o.priority === "high" || o.priority === "low" ? o.priority : "medium") as "high" | "medium" | "low";
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
    const owner = ((o.owner === "principal" || o.owner === "teacher" || o.owner === "both")
      ? o.owner
      : "principal") as "principal" | "teacher" | "both";
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
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    // Use the service-role admin client for the role lookup. The
    // user-token client raced RLS for some Heads, especially on the
    // first request after sign-in, and returned 403 to legitimate
    // users until they hard-refreshed.
    const adminClient = supabaseAdmin();
    const { data: prof } = await adminClient
      .from("profiles")
      .select("role, school_id")
      .eq("id", user.id)
      .maybeSingle();
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

    // Feature gate — `weekly_digest` is in Standard + Plus only after
    // migration 60. Pilot schools see the sidebar entry hidden by the
    // UI gate, but a direct API hit needs to refuse here too.
    const gate = await requireFeature(user.id, "weekly_digest");
    if (!gate.allowed) {
      return NextResponse.json(
        {
          error: gate.reason,
          code: "feature_locked",
          required_tier: gate.requiredTier,
        },
        { status: 403 }
      );
    }

    const ctx = await buildSchoolContext(prof.school_id as string);
    const userPrompt = JSON.stringify(ctx, null, 2);
    const raw = await aiJSON(SYSTEM, userPrompt);
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
