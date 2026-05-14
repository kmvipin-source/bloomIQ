import { NextResponse } from "next/server";
import { groqJSON, groqJSONVision } from "@/lib/groq";
import {
  BLOOM_LEVELS,
  BLOOM_META,
  type BloomLevel,
  isBloomLevel,
  blankBloomCounts,
} from "@/lib/bloom";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { generateQuizCode } from "@/lib/utils";
import { classifyQuiz } from "@/lib/classifier";
import {
  findMisconceptionDistractors,
  formatDistractorSeedsForPrompt,
  verifyAnswerKeys,
  filterQuestionBatch,
  type VerifiableQuestion,
} from "@/lib/qgen";
import { resolveAudienceLevel } from "@/lib/audienceLevel";
import { applyAdditionalFocus, validateFocusForTopic } from "@/lib/topicEnrichment";
import { shouldUseCompetitiveExamFraming } from "@/lib/examDetectors";
import { buildSkillFewShotBlock } from "@/lib/skillFewShot";
import { groundTopic, formatGroundingForPrompt } from "@/lib/topicGrounding";
import { embedTexts, cosineDedupInBatch } from "@/lib/embeddings";
import {
  loadLearningContext,
  prependLearningContext,
  buildExamAwareTopic,
} from "@/lib/learningContext";
import { getRecentStemsForExclusion } from "@/lib/recentStemsExclusion";
import { resolveScheme } from "@/lib/scoring";

export const runtime = "nodejs";
export const maxDuration = 60;

type GenQ = { stem: string; options: string[]; correct_index: number; explanation: string };
type Source = "notes" | "image" | "topic_syllabus" | "topic_only" | "past_paper";

const SYSTEM = `You are an expert curriculum designer who writes high-quality multiple-choice questions
mapped precisely to Bloom's Taxonomy levels. Each question must:
- have exactly 4 options labelled by index 0..3
- have ONE clearly correct answer (correct_index 0..3)
- include a brief explanation of why it's correct
- match the requested Bloom level's cognitive demand
- be unambiguous, grammatically correct, and free of trick wording

HARD CONSTRAINTS — questions violating any of these will be rejected:
1. The correct answer's key terms must NEVER appear inside the stem. If the
   correct option is "Photosynthesis is the process …", the stem must NOT
   contain the word "photosynthesis". Re-word the stem or pick a different
   right answer — never let the question telegraph itself.
2. Within a single batch, do NOT generate paraphrases of the same question.
   Each item must test a DISTINCT sub-concept or skill — different formula,
   different scenario, different angle. Multiple questions meaning the
   same thing are duplicates even if the wording differs.
3. For Apply / Analyze / Evaluate level questions, VARY the scenario domain
   across the batch. Do NOT use the same template with a swapped noun
   (e.g., "hospital" vs "bank" vs "school" in otherwise identical stems).
   Each scenario should bring genuinely different context, constraints,
   or quantities.
4. Return EXACTLY the requested number of questions — no more, no fewer.
   If asked for 20, return 20. Generating extras wastes the user's quota
   and time.

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

Return STRICT JSON only.`;

function jsonShape() {
  return `Output JSON of the form:
{ "questions": [ { "stem": "...", "options": ["A","B","C","D"], "correct_index": 0, "explanation": "..." } ] }`;
}

function numericalHint(pct: number, n: number) {
  if (pct <= 0) return "";
  const target = Math.max(1, Math.round((pct / 100) * n));
  return `\n\nNumerical-content target: about ${pct}% (~${target} of ${n}) of these questions should involve numerical reasoning — calculation, formulas, equations, units, or quantitative analysis — BUT ONLY IF the topic naturally supports it (math, physics, chemistry, finance, statistics, economics, etc.). If the topic is purely conceptual, ignore this and write conceptual questions instead.`;
}

function notesPrompt(content: string, topic: string, level: BloomLevel, n: number, numPct: number, seedBlock: string) {
  return `Topic: ${topic || "derive the topic from the content provided below — do NOT echo the words 'infer from' or any placeholder text"}
Bloom Level: ${level} — ${BLOOM_META[level].description}
Verb hint: ${BLOOM_META[level].verb}

Generate ${n} multiple-choice questions strictly at the "${level}" level of Bloom's Taxonomy from the content below.

Content:
"""${content.slice(0, 8000)}"""
${numericalHint(numPct, n)}${seedBlock}

${jsonShape()}`;
}

function imagePrompt(topic: string, level: BloomLevel, n: number, numPct: number, seedBlock: string) {
  return `Topic: ${topic || "derive the topic from the attached image — do NOT echo the words 'infer from' or any placeholder text"}
Bloom Level: ${level} — ${BLOOM_META[level].description}
Verb hint: ${BLOOM_META[level].verb}

Read the attached image carefully (it may be a textbook page, worksheet, last year's question paper, diagram, or whiteboard).
Generate ${n} multiple-choice questions strictly at the "${level}" level of Bloom's Taxonomy based on the content shown.
${numericalHint(numPct, n)}${seedBlock}

${jsonShape()}`;
}

function syllabusPrompt(topic: string, className: string, syllabus: string, level: BloomLevel, n: number, numPct: number, seedBlock: string) {
  const exam = detectExamFromTopic(topic);
  // eslint-disable-next-line no-console
  console.log(`[quick-test] topicSyllabus path — topic="${topic}" — exam detected: ${exam ? exam.name : "NONE"}`);
  if (exam) return examStylePrompt(exam, level, n, numPct, seedBlock);
  return `Topic: ${topic}
Class / grade: ${className}
Syllabus / board: ${syllabus || "(unspecified)"}
Bloom Level: ${level} — ${BLOOM_META[level].description}
Verb hint: ${BLOOM_META[level].verb}

Generate ${n} multiple-choice questions strictly at the "${level}" level of Bloom's Taxonomy on the topic above.
Tailor difficulty, vocabulary and examples to be appropriate for the specified class and aligned to the specified syllabus or curriculum.
${numericalHint(numPct, n)}${seedBlock}

${jsonShape()}`;
}

function pastPaperPrompt(topic: string, examLabel: string, level: BloomLevel, n: number, numPct: number, seedBlock: string) {
  return `Topic: ${topic || "derive the topic from the attached past paper — do NOT echo the words 'infer from' or any placeholder text"}
Past paper / exam reference: ${examLabel || "(unspecified)"}
Bloom Level: ${level} — ${BLOOM_META[level].description}
Verb hint: ${BLOOM_META[level].verb}

The attached image is a PREVIOUS question paper. It may contain a MIX of question formats — multiple-choice, short-answer, long-answer / essay, fill-in-the-blanks, true/false, problem-solving, numerical, diagram-based, case-study, anything.

Your job is to read EVERY question carefully — regardless of its original format — and identify:
- The TOPICS and sub-topics being tested
- The CONCEPTS, definitions, principles, or skills the examiner is probing
- The DIFFICULTY level and depth of understanding required
- The marking pattern and what the examiner clearly weights

For open-ended / essay prompts: don't try to copy the format. Instead, pull out the underlying factual or conceptual claim being tested, and convert THAT into a sharp MCQ. A long "Explain…" or "Discuss…" question typically distils into 3–5 testable MCQ angles — pick the one most aligned to the requested Bloom level.

Now generate ${n} NEW multiple-choice questions strictly at the "${level}" level of Bloom's Taxonomy that:
- Cover the SAME topics and concepts as the past paper (even when those came from non-MCQ questions)
- Match the difficulty and conceptual depth the original demanded
- Are plausibly the kind of questions a student would face in a similar future exam
- Do NOT duplicate any past-paper question verbatim

Output is ALWAYS 4-option MCQs with one correct answer, regardless of the original question format.
${numericalHint(numPct, n)}${seedBlock}

${jsonShape()}`;
}

// =============================================================================
// Competitive-exam detector — duplicated from app/api/generate/route.ts so the
// student "Take a test" flow (this file = /api/student/quick-test) ALSO routes
// "CAT", "JEE", "NEET", … to exam-paper-style prompts instead of meta-questions
// or animal trivia. TODO: extract to lib/examDetector.ts and import from both.
// =============================================================================
type ExamMeta = {
  name: string;
  description: string;
  sections: string[];
  sampleQuestions: string[];
  // Which Bloom levels the actual paper genuinely tests. The request
  // handler filters requested levels through this list — prevents the
  // LLM from being asked for fake "Remember CAT" trivia. Keep in sync
  // with the same field in app/api/generate/route.ts.
  bloomLevels: BloomLevel[];
};

const EXAM_DETECTORS: Record<string, ExamMeta> = {
  CAT: {
    name: "CAT",
    description: "Common Admission Test for IIM/MBA admissions in India",
    sections: ["Quantitative Aptitude", "Verbal Ability and Reading Comprehension", "Data Interpretation and Logical Reasoning"],
    sampleQuestions: [
      "If x + 1/x = 5, find the value of x² + 1/x².",
      "A train travelling at 72 km/hr crosses a 250 m platform in 25 seconds. Find the length of the train.",
      "Identify the option that best replaces the underlined phrase to make the sentence grammatically correct.",
    ],
    bloomLevels: ["apply", "analyze", "evaluate"],
  },
  JEE: {
    name: "JEE Main / JEE Advanced",
    description: "Joint Entrance Examination for engineering admissions in India (IITs/NITs)",
    sections: ["Physics", "Chemistry", "Mathematics"],
    sampleQuestions: [
      "A particle moves along a straight line such that v² = u² + 2as. Find its displacement after 5 s if u = 4 m/s and a = 2 m/s².",
      "Calculate the pH of a 0.01 M HCl solution.",
      "Evaluate the integral ∫ (x² + 1)/(x² - 1) dx.",
    ],
    bloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  NEET: {
    name: "NEET",
    description: "National Eligibility cum Entrance Test for medical admissions in India",
    sections: ["Physics", "Chemistry", "Botany", "Zoology"],
    sampleQuestions: [
      "Which of the following hormones is secreted by the alpha cells of the islets of Langerhans?",
      "The site of Krebs cycle in eukaryotic cells is the:",
      "An object is placed 30 cm in front of a concave mirror of focal length 15 cm. Find the position of the image.",
    ],
    bloomLevels: ["remember", "understand", "apply", "analyze"],
  },
  GMAT: { name: "GMAT", description: "Graduate Management Admission Test", sections: ["Quantitative Reasoning", "Verbal Reasoning", "Data Insights"], sampleQuestions: ["If 0 < x < 1, which is largest among x, x², √x, 1/x, 1/x²?"], bloomLevels: ["apply", "analyze", "evaluate"] },
  GRE:  { name: "GRE",  description: "Graduate Record Examinations",          sections: ["Quantitative Reasoning", "Verbal Reasoning"], sampleQuestions: ["Choose the word that is most nearly synonymous with PROPITIATE."], bloomLevels: ["understand", "apply", "analyze", "evaluate"] },
  UPSC: { name: "UPSC CSE Prelims", description: "UPSC Civil Services Exam preliminary stage (India)", sections: ["General Studies", "CSAT (aptitude, reasoning)"], sampleQuestions: ["Which Article of the Indian Constitution deals with the abolition of untouchability?"], bloomLevels: ["remember", "understand", "apply", "analyze"] },
  IELTS:{ name: "IELTS", description: "International English Language Testing System", sections: ["Listening", "Reading", "Writing", "Speaking"], sampleQuestions: ["According to the passage, the main reason coral reefs are declining is:"], bloomLevels: ["understand", "apply", "analyze"] },
  TOEFL:{ name: "TOEFL", description: "Test of English as a Foreign Language", sections: ["Reading", "Listening", "Speaking", "Writing"], sampleQuestions: ["The word 'ubiquitous' in the passage is closest in meaning to:"], bloomLevels: ["understand", "apply", "analyze"] },
  CLAT: { name: "CLAT",  description: "Common Law Admission Test (India)", sections: ["English", "Current Affairs", "Legal Reasoning", "Logical Reasoning", "Quantitative Techniques"], sampleQuestions: ["Principle: A person who voluntarily causes hurt commits an offence. Has A committed an offence in this scenario?"], bloomLevels: ["remember", "understand", "apply", "analyze"] },
  BITSAT:{ name: "BITSAT", description: "BITS Pilani Admission Test for engineering admissions", sections: ["Physics", "Chemistry", "Mathematics or Biology", "English Proficiency", "Logical Reasoning"], sampleQuestions: ["A capacitor of capacitance 2 μF is charged to 100 V. The energy stored is:"], bloomLevels: ["understand", "apply", "analyze"] },
  SAT:  { name: "SAT",   description: "Scholastic Assessment Test for US college admissions", sections: ["Reading and Writing", "Math"], sampleQuestions: ["If 2(x – 3) = 4x + 6, what is the value of x?"], bloomLevels: ["apply", "analyze"] },
  GATE: { name: "GATE",  description: "Graduate Aptitude Test in Engineering (India)", sections: ["General Aptitude", "Engineering Mathematics", "Subject section"], sampleQuestions: ["The eigenvalues of the matrix [[2,1],[1,2]] are:"], bloomLevels: ["apply", "analyze", "evaluate"] },
  NDA:  { name: "NDA",   description: "National Defence Academy entrance exam (India)", sections: ["Mathematics", "General Ability Test"], sampleQuestions: ["If sin A = 3/5 and cos B = 12/13 (both first quadrant), find sin(A + B)."], bloomLevels: ["remember", "understand", "apply"] },
  CUET: { name: "CUET (UG)", description: "Common University Entrance Test (India)", sections: ["Language", "Domain subjects", "General Test"], sampleQuestions: ["If 3x – 4 = 11, what is the value of 2x + 1?"], bloomLevels: ["remember", "understand", "apply"] },
};

function detectExamFromTopic(topic: string): ExamMeta | null {
  if (!topic) return null;
  const tokens = topic.toUpperCase().split(/[\s,;.\-/_()]+/).filter(Boolean);
  for (const t of tokens) if (EXAM_DETECTORS[t]) return EXAM_DETECTORS[t];
  return null;
}

const FORBIDDEN_INTERPRETATIONS: Record<string, string> = {
  CAT: "cats / felines / animals",
  JEE: "literal English words",
  NEET: "literal English meanings of 'neet'",
  GMAT: "the literal characters",
  GRE: "the country Greece, the literal letters",
  UPSC: "literal interpretations of the letters",
  IELTS: "any non-exam interpretation",
  TOEFL: "any non-exam interpretation",
  CLAT: "the verb 'clat' (clatter)",
  BITSAT: "literal 'bits' / 'sat'",
  SAT: "the past tense of 'sit', a satellite, or any non-exam meaning",
  GATE: "literal gates, doors, or barriers",
  NDA: "non-disclosure agreements or any non-exam meaning",
  CUET: "any non-exam interpretation",
};

function examStylePrompt(exam: ExamMeta, level: BloomLevel, n: number, numPct: number, seedBlock: string) {
  const examKey = exam.name.split(/\s/)[0].toUpperCase();
  const forbidden = FORBIDDEN_INTERPRETATIONS[examKey] || "any non-exam interpretation";
  const exampleBlock = exam.sampleQuestions.length > 0
    ? `

EXAMPLES of REAL ${exam.name} questions (use these to anchor style and difficulty — DO NOT copy verbatim):
${exam.sampleQuestions.map((q, i) => `Example ${i + 1}: ${q}`).join("\n")}`
    : "";

  return `You are writing multiple-choice questions for the ${exam.name} competitive exam paper.

CRITICAL DISAMBIGUATION (read carefully): When this prompt mentions the exam name, it refers EXCLUSIVELY to ${exam.name} — ${exam.description}. The acronym is NOT ${forbidden}. Any question that interprets the acronym as ${forbidden} is WRONG and must NOT be generated. Every single question must be the kind of question that would appear in a real ${exam.name} examination paper for ${exam.name} aspirants.

Typical paper sections of ${exam.name}: ${exam.sections.join("; ")}.${exampleBlock}

Generate ${n} multiple-choice questions in the STYLE, DIFFICULTY, and SECTION COVERAGE of a real ${exam.name} examination paper, at the "${level}" level of Bloom's Taxonomy. These should be questions that could plausibly appear on the exam paper — NOT meta-questions about the exam itself (no "what is the exam about", "who conducts it", "eligibility", "history of the exam", etc.).

Distribute the questions across the canonical sections where applicable: ${exam.sections.join(", ")}. Match the difficulty and tone of past ${exam.name} papers — NOT introductory school-level content unless the section explicitly covers it.

Bloom Level: ${level} — ${BLOOM_META[level].description}
Verb hint: ${BLOOM_META[level].verb}
${numericalHint(numPct, n)}${seedBlock}

${jsonShape()}`;
}

function topicOnlyPrompt(topic: string, level: BloomLevel, n: number, numPct: number, seedBlock: string) {
  const exam = detectExamFromTopic(topic);
  // eslint-disable-next-line no-console
  console.log(`[quick-test] topicOnly path — topic="${topic}" — exam detected: ${exam ? exam.name : "NONE"}`);
  if (exam) return examStylePrompt(exam, level, n, numPct, seedBlock);
  return `Topic: ${topic}
Bloom Level: ${level} — ${BLOOM_META[level].description}
Verb hint: ${BLOOM_META[level].verb}

Generate ${n} multiple-choice questions strictly at the "${level}" level of Bloom's Taxonomy on the topic above, drawing on standard subject knowledge.
${numericalHint(numPct, n)}${seedBlock}

${jsonShape()}`;
}

function refinementSuffix(prev: { stem: string; options: string[]; correct_index: number }) {
  return `

The previous attempt produced this question, but a separate re-solve disputed its answer key. Generate a clearer single-question replacement with an unambiguous correct answer (still at the same Bloom level). Old version (for reference only — DO NOT repeat verbatim):
Stem: ${prev.stem}
Options: ${prev.options.map((o, i) => `${"ABCD"[i]}) ${o}`).join(" | ")}
Old correct_index: ${prev.correct_index}

Return JSON of the form { "questions": [ { "stem": "...", "options": ["A","B","C","D"], "correct_index": 0, "explanation": "..." } ] } with EXACTLY one question.`;
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Confirm caller is a student (this route is for self-generated tests).
    // Also pull exam_goal + learner_profile in the same round-trip so we
    // can decide whether to require class/grade for syllabus-aligned tests
    // — competitive-exam students (jee_main / neet_prep / cat_prep / …) get
    // exam-paper framing regardless of what they typed in the topic field,
    // so requiring "Class 9" from them is a UX bug. See examDetectors.ts.
    const { data: prof } = await sb
      .from("profiles")
      .select("role, exam_goal, learner_profile")
      .eq("id", user.id)
      .single();
    if (prof?.role !== "student") {
      return NextResponse.json({ error: "Only students can use this endpoint" }, { status: 403 });
    }
    const profileExamGoal: string | null = (prof as { exam_goal?: string | null })?.exam_goal ?? null;
    const profileLearnerProfile: string | null = (prof as { learner_profile?: string | null })?.learner_profile ?? null;

    const body = await req.json();
    const source: Source = (body.source as Source) || "topic_only";
    const content: string = body.content || "";
    const topic: string = body.topic || "";
    const className: string = body.className || "";
    const syllabus: string = body.syllabus || "";
    const imageDataUrl: string = body.imageDataUrl || "";
    const examLabel: string = body.examLabel || "";
    // Raised the upper bound from 10 → 25 on 2026-05-12 — students asking
    // for 20 questions/level were getting silently truncated to 10. The
    // post-generation filterQuestionBatch() now enforces an exact slice
    // so larger asks return what was requested.
    const perLevel: number = Math.max(1, Math.min(25, Number(body.perLevel) || 2));
    // Optional non-uniform per-level counts. When present (by_time mode in
    // the UI), each Bloom level gets its own count instead of all sharing
    // `perLevel`. Counts are clamped to 1..10 per level.
    const perLevelCountsRaw = body.perLevelCounts && typeof body.perLevelCounts === "object"
      ? body.perLevelCounts as Record<string, unknown>
      : null;
    function countForLevel(lvl: BloomLevel): number {
      if (!perLevelCountsRaw) return perLevel;
      const v = Number((perLevelCountsRaw as Record<string, unknown>)[lvl]);
      if (!Number.isFinite(v) || v <= 0) return perLevel;
      return Math.max(1, Math.min(10, Math.round(v)));
    }
    const numericalPercent: number = Math.max(0, Math.min(100, Number(body.numericalPercent) || 0));
    // Audience-level (Phase 1), additional-focus textbox (Phase 2), and
    // selected sub-topic chips (Phase 3). All optional — fall back to
    // sensible defaults derived from the user's profile when missing.
    // See lib/audienceLevel.ts and lib/topicEnrichment.ts.
    const rawAudienceLevel: unknown = body.audience_level;
    const additionalFocus: string = typeof body.additional_focus === "string" ? body.additional_focus : "";
    const subTopics: string[] = Array.isArray(body.sub_topics)
      ? (body.sub_topics as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 12)
      : [];
    // Per-test marking scheme (migration 76). Client sends NULL or a
    // MarkingScheme-shaped object from <MarkingSchemePicker />. Pass it
    // through resolveScheme() on the server BEFORE persisting so the
    // JSONB column never holds untrusted shapes (extra keys, non-finite
    // marks, presets we don't know). NULL stays NULL to preserve the
    // legacy +1/0/0 fallback for pre-migration rows.
    const markingScheme: unknown =
      body.markingScheme && typeof body.markingScheme === "object"
        ? resolveScheme(body.markingScheme)
        : null;
    const requested: string[] = Array.isArray(body.levels) ? body.levels : BLOOM_LEVELS;
    const levels: BloomLevel[] = requested.filter(isBloomLevel);
    const timeLimit: number = Math.max(1, Math.min(180, Number(body.timeLimit) || 15));

    // Validation
    if (source === "notes" && content.length < 20) {
      return NextResponse.json({ error: "Paste at least a paragraph of content." }, { status: 400 });
    }
    if (source === "image" && !imageDataUrl.startsWith("data:image/")) {
      return NextResponse.json({ error: "Pick an image to generate from." }, { status: 400 });
    }
    if (source === "past_paper" && !imageDataUrl.startsWith("data:image/")) {
      return NextResponse.json({ error: "Upload a photo of the past question paper." }, { status: 400 });
    }
    if (source === "topic_syllabus" && !topic.trim()) {
      return NextResponse.json({ error: "Topic is required." }, { status: 400 });
    }
    // 2026-05-14 fix: class/grade is not required when EITHER the topic
    // names a competitive exam, OR the student's profile says they're
    // preparing for one. Old check only inspected the topic text, which
    // forced a JEE student typing "Algebra" to also type "Class 11" — the
    // UI bug the tester reported on 2026-05-14. Single source of truth:
    // lib/examDetectors.shouldUseCompetitiveExamFraming.
    const _isExamLikeTopic = shouldUseCompetitiveExamFraming({
      topic,
      learnerProfile: profileLearnerProfile,
      examGoal: profileExamGoal,
    });
    if (source === "topic_syllabus" && !_isExamLikeTopic && !className.trim()) {
      return NextResponse.json({ error: "Class/grade is required for a syllabus-aligned test." }, { status: 400 });
    }
    if (source === "topic_only" && !topic.trim()) {
      return NextResponse.json({ error: "Topic is required." }, { status: 400 });
    }
    if (levels.length === 0) {
      return NextResponse.json({ error: "Pick at least one Bloom level." }, { status: 400 });
    }

    // Per-exam Bloom level allowlist (mirrors app/api/generate/route.ts).
    // When the topic is a known competitive exam, filter the user's
    // requested levels through what the actual paper tests. Stops the
    // LLM from inventing fake Remember-level "trivia" for CAT etc.
    // The response surfaces `examFilter` so the UI can tell the user
    // why some of their ticked levels weren't generated. Variable names
    // examForFilter / omittedLevels match generate/route.ts so a future
    // refactor can hoist this into a shared helper.
    const examForFilter = detectExamFromTopic(topic);
    let omittedLevels: BloomLevel[] = [];
    let effectiveLevels: BloomLevel[] = levels;
    if (examForFilter) {
      const allowed = new Set(examForFilter.bloomLevels);
      effectiveLevels = levels.filter((l) => allowed.has(l));
      omittedLevels = levels.filter((l) => !allowed.has(l));
      if (effectiveLevels.length === 0) {
        return NextResponse.json({
          error: `${examForFilter.name} only tests ${examForFilter.bloomLevels.join(", ")} levels. Pick at least one of those — questions for the levels you selected don't appear on the actual ${examForFilter.name} paper.`,
        }, { status: 400 });
      }
    }

    // eslint-disable-next-line no-console
    console.log(`[quick-test] start source=${source} levels=${levels.join(",")} effectiveLevels=${effectiveLevels.join(",")} perLevel=${perLevel} topic="${topic}"`);

    // Learning-context inheritance (lib/learningContext.ts). The student's
    // exam_goal primes the SYSTEM prompt and disambiguates exam-acronym
    // topics like "CAT" / "GATE" / "CLAT" that collide with everyday
    // words. Applied once here; every prompt builder below uses the
    // context-aware versions.
    const adminForCtx = supabaseAdmin();
    const ctx = await loadLearningContext(adminForCtx, user.id);
    // Resolve audience level — fully optional (2026-05-13 evening).
    // Returns {level:null, promptFragment:""} when the user hasn't picked.
    const audience = resolveAudienceLevel(rawAudienceLevel);
    // Off-topic guard (2026-05-13): textbox stripped if unrelated, warning
    // surfaced to UI. See lib/topicEnrichment.validateFocusForTopic.
    const focusValidation = validateFocusForTopic(topic, additionalFocus, subTopics);
    const effectiveFocus = focusValidation.ok ? additionalFocus : "";
    const focusWarning = focusValidation.ok ? null : focusValidation.reason;
    const contextAwareTopic = applyAdditionalFocus(buildExamAwareTopic(topic, ctx), effectiveFocus, subTopics);
    // Cross-test non-repetition (Layer 1+2+3, lib/recentStemsExclusion.ts).
    // Pull stems the student has already answered on this topic in the
    // last 30 days. We pass bloomLevel=null because this endpoint
    // generates across multiple Bloom levels; the post-gen filter
    // checks each per-level batch against the union of recent stems.
    // Layer 3 (concepts already covered) is baked into the same prompt
    // block.
    const exclusion = await getRecentStemsForExclusion(adminForCtx, user.id, topic, null, 20);
    const audiencePrefix = audience.promptFragment ? `${audience.promptFragment}\n\n` : "";
    // World-class quality lever (2026-05-14 evening): dynamic topic
    // grounding. ONE Groq call decomposes the topic into canonical
    // sub-areas + real-world anchors + common misconceptions. The
    // generator then spreads questions across sub-areas, anchors stems
    // in real terminology, and builds distractors on real misconceptions.
    // Works for ANY topic — no local list. Falls back to ungrounded
    // generation on null. Cached for this request (set once before the
    // per-level loop, reused 1-6× across levels).
    const grounding = await groundTopic(topic, {
      examGoal: profileExamGoal,
      learnerProfile: profileLearnerProfile,
    });
    const groundingBlock = formatGroundingForPrompt(grounding);
    // eslint-disable-next-line no-console
    console.log(`[quick-test] topicGrounding subAreas=${grounding?.subAreas.length ?? 0} anchors=${grounding?.realWorldAnchors.length ?? 0} misconceptions=${grounding?.commonMisconceptions.length ?? 0}`);

    const contextAwareSystem = `${audiencePrefix}${prependLearningContext(SYSTEM, ctx)}${exclusion.promptBlock}${buildSkillFewShotBlock(topic)}${groundingBlock}`;

    // Generate per-level
    const genFor = async (lvl: BloomLevel) => {
      // Mine misconception seeds — empty list on no-data => standard generation.
      let seedBlock = "";
      try {
        const seeds = await findMisconceptionDistractors({
          ownerId: user.id,
          topic: topic || null,
          bloomLevel: lvl,
          limit: 5,
          accessToken: token,
        });
        seedBlock = formatDistractorSeedsForPrompt(seeds);
        if (seeds.length > 0) {
          // eslint-disable-next-line no-console
          console.log(`[quick-test] level=${lvl}: spliced ${seeds.length} misconception seed(s) into prompt`);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[quick-test] level=${lvl}: seed mining failed (non-fatal):`, e instanceof Error ? e.message : e);
      }

      let json: Record<string, unknown>;
      switch (source) {
        case "past_paper":
          json = await groqJSONVision(contextAwareSystem, pastPaperPrompt(contextAwareTopic, examLabel, lvl, perLevel, numericalPercent, seedBlock), imageDataUrl);
          break;
        case "image":
          json = await groqJSONVision(contextAwareSystem, imagePrompt(contextAwareTopic, lvl, perLevel, numericalPercent, seedBlock), imageDataUrl);
          break;
        case "topic_syllabus":
          json = await groqJSON(contextAwareSystem, syllabusPrompt(contextAwareTopic, className, syllabus, lvl, perLevel, numericalPercent, seedBlock));
          break;
        case "topic_only":
          json = await groqJSON(contextAwareSystem, topicOnlyPrompt(contextAwareTopic, lvl, perLevel, numericalPercent, seedBlock));
          break;
        case "notes":
        default:
          json = await groqJSON(contextAwareSystem, notesPrompt(content, contextAwareTopic, lvl, perLevel, numericalPercent, seedBlock));
      }
      const arr: GenQ[] = Array.isArray((json as { questions?: GenQ[] })?.questions)
        ? (json as { questions: GenQ[] }).questions
        : [];
      // eslint-disable-next-line no-console
      console.log(`[quick-test] level=${lvl}: model returned ${arr.length} raw question(s)`);
      const structurallyValid = arr
        .filter((q) => q && q.stem && Array.isArray(q.options) && q.options.length === 4
                      && Number.isInteger(q.correct_index) && q.correct_index >= 0 && q.correct_index <= 3);

      // Semantic in-batch dedup (migration 80, 2026-05-14 evening) — the
      // LLM occasionally emits two questions that are paraphrases of each
      // other with low token overlap. Cosine on embeddings catches these
      // where Jaccard can't. Fail-open: if embedding API is unavailable,
      // skip and let Jaccard handle dedup as before.
      let semanticallyDeduped = structurallyValid;
      if (structurallyValid.length > 1) {
        const candidateEmbs = await embedTexts(structurallyValid.map((q) => q.stem));
        if (candidateEmbs) {
          const withEmb = structurallyValid.map((q, i) => ({ q, embedding: candidateEmbs[i] }));
          const { keptIndices } = cosineDedupInBatch(withEmb, 0.85);
          if (keptIndices.length < structurallyValid.length) {
            // eslint-disable-next-line no-console
            console.log(`[quick-test] level=${lvl}: in-batch cosine dropped ${structurallyValid.length - keptIndices.length} paraphrase(s)`);
          }
          semanticallyDeduped = keptIndices.map((i) => structurallyValid[i]);
        }
      }

      // Quality filters (Vipin 2026-05-12):
      //   1. drop questions whose correct answer is echoed in the stem
      //   2. drop near-duplicate paraphrases inside this batch
      //   3. (Layer 2) drop near-duplicates of stems the student has
      //      already seen on this topic in the last 30 days
      //   4. hard-slice to the user's requested per-level count
      const perLevelTarget = countForLevel(lvl);
      const { kept: passed, droppedLeak, droppedDup, droppedHistory, trimmed } = filterQuestionBatch(
        semanticallyDeduped as Array<{ stem: string; options: string[]; correct_index: number; explanation?: string }>,
        {
          maxCount: perLevelTarget,
          similarityThreshold: 0.7,
          historyStems: exclusion.stems,
        },
      );
      // eslint-disable-next-line no-console
      console.log(
        `[quick-test] level=${lvl}: kept=${passed.length}/${semanticallyDeduped.length} ` +
        `(target=${perLevelTarget}, dropped: leak=${droppedLeak.length} dup=${droppedDup.length} ` +
        `history=${droppedHistory.length} trimmed=${trimmed.length})`
      );

      // 2026-05-14 evening — AUTO-RETRY ON SHORTFALL.
      // When the per-level batch came in short (LLM returned fewer, or the
      // filter dropped too many), fire ONE more groqJSON call asking for
      // EXACTLY the gap. We feed the already-kept stems so the model
      // produces DIFFERENT questions, and we filter the retry through the
      // same quality pipeline (leak/dup/history) before merging. This is
      // the cheapest, highest-leverage way to hit the user's requested
      // count when grounding alone doesn't close it. One retry only — if
      // even that fails, the shortfall toast on the client surfaces the
      // honest delivery.
      let effectivePassed: typeof passed = passed;
      if (passed.length < perLevelTarget) {
        const need = perLevelTarget - passed.length;
        const alreadyHave = passed
          .map((q, i) => `  ${i + 1}. ${q.stem.slice(0, 120)}${q.stem.length > 120 ? "…" : ""}`)
          .join("\n");
        const retryUserPrompt =
          `RETRY — your previous attempt yielded ${passed.length} of ${perLevelTarget} usable questions at the "${lvl}" Bloom level for this topic.\n` +
          `Generate ${need} MORE multiple-choice questions that:\n` +
          `  - are DIFFERENT sub-areas / scenarios from the ones below\n` +
          `  - stay strictly at the "${lvl}" Bloom level\n` +
          `  - obey every constraint in the SYSTEM prompt (no answer-leak in stem, varied scenarios, real terminology, exact count)\n\n` +
          `Questions you already produced (DO NOT repeat the same sub-area or scenario):\n${alreadyHave || "  (none)"}\n\n` +
          `Return JSON: { "questions": [ { "stem": "...", "options": ["A","B","C","D"], "correct_index": 0, "explanation": "..." } ] }`;
        try {
          // eslint-disable-next-line no-console
          console.log(`[quick-test] level=${lvl}: AUTO-RETRY for ${need} more question(s)`);
          const retryRaw = await groqJSON(contextAwareSystem, retryUserPrompt);
          const retryArr: GenQ[] = Array.isArray((retryRaw as { questions?: GenQ[] })?.questions)
            ? (retryRaw as { questions: GenQ[] }).questions
            : [];
          const retryValid = retryArr.filter(
            (q) => q && q.stem && Array.isArray(q.options) && q.options.length === 4
              && Number.isInteger(q.correct_index) && q.correct_index >= 0 && q.correct_index <= 3,
          );
          const { kept: retryKept } = filterQuestionBatch(
            retryValid as Array<{ stem: string; options: string[]; correct_index: number; explanation?: string }>,
            {
              maxCount: need,
              similarityThreshold: 0.7,
              // Treat the kept-so-far stems as "history" too, so the retry
              // can't re-emit anything we already accepted.
              historyStems: [...exclusion.stems, ...passed.map((q) => q.stem)],
            },
          );
          effectivePassed = [...passed, ...retryKept];
          // eslint-disable-next-line no-console
          console.log(`[quick-test] level=${lvl}: retry kept ${retryKept.length}/${retryValid.length}, total now ${effectivePassed.length}/${perLevelTarget}`);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[quick-test] level=${lvl}: retry failed (non-fatal):`, e instanceof Error ? e.message : e);
        }
      }

      const baseRows = effectivePassed.map((q) => ({
        owner_id: user.id,
        topic: topic || null,
        bloom_level: lvl,
        stem: String(q.stem).trim(),
        options: q.options.map((o) => String(o).trim()),
        correct_index: q.correct_index,
        explanation: q.explanation ? String(q.explanation).trim() : null,
        // Default 'approved' for verified rows; the verifier path below
        // may override to 'pending' for disputed rows (Phase H1.3).
        status: "approved" as "approved" | "pending",
      }));

      // Self-verifying answer keys with one regeneration on dispute.
      const verifiable: VerifiableQuestion[] = baseRows.map((r) => ({
        stem: r.stem,
        options: [r.options[0], r.options[1], r.options[2], r.options[3]] as [string, string, string, string],
        correct_index: r.correct_index as 0 | 1 | 2 | 3,
      }));
      const verifyResults = await verifyAnswerKeys(verifiable, 5);

      const finalRows: Array<typeof baseRows[number] & {
        quality: { verified: boolean; reason?: string; reviewer_index?: number };
      }> = [];

      for (let i = 0; i < baseRows.length; i++) {
        const row = baseRows[i];
        const v = verifyResults[i];
        if (v.ok) {
          finalRows.push({ ...row, quality: { verified: true } });
          continue;
        }
        try {
          const refined = await groqJSON(
            SYSTEM,
            refinementSuffix({ stem: row.stem, options: row.options, correct_index: row.correct_index })
          );
          const cand = (refined as { questions?: GenQ[] })?.questions?.[0];
          if (
            cand && cand.stem && Array.isArray(cand.options) && cand.options.length === 4 &&
            Number.isInteger(cand.correct_index) && cand.correct_index >= 0 && cand.correct_index <= 3
          ) {
            const refinedQ: VerifiableQuestion = {
              stem: String(cand.stem).trim(),
              options: cand.options.map((o) => String(o).trim()) as [string, string, string, string],
              correct_index: cand.correct_index as 0 | 1 | 2 | 3,
            };
            const verifyResults2 = await verifyAnswerKeys([refinedQ], 1);
            const v2 = verifyResults2[0];
            const newRow = {
              ...row,
              stem: refinedQ.stem,
              options: [refinedQ.options[0], refinedQ.options[1], refinedQ.options[2], refinedQ.options[3]],
              correct_index: refinedQ.correct_index,
              explanation: cand.explanation ? String(cand.explanation).trim() : row.explanation,
            };
            if (v2.ok) {
              finalRows.push({ ...newRow, quality: { verified: true } });
            } else {
              // eslint-disable-next-line no-console
              console.warn(`[quick-test] level=${lvl}: refinement also disputed; keeping with verified:false`);
              finalRows.push({
                ...newRow,
                status: "pending", // verifier disputed — hide from cross-owner pools
                quality: { verified: false, reason: "answer_disputed", reviewer_index: v2.correctIndex },
              });
            }
          } else {
            // eslint-disable-next-line no-console
            console.warn(`[quick-test] level=${lvl}: refinement returned no usable question; keeping original`);
            finalRows.push({
              ...row,
              status: "pending",
              quality: { verified: false, reason: "answer_disputed", reviewer_index: v.correctIndex },
            });
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[quick-test] level=${lvl}: refinement call failed:`, e instanceof Error ? e.message : e);
          finalRows.push({
            ...row,
            status: "pending",
            quality: { verified: false, reason: "answer_disputed", reviewer_index: v.correctIndex },
          });
        }
      }

      return finalRows;
    };

    const summary = blankBloomCounts();
    const allRows: Awaited<ReturnType<typeof genFor>> = [];

    let results: PromiseSettledResult<Awaited<ReturnType<typeof genFor>>>[];
    const isVisionSource = source === "image" || source === "past_paper";
    if (isVisionSource) {
      results = [];
      for (const lvl of effectiveLevels) {
        try {
          results.push({ status: "fulfilled", value: await genFor(lvl) });
        } catch (e) {
          results.push({ status: "rejected", reason: e });
        }
      }
    } else {
      results = await Promise.allSettled(effectiveLevels.map(genFor));
    }

    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        const lvl = effectiveLevels[i];
        summary[lvl] = r.value.length;
        allRows.push(...r.value);
      }
    });

    if (!allRows.length) {
      // Surface per-level reasons so the dev console + client know why
      const reasons = results
        .map((r, i) => r.status === "rejected" ? `${effectiveLevels[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason).slice(0, 120)}` : `${effectiveLevels[i]}: 0 valid questions`)
        .join(" | ");
      // eslint-disable-next-line no-console
      console.error(`[quick-test] no usable questions. Per-level: ${reasons}`);
      return NextResponse.json({
        error: `AI returned no usable questions. ${reasons.slice(0, 300)}`,
      }, { status: 502 });
    }

    // eslint-disable-next-line no-console
    console.log(`[quick-test] valid questions: ${allRows.length} across ${levels.length} levels`);

    // 1) Insert questions, get back the new IDs in order. Strip the in-memory
    //    `quality` field — question_bank has no such column — and the
    //    in-memory `section` field, which we capture into a parallel array
    //    BEFORE stripping so we can map RETURNING ids back to their section
    //    later when ordering the quiz_questions rows for competitive-exam
    //    sequencing (NEET: Physics → Chemistry → Botany → Zoology, etc.).
    //    insertedQs returns ids in the same order as insertRows, so a
    //    parallel index works.
    const sectionByIndex: (string | null)[] = allRows.map(
      (r) => (r as { section?: string | null }).section ?? null,
    );
    // Semantic embedding pass (migration 80, lib/embeddings.ts) — compute
    // a 768-dim vector for every stem and attach it to the insert row.
    // Failures fall back to null (the DB column allows it; the dedup
    // helper treats NULL as "use Jaccard fallback"). One Gemini batch
    // call per generation, regardless of question count.
    const stemTexts = allRows.map((r) => String((r as { stem?: string }).stem || ""));
    const stemEmbeddings = (await embedTexts(stemTexts)) || stemTexts.map(() => null);
    // eslint-disable-next-line no-console
    console.log(`[quick-test] embedded ${stemEmbeddings.filter((e) => Array.isArray(e)).length}/${stemTexts.length} stems`);
    const insertRows = allRows.map((r, i) => {
      const { quality, section, ...rest } = r as unknown as Record<string, unknown> & { quality?: unknown; section?: unknown };
      void quality;
      void section;
      const emb = stemEmbeddings[i];
      // pgvector accepts arrays directly via supabase-js. NULL when the
      // embedding API didn't return a usable vector for this row.
      return { ...rest, stem_embedding: emb || null };
    });
    const { data: insertedQs, error: qErr } = await sb
      .from("question_bank")
      .insert(insertRows)
      .select("id, bloom_level");
    if (qErr) {
      // eslint-disable-next-line no-console
      console.error(`[quick-test] question_bank insert failed:`, qErr.message);
      return NextResponse.json({ error: `Could not save questions: ${qErr.message}` }, { status: 500 });
    }

    // 2) Classify the quiz — best-effort. If migration 05 isn't applied or the
    //    LLM hiccups, we fall back to no classification rather than blocking.
    let classification: { subject: string | null; topic_family: string | null } = { subject: null, topic_family: null };
    try {
      const { data: existingFams } = await sb
        .from("quizzes")
        .select("topic_family")
        .eq("owner_id", user.id)
        .not("topic_family", "is", null)
        .limit(50);
      const existingFamilies = Array.from(new Set(
        ((existingFams || []) as Array<{ topic_family: string }>).map((e) => e.topic_family).filter(Boolean)
      ));
      const sampleStems = allRows.slice(0, 3).map((r) => r.stem);
      classification = await classifyQuiz(topic, sampleStems, existingFamilies);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[quick-test] classify failed (non-fatal):`, e instanceof Error ? e.message : e);
    }

    // 3) Create a quiz with a fresh code. The collision check needs to see
    // OTHER users' codes too (the unique index spans the whole table), so
    // we use the service-role admin client — RLS would otherwise hide rows
    // that don't belong to the caller.
    const adminCheck = supabaseAdmin();
    let code = generateQuizCode();
    for (let i = 0; i < 4; i++) {
      const { data: existing } = await adminCheck.from("quizzes").select("id").eq("code", code).maybeSingle();
      if (!existing) break;
      code = generateQuizCode();
    }

    const niceName =
      source === "past_paper" ? `Past-paper drill${examLabel ? ` — ${examLabel}` : ""}${topic ? `: ${topic}` : ""}` :
      source === "topic_only" || source === "topic_syllabus" ? `Practice: ${topic}` :
      source === "image" ? `Practice from image${topic ? `: ${topic}` : ""}` :
      `Practice from notes${topic ? `: ${topic}` : ""}`;

    // Try the rich insert first. If the schema doesn't have subject/topic_family
    // yet (migrations 04/05 not applied), gracefully fall back to the basic insert
    // so the test still gets created.
    type QuizInsert = {
      owner_id: string; name: string; code: string;
      time_limit_minutes: number; bloom_filter: string[];
      subject?: string | null; topic_family?: string | null;
      marking_scheme?: unknown | null;
    };
    const fullInsert: QuizInsert = {
      owner_id: user.id,
      name: niceName,
      subject: classification.subject || (topic || null),
      topic_family: classification.topic_family,
      code,
      time_limit_minutes: timeLimit,
      bloom_filter: levels,
      // Migration 76 — per-test scheme. NULL = legacy +1/0/0.
      marking_scheme: markingScheme,
    };
    let { data: quiz, error: quizErr } = await sb.from("quizzes").insert(fullInsert).select().single();
    if (
      quizErr &&
      /column .*(topic_family|subject|marking_scheme)/i.test(quizErr.message)
    ) {
      // eslint-disable-next-line no-console
      console.warn(`[quick-test] schema missing subject/topic_family — falling back. Apply migrations 04 + 05 + 'notify pgrst, "reload schema";'.`);
      const fallbackInsert: QuizInsert = {
        owner_id: user.id,
        name: niceName,
        code,
        time_limit_minutes: timeLimit,
        bloom_filter: levels,
      };
      const fb = await sb.from("quizzes").insert(fallbackInsert).select().single();
      quiz = fb.data;
      quizErr = fb.error;
    }
    if (quizErr || !quiz) {
      // eslint-disable-next-line no-console
      console.error(`[quick-test] quiz insert failed:`, quizErr?.message);
      return NextResponse.json({ error: `Could not create quiz: ${quizErr?.message || "unknown"}` }, { status: 500 });
    }

    // 3) Attach questions to the quiz. Order strategy:
    //    - For competitive-exam topics (NEET, JEE, …) we group by the exam's
    //      canonical section sequence (e.g. NEET: Physics → Chemistry →
    //      Botany → Zoology). Within each section we preserve insertion
    //      order, which means random-feeling order — same as a real paper.
    //    - For regular topics we keep the existing behaviour: Bloom-level
    //      order (Remember → Create), insertion order within a level.
    const examForOrdering = detectExamFromTopic(topic);
    type InsertedQ = { id: string; bloom_level: BloomLevel };
    const insertedTyped = insertedQs as InsertedQ[];
    // Map RETURNING ids back to per-row section using the index parallel.
    const insertedWithSection = insertedTyped.map((q, i) => ({
      ...q,
      section: sectionByIndex[i],
      origIndex: i,
    }));

    function sectionRank(section: string | null, sections: string[]): number {
      if (!section) return sections.length; // unknown sections sort to end
      const norm = section.toLowerCase().trim();
      // First exact match, then substring/contains, then unknown.
      const exact = sections.findIndex((s) => s.toLowerCase().trim() === norm);
      if (exact >= 0) return exact;
      const partial = sections.findIndex((s) => norm.includes(s.toLowerCase().trim()) || s.toLowerCase().trim().includes(norm));
      if (partial >= 0) return partial;
      return sections.length;
    }

    const ordered = examForOrdering
      ? insertedWithSection.slice().sort((a, b) => {
          const ar = sectionRank(a.section, examForOrdering.sections);
          const br = sectionRank(b.section, examForOrdering.sections);
          if (ar !== br) return ar - br;
          // Stable within a section — preserve LLM's original order, which
          // is effectively random across Bloom levels (matches a real
          // exam paper, where questions within a section aren't easy-to-hard).
          return a.origIndex - b.origIndex;
        })
      : insertedWithSection.slice().sort((a, b) => {
          const ai = BLOOM_LEVELS.indexOf(a.bloom_level);
          const bi = BLOOM_LEVELS.indexOf(b.bloom_level);
          if (ai !== bi) return ai - bi;
          return a.origIndex - b.origIndex;
        });
    const linkRows = ordered.map((q, i) => ({
      quiz_id: quiz!.id,
      question_id: q.id,
      position: i,
    }));
    const { error: linkErr } = await sb.from("quiz_questions").insert(linkRows);
    if (linkErr) {
      // eslint-disable-next-line no-console
      console.error(`[quick-test] quiz_questions insert failed:`, linkErr.message);
      return NextResponse.json({ error: `Could not link questions to quiz: ${linkErr.message}` }, { status: 500 });
    }

    // eslint-disable-next-line no-console
    console.log(`[quick-test] success: quiz=${quiz!.code} questions=${linkRows.length}`);

    // Sticky marking-scheme persistence — write the user's pick back to
    // profile.last_marking_scheme so every future test surface
    // pre-fills with this scheme. See lib/markingSchemeMemory.ts. Done
    // ONLY after a successful quiz+questions insert so a failed test
    // never pollutes the preference. Best-effort — silent on failure.
    if (markingScheme && typeof markingScheme === "object") {
      const { writeLastMarkingScheme } = await import("@/lib/markingSchemeMemory");
      const { resolveScheme } = await import("@/lib/scoring");
      await writeLastMarkingScheme(adminForCtx, user.id, resolveScheme(markingScheme));
    }

    const verifiedCount = allRows.filter((r) => r.quality.verified).length;
    const disputedCount = allRows.length - verifiedCount;

    return NextResponse.json({
      ok: true,
      quizId: quiz!.id,
      quizCode: quiz!.code,
      summary,
      total: allRows.length,
      verification: {
        verified: verifiedCount,
        disputed: disputedCount,
      },
      // When the topic matches a known competitive exam, surface any
      // Bloom levels we filtered out so the UI can explain to the user
      // why the test isn't covering everything they ticked.
      examFilter: examForFilter
        ? { name: examForFilter.name, omitted: omittedLevels, supported: examForFilter.bloomLevels }
        : null,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[quick-test] unexpected error:`, e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Test creation failed" }, { status: 500 });
  }
}
