import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { groqJSON } from "@/lib/groq";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { consumeDailyQuota } from "@/lib/freeQuota";
import {
  loadLearningContext,
  prependLearningContext,
  buildExamAwareTopic,
} from "@/lib/learningContext";
import { getRecentStemsForExclusion } from "@/lib/recentStemsExclusion";
import { filterQuestionBatch } from "@/lib/qgen";
import { detectExamFromTopic, filterBloomLevelsForExam } from "@/lib/examDetectors";
import { buildSkillFewShotBlock } from "@/lib/skillFewShot";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// POST /api/speed/start
// -----------------------------------------------------------------------------
// Body: { topic?: string, count?: number }
//
// Generates a mixed-Bloom-level batch of MCQs for the Speed-Accuracy Trainer.
// Each question is returned with a `target_ms` derived from its Bloom level —
// this is the "examiner-pace budget" the student should beat. The mix is
// deliberately weighted toward Apply/Analyze since those are the dominant
// Bloom levels in JEE/NEET-style competitive papers.
// =============================================================================

const SYSTEM = `You are an expert curriculum designer building a mixed-Bloom-level practice batch for a competitive-exam student.

You will be given a topic and a target count. Generate exactly that many MCQs, distributed across Bloom levels per the provided weights. Each MCQ:
- has a clear stem (no preamble)
- has 4 options (one correct, three plausible distractors)
- has correct_index 0..3
- has bloom_level (one of: remember, understand, apply, analyze, evaluate, create)
- has a 1-sentence explanation

5. GENERIC DOMAIN AWARENESS (applies to ANY topic — no local lookup):
   If the topic is a specialized professional / technical / niche domain
   (payment switches like Postilion or Base24, mainframe stack like JCL /
   COBOL / CICS / DB2, networking protocols like BGP / MPLS, cloud platforms,
   legal codes, medical specialties, regulatory frameworks, ERP modules,
   industrial control systems, etc.) — USE the precise real-world terminology
   of that domain. Real product names, real parameter names, real syntax,
   real field numbers, real API verbs, real configuration keys. NEVER invent
   identifiers, opcodes, field bits, function names, or product features
   that don\'t exist. If you don\'t have confident knowledge of a specific
   aspect, write a question that AVOIDS that aspect rather than fabricating.
6. ALWAYS produce EXACTLY the requested number of questions. If you run
   short of obvious angles, vary the sub-area, scenario, difficulty, or
   level of abstraction — but hit the requested count. Returning fewer
   than requested wastes the student\'s quota and time.

Respond with VALID JSON only:
{
  "questions": [
    { "stem": "...", "options": ["a","b","c","d"], "correct_index": 0, "bloom_level": "apply", "explanation": "..." }
  ]
}`;

// Per-Bloom-level time budget in ms. These match the rule of thumb that
// JEE/NEET coaches use — ~30–90 seconds depending on cognitive load.
const TARGET_MS: Record<BloomLevel, number> = {
  remember: 30_000,
  understand: 45_000,
  apply: 75_000,
  analyze: 90_000,
  evaluate: 90_000,
  create: 120_000,
};

// Distribution favoring Apply/Analyze (the Bloom levels competitive exams test most).
const WEIGHTS: Record<BloomLevel, number> = {
  remember: 0.10,
  understand: 0.15,
  apply: 0.35,
  analyze: 0.25,
  evaluate: 0.10,
  create: 0.05,
};

function levelMix(count: number): Record<BloomLevel, number> {
  const out: Record<BloomLevel, number> = {
    remember: 0, understand: 0, apply: 0, analyze: 0, evaluate: 0, create: 0,
  };
  // Allocate using floors then distribute remainder by largest fractional.
  const fracs: Array<[BloomLevel, number]> = BLOOM_LEVELS.map((l) => [l, count * WEIGHTS[l]]);
  fracs.forEach(([l, n]) => { out[l] = Math.floor(n); });
  let remainder = count - BLOOM_LEVELS.reduce((s, l) => s + out[l], 0);
  // Sort by largest fractional remainder
  const sorted = fracs
    .map(([l, n]) => [l, n - Math.floor(n)] as [BloomLevel, number])
    .sort((a, b) => b[1] - a[1]);
  for (const [l] of sorted) {
    if (remainder <= 0) break;
    out[l] += 1;
    remainder -= 1;
  }
  return out;
}

type GenQ = { stem: string; options: string[]; correct_index: number; bloom_level: BloomLevel; explanation: string };

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const gate = await consumeDailyQuota(user.id, "speed_session");
    if (!gate.allowed) {
      return NextResponse.json(
        { error: gate.reason, code: "free_daily_cap", cap: gate.cap, used: gate.used },
        { status: 402 }
      );
    }

    const body = await req.json().catch(() => ({}));
    let topic: string = String(body.topic || "").trim();
    const requestedCount: number = Number(body.count || 8);
    const count = Math.max(5, Math.min(15, Math.floor(requestedCount)));

    // If no topic, pick the student's most recent topic.
    if (!topic) {
      const { data: recent } = await sb
        .from("question_bank")
        .select("topic")
        .eq("owner_id", user.id)
        .not("topic", "is", null)
        .order("created_at", { ascending: false })
        .limit(20);
      const t = ((recent || []) as Array<{ topic: string | null }>).find((r) => r.topic);
      topic = t?.topic || "General Knowledge";
    }

    // Learning-context inheritance — Vipin caught this on 2026-05-12 when
    // typing "CAT" returned a vocabulary question asking what the
    // acronym stood for. The fix: read the student's exam_goal from
    // profile, prepend an exam-aware fragment to the SYSTEM prompt, and
    // wrap the topic so the AI cannot mistake "CAT" the exam for "CAT"
    // the animal. Single source via lib/learningContext.ts so every
    // question-generation endpoint inherits the same fix.
    const admin = supabaseAdmin();
    const ctx = await loadLearningContext(admin, user.id);
    const examAwareTopic = buildExamAwareTopic(topic, ctx);
    // Cross-test non-repetition. Speed Trainer mixes Bloom levels, so
    // pass null for bloomLevel — exclusion considers any level the
    // student has seen on this topic recently.
    const exclusion = await getRecentStemsForExclusion(admin, user.id, topic, null, 20);
    const systemPrompt = prependLearningContext(SYSTEM, ctx) + exclusion.promptBlock + buildSkillFewShotBlock(topic);

    // 2026-05-14: when the topic names a competitive exam, redistribute
    // the Bloom-level mix to skip levels the actual paper doesn't test —
    // CAT doesn't ask "Remember"-level trivia, UPSC doesn't ask "Create".
    // Same source-of-truth filter the /generate and /quick-test routes use.
    const examMeta = detectExamFromTopic(topic);
    let mix = levelMix(count);
    if (examMeta) {
      const requested = BLOOM_LEVELS.filter((l) => mix[l] > 0);
      const { effective, omitted } = filterBloomLevelsForExam(requested, examMeta);
      if (omitted.length > 0 && effective.length > 0) {
        // Reallocate the omitted-level counts proportionally onto allowed levels.
        const omittedTotal = omitted.reduce((s, l) => s + mix[l], 0);
        const newMix: typeof mix = { remember: 0, understand: 0, apply: 0, analyze: 0, evaluate: 0, create: 0 };
        for (const l of effective) newMix[l] = mix[l];
        let leftover = omittedTotal;
        for (let i = 0; leftover > 0; i = (i + 1) % effective.length) {
          newMix[effective[i]] += 1;
          leftover -= 1;
        }
        mix = newMix;
      }
    }
    const userPrompt = `Topic: ${examAwareTopic}
Total questions: ${count}
Distribution by Bloom level:
${BLOOM_LEVELS.map((l) => `- ${l}: ${mix[l]}`).join("\n")}

Generate the JSON now.`;

    const raw = await groqJSON(systemPrompt, userPrompt);
    const arr = (raw as { questions?: unknown }).questions;
    if (!Array.isArray(arr)) {
      return NextResponse.json({ error: "AI did not return questions; please retry." }, { status: 502 });
    }

    const structurallyValid: GenQ[] = (arr as unknown[])
      .map((q) => {
        const obj = (q || {}) as Record<string, unknown>;
        const stem = String(obj.stem || "").trim();
        const options = Array.isArray(obj.options) ? (obj.options as unknown[]).map(String) : [];
        const ci = Number(obj.correct_index);
        const bl = String(obj.bloom_level || "").toLowerCase().trim();
        const expl = String(obj.explanation || "").trim();
        if (!stem || options.length !== 4 || !Number.isInteger(ci) || ci < 0 || ci > 3) return null;
        if (!(BLOOM_LEVELS as readonly string[]).includes(bl)) return null;
        return { stem, options, correct_index: ci, bloom_level: bl as BloomLevel, explanation: expl };
      })
      .filter((q): q is GenQ => q !== null);

    // Quality + cross-test filters (Vipin 2026-05-12): drop answer-key
    // leaks, in-batch dupes, and stems similar to questions the student
    // has already answered in recent Speed Trainer sessions on this
    // topic. Then hard-slice to `count`.
    const { kept: valid, droppedLeak, droppedDup, droppedHistory } = filterQuestionBatch(
      structurallyValid,
      { maxCount: count, similarityThreshold: 0.7, historyStems: exclusion.stems },
    );
    // eslint-disable-next-line no-console
    console.log(
      `[speed/start] kept=${valid.length}/${structurallyValid.length} ` +
      `(dropped: leak=${droppedLeak.length} dup=${droppedDup.length} history=${droppedHistory.length})`
    );

    if (valid.length === 0) {
      return NextResponse.json({ error: "No usable questions came back. Try a different topic." }, { status: 502 });
    }

    // Persist the issued questions (incl. correct_index) server-side so
    // /submit can score against the trusted copy. Migration 87 added
    // speed_sessions_issued for this. Client gets a session_id + the
    // questions MINUS correct_index — they're useless to the scorer
    // because /submit reads from the persisted row.
    const sessionId = randomUUID();
    {
      const adminInsert = supabaseAdmin();
      const { error: persistErr } = await adminInsert
        .from("speed_sessions_issued")
        .insert({
          session_id: sessionId,
          user_id: user.id,
          topic,
          questions: valid,
        });
      if (persistErr) {
        return NextResponse.json(
          { error: `Could not persist speed session: ${persistErr.message}` },
          { status: 500 },
        );
      }
    }

    // Attach target_ms based on bloom level. Send the questions MINUS
    // correct_index/explanation — /submit re-reads the server-trusted
    // copy by session_id.
    const enriched = valid.map((q, i) => ({
      idx: i,
      stem: q.stem,
      options: q.options,
      bloom_level: q.bloom_level,
      target_ms: TARGET_MS[q.bloom_level],
    }));

    // Sticky marking-scheme persistence (migration 77). Speed Trainer is a
    // transient session — it doesn't create a quizzes row — but we still
    // honour the user's pick and remember it for the next surface. If the
    // client sent a scheme, write it to profile.last_marking_scheme.
    if (body && body.markingScheme && typeof body.markingScheme === "object") {
      const { writeLastMarkingScheme } = await import("@/lib/markingSchemeMemory");
      const { resolveScheme } = await import("@/lib/scoring");
      await writeLastMarkingScheme(admin, user.id, resolveScheme(body.markingScheme));
    }

    return NextResponse.json({ ok: true, session_id: sessionId, topic, count: enriched.length, questions: enriched });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not start speed session" },
      { status: 500 }
    );
  }
}
