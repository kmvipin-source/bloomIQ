import { NextResponse } from "next/server";
import { groqJSONVision } from "@/lib/groq";
import { aiJSON } from "@/lib/aiClient";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import { checkRateLimit, checkDailyCap } from "@/lib/rateLimit";
import {
  findMisconceptionDistractors,
  formatDistractorSeedsForPrompt,
  verifyAnswerKeys,
  type VerifiableQuestion,
} from "@/lib/qgen";
import { detectExamFromTopic } from "@/lib/examDetectors";
import { buildSkillFewShotBlock } from "@/lib/skillFewShot";
import { loadLearningContext, prependLearningContext } from "@/lib/learningContext";

export const runtime = "nodejs";
export const maxDuration = 90;

type QType = "mcq" | "true_false" | "fill_blank" | "short_answer" | "long_answer" | "numerical";
type SectionDef = { name: string; question_type: QType; count: number; marks_per_question: number };
type Source = "topic_only" | "topic_syllabus" | "notes" | "image" | "past_paper";

const SYSTEM = `You are an expert exam-paper setter. You write printable question papers that mix question
types (MCQ, true/false, fill-in-the-blank, short answer, long answer, numerical) at the difficulty
appropriate to the class and syllabus the teacher specified.

HARD CONSTRAINTS:
1. GENERIC DOMAIN AWARENESS (applies to ANY topic — no local lookup):
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
2. ALWAYS produce EXACTLY the requested number of questions. If you run
   short of obvious angles, vary the sub-area, scenario, difficulty, or
   level of abstraction — but hit the requested count. Returning fewer
   than requested wastes the student\'s quota and time.

Return STRICT JSON only.`;

/**
 * When the topic names a known competitive exam, prepend an exam-aware
 * disambiguation + section-coverage hint to the SYSTEM prompt. Added
 * 2026-05-14 to fix the "JEE coaching teacher generates a paper, gets
 * generic K-12 content" gap. EXAM_DETECTORS in lib/examDetectors is the
 * single source of truth.
 */
function examAwareSystem(baseSystem: string, topic: string): string {
  const exam = detectExamFromTopic(topic);
  if (!exam) return baseSystem;
  return `${baseSystem}

COMPETITIVE-EXAM CONTEXT: this paper is for the ${exam.name} exam — ${exam.description}. Generate questions in the STYLE, DIFFICULTY, and SECTION COVERAGE of a real ${exam.name} paper. Typical sections: ${exam.sections.join("; ")}. Match the difficulty and tone of past ${exam.name} papers — NOT introductory school-level content unless the section explicitly covers it. Do NOT interpret the acronym as any non-exam meaning.`;
}

function describeType(t: QType): string {
  switch (t) {
    case "mcq":           return "Multiple-choice. Provide exactly 4 options. The correct one as a single capital letter A/B/C/D in correct_answer.";
    case "true_false":    return "True / False. The correct_answer must be exactly 'True' or 'False'.";
    case "fill_blank":    return "Fill-in-the-blank. Use ____ (4 underscores) where the blank goes in stem. correct_answer is the word(s) that fill the blank.";
    case "short_answer":  return "Short-answer (~30–60 words expected). correct_answer is a model answer (1–3 sentences).";
    case "long_answer":   return "Long-answer / essay (~150–300 words expected). correct_answer is an outline of the model answer's key points.";
    case "numerical":     return "Numerical / problem-solving. correct_answer is the final numeric answer with units; explanation should include the working.";
  }
}

function buildPrompt(
  source: Source,
  topic: string,
  className: string,
  syllabus: string,
  notes: string,
  examLabel: string,
  sections: SectionDef[],
  totalMarks: number,
  seedBlock: string
) {
  const sectionDescriptions = sections.map((s, i) => `Section ${i + 1} ("${s.name}"): produce ${s.count} ${s.question_type} question(s), ${s.marks_per_question} mark(s) each. ${describeType(s.question_type)}`).join("\n");

  const sourceBlock = (() => {
    if (source === "topic_only") return `Topic: ${topic}`;
    if (source === "topic_syllabus") return `Topic: ${topic}\nClass / grade: ${className}\nSyllabus / board: ${syllabus || "(unspecified)"}`;
    if (source === "notes") return `Topic: ${topic || "(infer from notes)"}\n\nNotes:\n"""${notes.slice(0, 8000)}"""`;
    if (source === "past_paper") return `Topic: ${topic || "derive the topic from the attached past paper — do NOT echo any placeholder text"}\nPast paper / exam reference: ${examLabel || "(unspecified)"}\n\nThe attached image is a previous exam paper. Read its questions, note the difficulty, calibration, and style. Generate NEW questions in the same pattern.`;
    return `Topic: ${topic || "derive the topic from the attached image — do NOT echo any placeholder text"}\n\nUse the attached image as the source content.`;
  })();

  return `${sourceBlock}

You are creating a printable exam paper. Total marks: ${totalMarks}.

The paper has these sections in order:
${sectionDescriptions}
${seedBlock}
Generate ALL questions. Spread Bloom's Taxonomy levels across the paper sensibly — easier questions early (Remember/Understand), harder questions later (Apply/Analyze/Evaluate/Create) — but match the question type each section requires.

Return JSON exactly in this shape:
{
  "sections": [
    {
      "name": "<section name>",
      "questions": [
        {
          "type": "<one of: mcq, true_false, fill_blank, short_answer, long_answer, numerical>",
          "stem": "<the question text>",
          "options": ["A_text", "B_text", "C_text", "D_text"],   // only for 'mcq', else omit
          "correct_answer": "<see type-specific instructions>",
          "explanation": "<for numerical: working; for others: brief justification>",
          "marks": <number>,
          "bloom_level": "<one of: remember, understand, apply, analyze, evaluate, create>"
        }
      ]
    }
  ]
}`;
}

type GenSection = {
  name: string;
  questions: Array<{
    type: QType;
    stem: string;
    options?: string[];
    correct_answer?: string;
    explanation?: string;
    marks?: number;
    bloom_level?: string;
  }>;
};

export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    // Finding #30 fix: same shape as #29 — token used downstream by
    // findMisconceptionDistractors but was missing from the destructure.
    const { user, sb, token } = auth;
    // Papers generate is the heaviest LLM surface — multi-Bloom + vision
    // when an image source is used. Tighter caps than /generate.
    const rate = checkRateLimit(user.id, "papers.generate", { capacity: 3, refillPerHour: 6 });
    if (!rate.allowed) return NextResponse.json({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });
    const daily = checkDailyCap(user.id, "papers.generate", 15);
    if (!daily.allowed) return NextResponse.json({ error: `Daily limit reached (${daily.limit}).`, code: "daily_cap" }, { status: 429 });

    const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).single();
    if (prof?.role !== "teacher") {
      return NextResponse.json({ error: "Only teachers can generate exam papers" }, { status: 403 });
    }
    // 2026-05-13: gate paper generation on an active plan that includes
    // unlimited practice tests. A free-trial-expired teacher should not
    // be able to keep generating up to 15 papers/day via direct API hits.
    // Use the same featureAccess check the dashboard uses for parity.
    const { requireFeature } = await import("@/lib/featureAccess.server");
    const featureGate = await requireFeature(user.id, "practice_tests_unlimited");
    if (!featureGate.allowed) {
      return NextResponse.json(
        {
          error: featureGate.reason ?? "Your plan doesn't include paper generation. Upgrade to continue.",
          code: "feature_locked",
          requiredTier: featureGate.requiredTier ?? "premium",
        },
        { status: 402 },
      );
    }

    const body = await req.json();
    const source = (body.source || "topic_only") as Source;
    const topic = String(body.topic || "");
    const className = String(body.className || "");
    const syllabus = String(body.syllabus || "");
    const notes = String(body.notes || "");
    const imageDataUrl = String(body.imageDataUrl || "");
    const examLabel = String(body.examLabel || "");
    const sections: SectionDef[] = Array.isArray(body.sections) ? body.sections : [];

    // Paper metadata
    const paperName: string = (body.paperName || "Untitled paper").trim();
    const schoolName: string = String(body.schoolName || "");
    const classGrade: string = String(body.classGrade || "");
    const subject: string = String(body.subject || "");
    const examDate: string | null = body.examDate || null;
    const durationMinutes: number = Number(body.durationMinutes) || 60;
    const instructions: string = String(body.instructions || "");

    if (sections.length === 0) {
      return NextResponse.json({ error: "Add at least one section to the template." }, { status: 400 });
    }
    for (const s of sections) {
      if (!s.name?.trim()) return NextResponse.json({ error: "Each section needs a name." }, { status: 400 });
      if (!s.question_type) return NextResponse.json({ error: `Section "${s.name}" needs a question type.` }, { status: 400 });
      if (!s.count || s.count < 1 || s.count > 50) return NextResponse.json({ error: `Section "${s.name}" question count must be 1–50.` }, { status: 400 });
      if (!s.marks_per_question || s.marks_per_question < 1) return NextResponse.json({ error: `Section "${s.name}" marks must be ≥ 1.` }, { status: 400 });
    }
    if (source === "image" && !imageDataUrl.startsWith("data:image/")) {
      return NextResponse.json({ error: "Image source needs an image upload." }, { status: 400 });
    }
    if (source === "past_paper" && !imageDataUrl.startsWith("data:image/")) {
      return NextResponse.json({ error: "Past-paper source needs an image upload." }, { status: 400 });
    }
    if (source === "notes" && notes.trim().length < 30) {
      return NextResponse.json({ error: "Notes too short — paste more content." }, { status: 400 });
    }

    const totalMarks = sections.reduce((s, sec) => s + sec.count * sec.marks_per_question, 0);

    // Mine misconception seeds for this teacher + topic. We don't have a single
    // Bloom level here (papers mix levels across sections) — pass null and let
    // the helper return the most-failed wrong answers across any level. Empty
    // list on no-data => standard generation, no behaviour change.
    let seedBlock = "";
    try {
      const seeds = await findMisconceptionDistractors({
        ownerId: user.id,
        topic: topic || subject || null,
        bloomLevel: null,
        limit: 5,
        accessToken: token,
      });
      seedBlock = formatDistractorSeedsForPrompt(seeds);
      if (seeds.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[papers/generate] spliced ${seeds.length} misconception seed(s) into prompt`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[papers/generate] seed mining failed (non-fatal):`, e instanceof Error ? e.message : e);
    }

    // Generate via Groq (vision when an image is involved). When the topic
    // names a competitive exam (CAT/JEE/NEET/UPSC/…) we wrap the SYSTEM
    // prompt with an exam-aware disambiguation block so the paper carries
    // the right register — this is what was missing for coaching schools.
    const prompt = buildPrompt(source, topic, className, syllabus, notes, examLabel, sections, totalMarks, seedBlock);
    // Stack the two prompt-priming layers: detectExamFromTopic (topic-based,
    // catches CAT/JEE acronyms even when the teacher hasn't set a goal) +
    // learning-context inheritance (profile-based, picks up coaching-school
    // teachers whose default exam_goal mirrors the cohort they teach).
    // examAwareSystem comes first because it's most specific to the
    // current paper; the learner-context wrapper applies above it.
    const adminForCtx = supabaseAdmin();
    const learnerCtx = await loadLearningContext(adminForCtx, user.id);
    const sysForGen = prependLearningContext(examAwareSystem(SYSTEM, topic), learnerCtx) + buildSkillFewShotBlock(topic);
    let json: Record<string, unknown>;
    if (source === "image" || source === "past_paper") {
      json = await groqJSONVision(sysForGen, prompt, imageDataUrl);
    } else {
      json = await aiJSON(sysForGen, prompt);
    }
    const generated: GenSection[] = Array.isArray((json as { sections?: GenSection[] })?.sections)
      ? (json as { sections: GenSection[] }).sections
      : [];

    if (generated.length === 0) {
      return NextResponse.json({ error: "AI returned no sections — try a clearer topic or template." }, { status: 502 });
    }

    // Persist the paper + questions
    const { data: paper, error: pErr } = await sb.from("exam_papers").insert({
      owner_id: user.id,
      name: paperName,
      school_name: schoolName || null,
      class_grade: classGrade || null,
      subject: subject || null,
      exam_date: examDate,
      duration_minutes: durationMinutes,
      total_marks: totalMarks,
      instructions: instructions || null,
      status: "draft",
    }).select().single();
    if (pErr || !paper) return NextResponse.json({ error: pErr?.message || "Could not create paper" }, { status: 500 });

    // Flatten generated sections into question rows
    const ALLOWED_TYPES: QType[] = ["mcq", "true_false", "fill_blank", "short_answer", "long_answer", "numerical"];
    const ALLOWED_BLOOMS = ["remember", "understand", "apply", "analyze", "evaluate", "create"];
    let pos = 0;
    const rows: Array<{
      paper_id: string; section_name: string; position: number;
      question_type: QType; stem: string;
      options: string[] | null; correct_answer: string | null;
      explanation: string | null; marks: number; bloom_level: string | null;
    }> = [];
    for (const sec of generated) {
      const sectionName = String(sec.name || "Section").trim();
      for (const q of sec.questions || []) {
        const type = (ALLOWED_TYPES.includes(q.type) ? q.type : "short_answer") as QType;
        const stem = String(q.stem || "").trim();
        if (!stem) continue;
        const options = type === "mcq" && Array.isArray(q.options) && q.options.length === 4
          ? q.options.map((x) => String(x).trim())
          : null;
        const bloom = q.bloom_level && ALLOWED_BLOOMS.includes(q.bloom_level) ? q.bloom_level : null;
        rows.push({
          paper_id: paper.id,
          section_name: sectionName,
          position: pos++,
          question_type: type,
          stem,
          options,
          correct_answer: q.correct_answer ? String(q.correct_answer).trim() : null,
          explanation: q.explanation ? String(q.explanation).trim() : null,
          marks: typeof q.marks === "number" && q.marks > 0 ? Math.round(q.marks) : 1,
          bloom_level: bloom,
        });
      }
    }
    if (rows.length === 0) {
      // Roll back the empty paper so we don't leave junk
      await sb.from("exam_papers").delete().eq("id", paper.id);
      return NextResponse.json({ error: "AI returned no usable questions." }, { status: 502 });
    }

    // Self-verifying answer keys: re-solve every MCQ row and tag dispute
    // metadata. We don't mutate `rows` (the schema doesn't carry a quality
    // column on exam_paper_questions either) — just count and report.
    const mcqIndices: number[] = [];
    const mcqQuestions: VerifiableQuestion[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.question_type !== "mcq") continue;
      if (!r.options || r.options.length !== 4) continue;
      const letter = (r.correct_answer || "").trim().toUpperCase();
      const idxMap: Record<string, 0 | 1 | 2 | 3> = { A: 0, B: 1, C: 2, D: 3 };
      if (!(letter in idxMap)) continue;
      mcqIndices.push(i);
      mcqQuestions.push({
        stem: r.stem,
        options: [r.options[0], r.options[1], r.options[2], r.options[3]] as [string, string, string, string],
        correct_index: idxMap[letter],
      });
    }

    let verifiedCount = 0;
    let disputedCount = 0;
    const disputedPositions: Array<{ section: string; position: number }> = [];
    if (mcqQuestions.length > 0) {
      try {
        const verifyResults = await verifyAnswerKeys(mcqQuestions, 5);
        for (let i = 0; i < verifyResults.length; i++) {
          const v = verifyResults[i];
          if (v.ok) {
            verifiedCount++;
          } else {
            disputedCount++;
            const rowIdx = mcqIndices[i];
            const row = rows[rowIdx];
            // Stamp the dispute on the explanation field so teachers
            // editing / printing the paper see the warning even if the
            // UI hasn't surfaced the verification.disputed count. The
            // schema doesn't have a dedicated quality column on
            // exam_paper_questions, so we piggyback on explanation.
            const reviewerLetter = typeof v.correctIndex === "number" ? "ABCD"[v.correctIndex] ?? "?" : "?";
            const marker = `[⚠ ANSWER DISPUTED — AI re-solve picked option ${reviewerLetter}; please verify before printing.]`;
            row.explanation = row.explanation
              ? `${marker}\n\n${row.explanation}`
              : marker;
            disputedPositions.push({ section: row.section_name, position: row.position });
            // eslint-disable-next-line no-console
            console.warn(
              `[papers/generate] MCQ at row ${rowIdx} answer disputed by re-solve. Stored: ${row.correct_answer}, reviewer chose index: ${v.correctIndex}`
            );
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[papers/generate] verification pass failed (non-fatal):`, e instanceof Error ? e.message : e);
      }
    }
    const { error: qErr } = await sb.from("exam_paper_questions").insert(rows);
    if (qErr) {
      await sb.from("exam_papers").delete().eq("id", paper.id);
      return NextResponse.json({ error: qErr.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      paperId: paper.id,
      verification: {
        mcq_total: mcqQuestions.length,
        verified: verifiedCount,
        disputed: disputedCount,
        disputed_positions: disputedPositions,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Generation failed" }, { status: 500 });
  }
}