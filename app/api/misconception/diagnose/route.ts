import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// POST /api/misconception/diagnose
// -----------------------------------------------------------------------------
// Body: { attempt_id: string }
//
// Look at every wrong answer in this attempt, ask Groq to infer the *specific*
// mental error the student made for each, and upsert to the misconceptions
// table. Repeat misconceptions (same label) bump strikes + last_seen_at instead
// of inserting duplicates.
//
// Returns: { ok, diagnosed: number, misconceptions: Array<{label, detail, strikes}> }
// =============================================================================

const SYSTEM = `You are an expert teacher diagnosing the SPECIFIC mental error a student made when they picked a wrong multiple-choice answer.

Given the question stem, all four options, the correct option, the student's wrong pick, and the topic, infer the most likely misconception. Be PRECISE — not "got it wrong" but "confused photosynthesis with respiration" or "forgot that kinematic equations assume constant acceleration."

For each diagnosis, produce:
- "label": a short slug, lowercase-with-dashes, no punctuation. Reuse the same slug for the same misconception (e.g. "photo-vs-resp" not "photosynthesis-vs-respiration-1"). Max 40 chars.
- "detail": one human-readable sentence in second person, present tense ("You confused X with Y because Z").

Respond with VALID JSON only:
{
  "diagnoses": [
    { "question_id": "<uuid>", "label": "...", "detail": "..." }
  ]
}

If you cannot diagnose a question (e.g. the wrong pick is essentially random), omit it from diagnoses.`;

type Diagnosis = { question_id: string; label: string; detail: string };

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const rate = checkRateLimit(user.id, "misconception.diagnose", { capacity: 10, refillPerHour: 20 });
    if (!rate.allowed) return NextResponse.json({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });

    const body = await req.json().catch(() => ({}));
    const attempt_id: string = String(body.attempt_id || "");
    if (!attempt_id) return NextResponse.json({ error: "attempt_id required" }, { status: 400 });

    // Confirm the attempt belongs to this user.
    const { data: att, error: attErr } = await sb
      .from("quiz_attempts")
      .select("id, student_id")
      .eq("id", attempt_id)
      .single();
    if (attErr || !att) return NextResponse.json({ error: "Attempt not found" }, { status: 404 });
    if (att.student_id !== user.id) return NextResponse.json({ error: "Not yours" }, { status: 403 });

    // Pull the wrong answers + their question text.
    const { data: ans } = await sb
      .from("attempt_answers")
      .select("question_id, selected_index, is_correct, bloom_level")
      .eq("attempt_id", attempt_id);
    const wrong = (ans || []).filter((a) => a.is_correct === false && a.selected_index !== null);
    if (wrong.length === 0) {
      return NextResponse.json({ ok: true, diagnosed: 0, misconceptions: [] });
    }

    const qIds = Array.from(new Set(wrong.map((a) => a.question_id)));
    const { data: qs } = await sb
      .from("question_bank")
      .select("id, topic, stem, options, correct_index")
      .in("id", qIds);
    const qMap = new Map<string, { id: string; topic: string | null; stem: string; options: string[]; correct_index: number }>();
    (qs || []).forEach((q) => qMap.set(q.id, q as { id: string; topic: string | null; stem: string; options: string[]; correct_index: number }));

    // Build a compact prompt. Keep payload small — 1 LLM call diagnoses up to 10 wrong answers.
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
      return NextResponse.json({ ok: true, diagnosed: 0, misconceptions: [] });
    }

    const userPrompt = `Diagnose each wrong answer. Items:\n${JSON.stringify(items, null, 2)}`;
    const raw = await groqJSON(SYSTEM, userPrompt);
    const rawDiagnoses = (raw as { diagnoses?: unknown }).diagnoses;
    if (!Array.isArray(rawDiagnoses)) {
      return NextResponse.json({ ok: true, diagnosed: 0, misconceptions: [] });
    }

    const diagnoses: Diagnosis[] = (rawDiagnoses as unknown[])
      .map((d) => {
        const obj = (d || {}) as Record<string, unknown>;
        const qid = String(obj.question_id || "");
        const label = slugify(String(obj.label || ""));
        const detail = String(obj.detail || "").trim();
        if (!qid || !label || !detail) return null;
        return { question_id: qid, label, detail };
      })
      .filter((d): d is Diagnosis => d !== null);

    if (diagnoses.length === 0) {
      return NextResponse.json({ ok: true, diagnosed: 0, misconceptions: [] });
    }

    // Upsert each unique misconception. We can't use ON CONFLICT directly via
    // PostgREST when the unique index is partial (see CONTEXT.md), so it's
    // SELECT → UPDATE-or-INSERT per row. Slow-ish but correct.
    const out: Array<{ label: string; detail: string; strikes: number }> = [];
    for (const d of diagnoses) {
      const wrongAns = wrong.find((w) => w.question_id === d.question_id);
      const q = qMap.get(d.question_id);

      const { data: existing } = await sb
        .from("misconceptions")
        .select("id, strikes, evidence_q_ids")
        .eq("user_id", user.id)
        .eq("label", d.label)
        .maybeSingle();

      if (existing) {
        const evidence = Array.isArray(existing.evidence_q_ids) ? existing.evidence_q_ids : [];
        const newEvidence = evidence.includes(d.question_id) ? evidence : [...evidence, d.question_id].slice(-20);
        await sb
          .from("misconceptions")
          .update({
            strikes: (existing.strikes || 1) + 1,
            last_seen_at: new Date().toISOString(),
            evidence_q_ids: newEvidence,
            resolved: false,
          })
          .eq("id", existing.id);
        out.push({ label: d.label, detail: d.detail, strikes: (existing.strikes || 1) + 1 });
      } else {
        await sb.from("misconceptions").insert({
          user_id: user.id,
          topic: q?.topic || null,
          bloom_level: wrongAns?.bloom_level || null,
          label: d.label,
          detail: d.detail,
          evidence_q_ids: [d.question_id],
          strikes: 1,
        });
        out.push({ label: d.label, detail: d.detail, strikes: 1 });
      }
    }

    return NextResponse.json({ ok: true, diagnosed: out.length, misconceptions: out });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Diagnosis failed" },
      { status: 500 }
    );
  }
}
