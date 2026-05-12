import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { buildStudentContext } from "@/lib/studentContext";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";
import {
  loadLearningContext,
  prependLearningContext,
} from "@/lib/learningContext";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// POST /api/student/digest
// -----------------------------------------------------------------------------
// Generates this week's self-reflection brief for a student. No body. Same
// auth + role check as the coach (student only). We hand the JSON student
// snapshot to Groq with a strict response shape and surface it back to the UI.
// =============================================================================

type DigestWin = { title: string; detail: string };
type DigestFocus = {
  title: string;
  detail: string;
  level: BloomLevel | null;
};
type DigestAction = {
  title: string;
  detail: string;
  when: "today" | "this_week" | "this_month";
};
type Digest = {
  headline: string;
  wins: DigestWin[];
  focus: DigestFocus[];
  actions: DigestAction[];
};

const SYSTEM = `You are the BloomIQ Student Coach generating a weekly self-reflection brief for a student.

Output JSON ONLY:
{
  "headline": "...",
  "wins":     [{"title":"...","detail":"..."}],
  "focus":    [{"title":"...","detail":"...","level":"remember"|"understand"|"apply"|"analyze"|"evaluate"|"create"}],
  "actions":  [{"title":"...","detail":"...","when":"today"|"this_week"|"this_month"}]
}

Rules:
- 2-4 items per section. No empties.
- Each title <= 60 chars, detail <= 180 chars.
- Cite specific numbers. The student must be able to recognise themselves in the brief.
- "focus" lists Bloom levels or topics that are slipping; tag the bloom level when relevant (use null if it's a general focus).
- "actions" must be student-actionable.
- Headline <= 90 chars, encouraging but honest.
- Never invent data.`;

function trim(s: unknown, max: number): string {
  const v = typeof s === "string" ? s : "";
  return v.length > max ? v.slice(0, max) : v;
}

function asBloomLevel(x: unknown): BloomLevel | null {
  if (typeof x !== "string") return null;
  if ((BLOOM_LEVELS as readonly string[]).includes(x)) return x as BloomLevel;
  return null;
}

function normaliseDigest(raw: Record<string, unknown>): Digest {
  const headline = trim(raw.headline, 90);

  const winsRaw = Array.isArray(raw.wins) ? (raw.wins as unknown[]) : [];
  const wins: DigestWin[] = winsRaw
    .slice(0, 4)
    .map((it) => {
      const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
      return { title: trim(o.title, 60), detail: trim(o.detail, 180) };
    })
    .filter((w) => w.title);

  const focusRaw = Array.isArray(raw.focus) ? (raw.focus as unknown[]) : [];
  const focus: DigestFocus[] = focusRaw
    .slice(0, 4)
    .map((it) => {
      const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
      return {
        title: trim(o.title, 60),
        detail: trim(o.detail, 180),
        level: asBloomLevel(o.level),
      };
    })
    .filter((f) => f.title);

  const actionsRaw = Array.isArray(raw.actions) ? (raw.actions as unknown[]) : [];
  const actions: DigestAction[] = actionsRaw
    .slice(0, 4)
    .map((it) => {
      const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
      const when: DigestAction["when"] =
        o.when === "today" || o.when === "this_week" || o.when === "this_month"
          ? o.when
          : "this_week";
      return {
        title: trim(o.title, 60),
        detail: trim(o.detail, 180),
        when,
      };
    })
    .filter((a) => a.title);

  return { headline, wins, focus, actions };
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
    if (!prof || prof.role !== "student") {
      return NextResponse.json(
        { error: "Only students can use the Student Coach." },
        { status: 403 }
      );
    }

    const ctx = await buildStudentContext(user.id);
    // Learning-context inheritance — the digest is student-facing prose,
    // so headlines, wins, focus and actions should reach for the
    // student's own register (CAT student gets CAT topics in actions,
    // not "photosynthesis"; corporate trainee gets cloud / Java
    // suggestions, not NCERT). Vipin 2026-05-12.
    const admin = supabaseAdmin();
    const learnerCtx = await loadLearningContext(admin, user.id);
    const contextAwareSystem = prependLearningContext(SYSTEM, learnerCtx);
    const userPrompt = JSON.stringify(ctx, null, 2);
    const raw = await groqJSON(contextAwareSystem, userPrompt);
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
