import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { checkLifetimeUse, recordLifetimeUse } from "@/lib/freeQuota";
import {
  loadLearningContext,
  prependLearningContext,
} from "@/lib/learningContext";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// POST /api/traps/diagnose
// -----------------------------------------------------------------------------
// Body: { attempt_id: string }
//
// Distractor Trap Detector. For each wrong answer in the attempt, ask Groq to
// classify which examiner-trap the student fell for, log to distractor_traps,
// and return the per-event list. Where Misconception Detective says "your
// understanding is wrong", this says "your understanding is fine but you got
// hooked by the test-writer's psychological trap."
// =============================================================================

const TRAP_TYPES = [
  "unit_confusion",         // "answer is in m/s but you computed in km/h"
  "sign_error",             // "you missed a negative sign"
  "not_misread",            // "the question said NOT, you read it as positive"
  "off_by_one",             // index/count off by one
  "plausible_formula",      // applied a related-but-wrong formula
  "partial_application",    // got one step right, skipped another
  "mismatched_units",       // forgot to convert before comparing
  "distractor_close_value", // picked an answer numerically close to correct
  "definition_swap",        // confused two related concepts
  "other",
] as const;

type TrapType = (typeof TRAP_TYPES)[number];

const SYSTEM = `You are an expert examiner classifying which psychological *trap* a student fell for on a wrong multiple-choice answer.

You will be given the question stem, all 4 options, the correct option, the student's pick, and the topic. Pick the SINGLE best matching trap_type from this exact set:
- "unit_confusion": answer needed different units than student computed in
- "sign_error": missed/added a negative sign or direction
- "not_misread": missed the word NOT / EXCEPT in the stem
- "off_by_one": index, count, or boundary off by one
- "plausible_formula": applied a related but wrong formula
- "partial_application": did most of the work but forgot a step
- "mismatched_units": forgot to convert before comparing options
- "distractor_close_value": picked a numerically close but wrong option
- "definition_swap": confused two related concepts
- "other": none of the above clearly fit

Each diagnosis must include:
- "question_id"
- "trap_type" — one of the slugs above
- "trap_label" — 2–4 words ("Unit conversion trap")
- "detail" — one second-person sentence explaining what they did

Respond with VALID JSON only:
{
  "diagnoses": [
    { "question_id": "<uuid>", "trap_type": "...", "trap_label": "...", "detail": "..." }
  ]
}

If you genuinely can't classify a question (the wrong pick looks random), omit it.`;

type Diagnosis = {
  question_id: string;
  trap_type: TrapType;
  trap_label: string;
  detail: string;
};

function isTrapType(s: string): s is TrapType {
  return (TRAP_TYPES as readonly string[]).includes(s);
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const rate = checkRateLimit(user.id, "traps.diagnose", { capacity: 10, refillPerHour: 20 });
    if (!rate.allowed) return NextResponse.json({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });
    const ltGate = await checkLifetimeUse(user.id, "trap_detector");
    if (!ltGate.allowed) return NextResponse.json({ error: ltGate.reason, code: "free_lifetime_used" }, { status: 402 });

    const body = await req.json().catch(() => ({}));
    const attempt_id: string = String(body.attempt_id || "");
    if (!attempt_id) return NextResponse.json({ error: "attempt_id required" }, { status: 400 });

    // Verify attempt belongs to this user.
    const { data: att, error: attErr } = await sb
      .from("quiz_attempts")
      .select("id, student_id")
      .eq("id", attempt_id)
      .single();
    if (attErr || !att) return NextResponse.json({ error: "Attempt not found" }, { status: 404 });
    if (att.student_id !== user.id) return NextResponse.json({ error: "Not yours" }, { status: 403 });

    // Pull wrong answers + question text.
    const { data: ans } = await sb
      .from("attempt_answers")
      .select("question_id, selected_index, is_correct")
      .eq("attempt_id", attempt_id);
    const wrong = (ans || []).filter((a) => a.is_correct === false && a.selected_index !== null);
    if (wrong.length === 0) {
      return NextResponse.json({ ok: true, diagnosed: 0, traps: [] });
    }

    const qIds = Array.from(new Set(wrong.map((a) => a.question_id)));
    const { data: qs } = await sb
      .from("question_bank")
      .select("id, topic, stem, options, correct_index")
      .in("id", qIds);
    const qMap = new Map<string, { id: string; topic: string | null; stem: string; options: string[]; correct_index: number }>();
    (qs || []).forEach((q) => qMap.set(q.id, q as { id: string; topic: string | null; stem: string; options: string[]; correct_index: number }));

    const items = wrong.slice(0, 10).map((a) => {
      const q = qMap.get(a.question_id);
      if (!q) return null;
      return {
        question_id: q.id,
        topic: q.topic || "general",
        stem: q.stem,
        options: q.options,
        correct_index: q.correct_index,
        student_pick: a.selected_index,
      };
    }).filter(Boolean);

    if (items.length === 0) {
      return NextResponse.json({ ok: true, diagnosed: 0, traps: [] });
    }

    // Learning-context inheritance — the trap "detail" prose returned
    // to the student should match their exam register (CAT trap detail
    // vs Class-10 trap detail vs corporate). The 9 canonical trap
    // LABELS stay constant; only the explanatory prose adapts.
    const admin = supabaseAdmin();
    const ctx = await loadLearningContext(admin, user.id);
    const contextAwareSystem = prependLearningContext(SYSTEM, ctx);

    const userPrompt = `Classify each of these wrong picks. Items:\n${JSON.stringify(items, null, 2)}`;
    const raw = await groqJSON(contextAwareSystem, userPrompt);
    const rawDiagnoses = (raw as { diagnoses?: unknown }).diagnoses;
    if (!Array.isArray(rawDiagnoses)) {
      return NextResponse.json({ ok: true, diagnosed: 0, traps: [] });
    }

    const diagnoses: Diagnosis[] = (rawDiagnoses as unknown[])
      .map((d) => {
        const obj = (d || {}) as Record<string, unknown>;
        const qid = String(obj.question_id || "");
        const tt = String(obj.trap_type || "").toLowerCase();
        const trap_label = String(obj.trap_label || "").trim();
        const detail = String(obj.detail || "").trim();
        if (!qid || !isTrapType(tt) || !trap_label || !detail) return null;
        return { question_id: qid, trap_type: tt, trap_label, detail };
      })
      .filter((d): d is Diagnosis => d !== null);

    if (diagnoses.length === 0) {
      return NextResponse.json({ ok: true, diagnosed: 0, traps: [] });
    }

    const rows = diagnoses.map((d) => {
      const q = qMap.get(d.question_id);
      return {
        user_id: user.id,
        attempt_id,
        question_id: d.question_id,
        topic: q?.topic || null,
        trap_type: d.trap_type,
        trap_label: d.trap_label,
        detail: d.detail,
      };
    });
    await sb.from("distractor_traps").insert(rows);

    await recordLifetimeUse(user.id, "trap_detector");

    return NextResponse.json({
      ok: true,
      diagnosed: diagnoses.length,
      traps: diagnoses.map((d) => ({ trap_type: d.trap_type, trap_label: d.trap_label, detail: d.detail })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Trap diagnosis failed" },
      { status: 500 }
    );
  }
}
