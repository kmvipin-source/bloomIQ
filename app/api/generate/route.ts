import { NextResponse } from "next/server";
import { groqJSON, groqJSONVision } from "@/lib/groq";
import { BLOOM_LEVELS, BLOOM_META, type BloomLevel, isBloomLevel, blankBloomCounts } from "@/lib/bloom";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { checkRateLimit, checkDailyCap } from "@/lib/rateLimit";
import {
  findMisconceptionDistractors,
  formatDistractorSeedsForPrompt,
  verifyAnswerKeys,
  filterQuestionBatch,
  type VerifiableQuestion,
} from "@/lib/qgen";
import {
  loadLearningContext,
  prependLearningContext,
  buildExamAwareTopic,
} from "@/lib/learningContext";
import { getRecentStemsForExclusion } from "@/lib/recentStemsExclusion";
import { resolveAudienceLevel } from "@/lib/audienceLevel";
import { applyAdditionalFocus, validateFocusForTopic } from "@/lib/topicEnrichment";
import { shouldUseCompetitiveExamFraming } from "@/lib/examDetectors";
import { buildSkillFewShotBlock } from "@/lib/skillFewShot";
import { groundTopic, formatGroundingForPrompt } from "@/lib/topicGrounding";
import { embedTexts, cosineDedupInBatch } from "@/lib/embeddings";

export const runtime = "nodejs";
export const maxDuration = 60;

type GenQ = { stem: string; options: string[]; correct_index: number; explanation: string };
type Source = "notes" | "image" | "topic_syllabus" | "topic_only";

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
  return `\n\nNumerical-content target: about ${pct}% (~${target} of ${n}) of these questions should involve numerical reasoning — calculation, formulas, equations, units, or quantitative analysis — BUT ONLY IF the topic naturally supports it (math, physics, chemistry, finance, statistics, economics, etc.). If the topic is purely conceptual (history, literature, geography, philosophy, civics), ignore this and write conceptual questions instead. Don't shoehorn fake numbers into a non-numerical topic.`;
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

Read the attached image carefully (it may be a textbook page, worksheet, diagram, photograph, or whiteboard).
Generate ${n} multiple-choice questions strictly at the "${level}" level of Bloom's Taxonomy based on the content shown in the image.
${numericalHint(numPct, n)}${seedBlock}

${jsonShape()}`;
}

function syllabusPrompt(topic: string, className: string, syllabus: string, level: BloomLevel, n: number, numPct: number, seedBlock: string) {
  const exam = detectExamFromTopic(topic);
  // eslint-disable-next-line no-console
  console.log(`[generate] topicSyllabus path — topic="${topic}" — exam detected: ${exam ? exam.name : "NONE"}`);
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

// =============================================================================
// Competitive-exam detector (Option 2 — see README session 2026-05-03 evening 2).
// -----------------------------------------------------------------------------
// When the user types a bare exam name as the topic (e.g. "CAT", "JEE", "NEET"),
// the default topic prompt makes the LLM produce META-questions ABOUT the exam
// instead of questions IN THE STYLE OF the exam. The detector below catches
// well-known Indian + international competitive exams as a whole-word, case-
// insensitive token match against this allowlist, then switches to a special
// prompt that asks for exam-paper-style questions across the canonical
// sections.
//
// Allowlist-only by design: anything not in the table (Velocity, Acceleration,
// Commerce, Photosynthesis, …) falls through to the existing prompt unchanged.
// Whole-word match ensures Catalysis ≠ CAT, Catalogue ≠ CAT, etc.
// =============================================================================
type ExamMeta = {
  name: string;            // pretty display name
  description: string;     // 1-line "what is this exam"
  sections: string[];      // canonical paper sections
  // 1–2 short example stems that look like REAL questions from this exam.
  // Few-shot examples reliably anchor the LLM on the right question style
  // even when the exam name is an ambiguous abbreviation. Keep them
  // generic so they don't bias the model toward repeating them verbatim.
  sampleQuestions: string[];
  // Which Bloom levels the actual paper genuinely tests. The request
  // handler filters requested levels through this list — prevents the
  // LLM from being asked for fake "Remember CAT questions" etc. Keep in
  // sync with the same field in app/api/student/quick-test/route.ts.
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
  GMAT: {
    name: "GMAT",
    description: "Graduate Management Admission Test for international business school admissions",
    sections: ["Quantitative Reasoning", "Verbal Reasoning", "Data Insights"],
    sampleQuestions: [
      "If 0 < x < 1, which of the following is the largest? (A) x  (B) x²  (C) √x  (D) 1/x  (E) 1/x²",
      "Which of the following best strengthens the argument that increasing the marketing budget will improve profitability?",
    ],
  
    bloomLevels: ["apply", "analyze", "evaluate"],
  },
  GRE: {
    name: "GRE",
    description: "Graduate Record Examinations for international graduate school admissions",
    sections: ["Quantitative Reasoning", "Verbal Reasoning", "Analytical Writing"],
    sampleQuestions: [
      "If 5x – 3 = 2x + 9, what is the value of x?",
      "Choose the word that is most nearly synonymous with PROPITIATE.",
    ],
  
    bloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  UPSC: {
    name: "UPSC CSE Prelims",
    description: "Union Public Service Commission Civil Services Exam preliminary stage (India)",
    sections: ["General Studies (Polity, Economy, Geography, History, Environment, Current Affairs)", "CSAT (aptitude, reasoning, comprehension)"],
    sampleQuestions: [
      "Which of the following Articles of the Indian Constitution deals with the abolition of untouchability?",
      "Consider the following statements about the Goods and Services Tax (GST) Council. Which of the statements given above are correct?",
    ],
  
    bloomLevels: ["remember", "understand", "apply", "analyze"],
  },
  IELTS: {
    name: "IELTS",
    description: "International English Language Testing System",
    sections: ["Listening", "Reading", "Writing", "Speaking"],
    sampleQuestions: [
      "According to the passage, the main reason coral reefs are declining is:",
      "Choose the word that best fits the gap: 'Despite the heavy rain, the team managed to ____ the match on time.'",
    ],
  
    bloomLevels: ["understand", "apply", "analyze"],
  },
  TOEFL: {
    name: "TOEFL",
    description: "Test of English as a Foreign Language",
    sections: ["Reading", "Listening", "Speaking", "Writing"],
    sampleQuestions: [
      "The word 'ubiquitous' in the passage is closest in meaning to:",
      "Which sentence below best expresses the essential information in the highlighted sentence in the passage?",
    ],
  
    bloomLevels: ["understand", "apply", "analyze"],
  },
  CLAT: {
    name: "CLAT",
    description: "Common Law Admission Test for law school admissions in India",
    sections: ["English", "Current Affairs and General Knowledge", "Legal Reasoning", "Logical Reasoning", "Quantitative Techniques"],
    sampleQuestions: [
      "Principle: A person who voluntarily causes hurt commits an offence. Facts: A pushed B in a crowded train accidentally. Has A committed an offence?",
      "Which of the following is a Fundamental Right under the Indian Constitution?",
    ],
  
    bloomLevels: ["remember", "understand", "apply", "analyze"],
  },
  BITSAT: {
    name: "BITSAT",
    description: "BITS Pilani Admission Test for engineering admissions",
    sections: ["Physics", "Chemistry", "Mathematics or Biology", "English Proficiency", "Logical Reasoning"],
    sampleQuestions: [
      "A capacitor of capacitance 2 μF is charged to 100 V. The energy stored in the capacitor is:",
      "If sin θ + cos θ = √2, find the value of sin θ × cos θ.",
    ],
  
    bloomLevels: ["understand", "apply", "analyze"],
  },
  SAT: {
    name: "SAT",
    description: "Scholastic Assessment Test for US college admissions",
    sections: ["Reading and Writing", "Math"],
    sampleQuestions: [
      "If 2(x – 3) = 4x + 6, what is the value of x?",
      "In the passage, the author's primary purpose is most likely to:",
    ],
  
    bloomLevels: ["apply", "analyze"],
  },
  GATE: {
    name: "GATE",
    description: "Graduate Aptitude Test in Engineering (India) for MTech / PSU recruitment",
    sections: ["General Aptitude", "Engineering Mathematics", "Subject-specific section"],
    sampleQuestions: [
      "The eigenvalues of the matrix [[2, 1], [1, 2]] are:",
      "If the time complexity of an algorithm is T(n) = 2T(n/2) + n, then T(n) is:",
    ],
  
    bloomLevels: ["apply", "analyze", "evaluate"],
  },
  NDA: {
    name: "NDA",
    description: "National Defence Academy entrance exam (India)",
    sections: ["Mathematics", "General Ability Test (English + General Knowledge)"],
    sampleQuestions: [
      "If sin A = 3/5 and cos B = 12/13 (both in the first quadrant), find sin(A + B).",
      "Who was the Viceroy of India during the Jallianwala Bagh massacre of 1919?",
    ],
  
    bloomLevels: ["remember", "understand", "apply"],
  },
  CUET: {
    name: "CUET (UG)",
    description: "Common University Entrance Test for undergraduate admissions to Indian universities",
    sections: ["Language", "Domain-specific subjects", "General Test"],
    sampleQuestions: [
      "Read the following passage and choose the option closest in meaning to the underlined word.",
      "If 3x – 4 = 11, what is the value of 2x + 1?",
    ],
  
    bloomLevels: ["remember", "understand", "apply"],
  },
};

function detectExamFromTopic(topic: string): ExamMeta | null {
  if (!topic) return null;
  // Tokenize on whitespace + common punctuation; uppercase for match.
  const tokens = topic.toUpperCase().split(/[\s,;.\-/_()]+/).filter(Boolean);
  for (const t of tokens) {
    if (EXAM_DETECTORS[t]) return EXAM_DETECTORS[t];
  }
  return null;
}

function examStylePrompt(exam: ExamMeta, level: BloomLevel, n: number, numPct: number, seedBlock: string) {
  // The disambiguation banner is the most important line in this prompt.
  // For short, ambiguous abbreviations (CAT, GRE, GATE, NDA, SAT) the LLM
  // has strong priors on a non-exam meaning (animal, machine, gate, …)
  // and will produce off-topic questions if we don't explicitly forbid it.
  // Listing 4–6 forbidden interpretations up front is a known prompt-
  // engineering trick that reliably routes the model to the exam meaning.
  const forbiddenExamples: Record<string, string> = {
    CAT:    "cats / felines / animals",
    JEE:    "literal English words",
    NEET:   "literal English meanings of 'neet'",
    GMAT:   "the literal characters",
    GRE:    "the country Greece, the literal letters",
    UPSC:   "literal interpretations of the letters",
    IELTS:  "any non-exam interpretation",
    TOEFL:  "any non-exam interpretation",
    CLAT:   "the verb 'clat' (clatter)",
    BITSAT: "literal 'bits' / 'sat'",
    SAT:    "the past tense of 'sit', a satellite, or any non-exam meaning",
    GATE:   "literal gates, doors, or barriers",
    NDA:    "non-disclosure agreements or any non-exam meaning",
    CUET:   "any non-exam interpretation",
  };
  const examKey = exam.name.split(/\s/)[0].toUpperCase();
  const forbidden = forbiddenExamples[examKey] || "any non-exam interpretation";

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
  console.log(`[generate] topicOnly path — topic="${topic}" — exam detected: ${exam ? exam.name : "NONE"}`);
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
    // /api/generate fires multiple LLM calls per request (one per Bloom
    // level + verifier + refinement). Tight burst limit; hard daily cap.
    const rate = checkRateLimit(user.id, "generate", { capacity: 5, refillPerHour: 10 });
    if (!rate.allowed) return NextResponse.json({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });
    const daily = checkDailyCap(user.id, "generate", 30);
    if (!daily.allowed) return NextResponse.json({ error: `Daily limit reached (${daily.limit}).`, code: "daily_cap" }, { status: 429 });

    const body = await req.json();
    const source: Source = (body.source as Source) || "notes";
    const content: string = body.content || "";
    const topic: string = body.topic || "";
    const className: string = body.className || "";
    const syllabus: string = body.syllabus || "";
    const imageDataUrl: string = body.imageDataUrl || "";
    // Raised the upper bound from 10 → 25 on 2026-05-12 — Vipin caught a
    // silent clamp where teachers asking for 20 questions/level were
    // getting their request truncated to 10 with no UI indication. The
    // post-generation filterQuestionBatch() handles the hard slice to
    // exactly the requested count, so larger asks just mean "give me
    // more on this Bloom level". 25 caps the prompt-token spend.
    const perLevel: number = Math.max(1, Math.min(25, Number(body.perLevel) || 2));
    const numericalPercent: number = Math.max(0, Math.min(100, Number(body.numericalPercent) || 0));
    const requested: string[] = Array.isArray(body.levels) ? body.levels : BLOOM_LEVELS;
    const levels: BloomLevel[] = requested.filter(isBloomLevel);
    // Audience-level signal (Phase 1) — explicit user pick overrides the default
    // derived from profile (exam_goal + learner_profile). Threaded into the
    // system prompt below. See lib/audienceLevel.ts.
    const rawAudienceLevel: unknown = body.audience_level;
    // Optional "Anything specific to cover?" textbox (Phase 2). Free-form
    // user hint about which sub-areas of the topic to bias toward. Threaded
    // into the user prompt via lib/topicEnrichment.applyAdditionalFocus.
    const additionalFocus: string = typeof body.additional_focus === "string" ? body.additional_focus : "";
    // Optional sub-topic chips (Phase 3) — array of strings the user explicitly
    // toggled on. Pre-joined into the user prompt the same way as
    // additional_focus.
    const subTopics: string[] = Array.isArray(body.sub_topics)
      ? body.sub_topics.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 12)
      : [];

    // Per-source validation
    if (source === "notes" && content.length < 20) {
      return NextResponse.json({ error: "Content too short" }, { status: 400 });
    }
    if (source === "image" && !imageDataUrl.startsWith("data:image/")) {
      return NextResponse.json({ error: "Missing or invalid image" }, { status: 400 });
    }
    if (source === "topic_syllabus" && !topic.trim()) {
      return NextResponse.json({ error: "Topic is required" }, { status: 400 });
    }
    // 2026-05-14 fix: class/grade is NOT required when the topic itself is
    // a known competitive exam OR when the caller explicitly tells us via
    // body.learnerProfile / body.examGoal that this is a competitive-exam
    // session (e.g. a coaching school using /api/generate from an admin
    // tool). Old check only inspected the topic text — teachers in JEE
    // coaching schools typing a generic topic like "Mechanics" got a
    // bogus 400. Single source of truth: lib/examDetectors.
    const bodyLearnerProfile: string | null = typeof body.learnerProfile === "string" ? body.learnerProfile : null;
    const bodyExamGoal: string | null = typeof body.examGoal === "string" ? body.examGoal : null;
    const _isExamLikeTopic = shouldUseCompetitiveExamFraming({
      topic,
      learnerProfile: bodyLearnerProfile,
      examGoal: bodyExamGoal,
    });
    if (source === "topic_syllabus" && !_isExamLikeTopic && !className.trim()) {
      return NextResponse.json({ error: "Class/grade is required for a syllabus-aligned test." }, { status: 400 });
    }
    if (source === "topic_only" && !topic.trim()) {
      return NextResponse.json({ error: "Topic is required" }, { status: 400 });
    }
    if (levels.length === 0) {
      return NextResponse.json({ error: "No Bloom levels selected" }, { status: 400 });
    }

    // Per-exam Bloom level allowlist: when the topic is a known exam,
    // filter the user's requested levels through what the actual paper
    // tests. Stops the LLM from inventing fake commerce trivia for
    // "Remember CAT" requests.
    const examForFilter = detectExamFromTopic(topic);
    let omittedLevels: BloomLevel[] = [];
    let effectiveLevels = levels;
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

    // Learning-context inheritance — same pattern as student endpoints.
    // Plus cross-test non-repetition: a teacher building a fresh quiz
    // on the same topic shouldn't get the same questions they generated
    // last week. Exclusion list = stems the TEACHER themselves have
    // seen via past attempts (mostly captured when they preview-take
    // their own quizzes); this is best-effort for teacher-side.
    const adminForCtx = supabaseAdmin();
    const ctx = await loadLearningContext(adminForCtx, user.id);
    // Resolve audience level. Returns {level:null, promptFragment:""} when
    // the user hasn't picked — fully optional, no profile-derived default.
    const audience = resolveAudienceLevel(rawAudienceLevel);
    // Off-topic guard (2026-05-13): if the textbox text isn't related to the
    // main topic (heuristic — e.g., "Krebs cycle" on a Mainframe test), STRIP
    // it from the prompt and surface a warning the UI can show. We never
    // silently keep an off-topic angle.
    const focusValidation = validateFocusForTopic(topic, additionalFocus, subTopics);
    const effectiveFocus = focusValidation.ok ? additionalFocus : "";
    const focusWarning = focusValidation.ok ? null : focusValidation.reason;
    const contextAwareTopic = applyAdditionalFocus(buildExamAwareTopic(topic, ctx), effectiveFocus, subTopics);
    const exclusion = await getRecentStemsForExclusion(adminForCtx, user.id, topic, null, 20);
    // Audience fragment is empty when the user didn't pick a level — skip the
    // double newline in that case so the prompt doesn't start with whitespace.
    const audiencePrefix = audience.promptFragment ? `${audience.promptFragment}\n\n` : "";
    // World-class quality lever (2026-05-14 evening): dynamic topic
    // grounding. See lib/topicGrounding for full rationale. Mirror of
    // the wiring in /api/student/quick-test.
    const grounding = await groundTopic(topic, {
      examGoal: bodyExamGoal,
      learnerProfile: bodyLearnerProfile,
    });
    const groundingBlock = formatGroundingForPrompt(grounding);
    // eslint-disable-next-line no-console
    console.log(`[generate] topicGrounding subAreas=${grounding?.subAreas.length ?? 0} anchors=${grounding?.realWorldAnchors.length ?? 0} misconceptions=${grounding?.commonMisconceptions.length ?? 0}`);

    const contextAwareSystem = `${audiencePrefix}${prependLearningContext(SYSTEM, ctx)}${exclusion.promptBlock}${buildSkillFewShotBlock(topic)}${groundingBlock}`;

    const summary = blankBloomCounts();
    type RowWithQuality = {
      owner_id: string; topic: string | null; bloom_level: BloomLevel;
      stem: string; options: string[]; correct_index: number;
      explanation: string | null; status: "pending";
      quality: { verified: boolean; reason?: string; reviewer_index?: number };
    };
    const allRows: RowWithQuality[] = [];

    // Build a generator per level — different prompt + model depending on source
    const genFor = async (lvl: BloomLevel) => {
      // Mine misconception seeds for this teacher + topic + level. Empty array
      // on no-data / error => standard generation, no behaviour change.
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
          console.log(`[generate] level=${lvl}: spliced ${seeds.length} misconception seed(s) into prompt`);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[generate] level=${lvl}: seed mining failed (non-fatal):`, e instanceof Error ? e.message : e);
      }

      let json: Record<string, unknown>;
      try {
        switch (source) {
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
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[generate] Groq call failed for level=${lvl}:`, e instanceof Error ? e.message : e);
        throw e;
      }
      const arr: GenQ[] = Array.isArray((json as { questions?: GenQ[] })?.questions)
        ? (json as { questions: GenQ[] }).questions
        : [];
      // eslint-disable-next-line no-console
      console.log(`[generate] level=${lvl}: model returned ${arr.length} raw question(s)`);
      const structurallyValid = arr
        .filter((q) => q && q.stem && Array.isArray(q.options) && q.options.length === 4
                      && Number.isInteger(q.correct_index) && q.correct_index >= 0 && q.correct_index <= 3);

      // Quality + cross-test filters (Vipin 2026-05-12):
      //   1. drop questions whose correct answer is echoed in the stem
      //   2. drop near-duplicate paraphrases inside this batch
      //   3. drop questions ≥70% similar to stems already seen recently
      //   4. hard-slice to the user's requested per-level count
      const { kept: passed, droppedLeak, droppedDup, droppedHistory, trimmed } = filterQuestionBatch(
        semanticallyDeduped as Array<{ stem: string; options: string[]; correct_index: number; explanation?: string }>,
        {
          maxCount: perLevel,
          similarityThreshold: 0.7,
          historyStems: exclusion.stems,
        },
      );
      // eslint-disable-next-line no-console
      console.log(
        `[generate] level=${lvl}: kept=${passed.length}/${semanticallyDeduped.length} ` +
        `(target=${perLevel}, dropped: leak=${droppedLeak.length} dup=${droppedDup.length} ` +
        `history=${droppedHistory.length} trimmed=${trimmed.length})`
      );

      // 2026-05-14 evening — AUTO-RETRY ON SHORTFALL (mirror of quick-test).
      let effectivePassed: typeof passed = passed;
      if (passed.length < perLevel) {
        const need = perLevel - passed.length;
        const alreadyHave = passed
          .map((q, i) => `  ${i + 1}. ${q.stem.slice(0, 120)}${q.stem.length > 120 ? "…" : ""}`)
          .join("\n");
        const retryUserPrompt =
          `RETRY — your previous attempt yielded ${passed.length} of ${perLevel} usable questions at the "${lvl}" Bloom level.\n` +
          `Generate ${need} MORE distinct multiple-choice questions on different sub-areas / scenarios.\n\n` +
          `Already produced (do NOT repeat sub-area or scenario):\n${alreadyHave || "  (none)"}\n\n` +
          `Return JSON: { "questions": [ { "stem": "...", "options": ["A","B","C","D"], "correct_index": 0, "explanation": "..." } ] }`;
        try {
          // eslint-disable-next-line no-console
          console.log(`[generate] level=${lvl}: AUTO-RETRY for ${need} more question(s)`);
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
              historyStems: [...exclusion.stems, ...passed.map((q) => q.stem)],
            },
          );
          effectivePassed = [...passed, ...retryKept];
          // eslint-disable-next-line no-console
          console.log(`[generate] level=${lvl}: retry kept ${retryKept.length}/${retryValid.length}, total ${effectivePassed.length}/${perLevel}`);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[generate] level=${lvl}: retry failed (non-fatal):`, e instanceof Error ? e.message : e);
        }
      }

      // Self-verifying answer keys: re-solve every passed question; if the
      // re-solve disagrees, try ONE refinement; if that still disagrees,
      // mark verified=false and let it through with metadata.
      const baseRows = effectivePassed.map((q) => ({
        owner_id: user.id,
        topic: topic || null,
        bloom_level: lvl,
        stem: String(q.stem).trim(),
        options: q.options.map((o) => String(o).trim()),
        correct_index: q.correct_index,
        explanation: q.explanation ? String(q.explanation).trim() : null,
        status: "pending" as const,
      }));

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
        // Disputed — try one refinement.
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
              console.warn(
                `[generate] level=${lvl}: refinement also disputed.\n` +
                `  stem="${(newRow.stem || "").slice(0, 140)}"\n` +
                `  author_correct_index=${newRow.correct_index}, reviewer_correct_index=${v2.correctIndex}\n` +
                `  options=${JSON.stringify(newRow.options)}`,
              );
              finalRows.push({
                ...newRow,
                quality: { verified: false, reason: "answer_disputed", reviewer_index: v2.correctIndex },
              });
            }
          } else {
            // Refinement returned junk — keep original, mark unverified.
            // eslint-disable-next-line no-console
            console.warn(
              `[generate] level=${lvl}: refinement returned no usable question; keeping original.\n` +
              `  stem="${(row.stem || "").slice(0, 140)}"\n` +
              `  author_correct_index=${row.correct_index}, reviewer_correct_index=${v.correctIndex}\n` +
              `  options=${JSON.stringify(row.options)}`,
            );
            finalRows.push({
              ...row,
              quality: { verified: false, reason: "answer_disputed", reviewer_index: v.correctIndex },
            });
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[generate] level=${lvl}: refinement call failed:`, e instanceof Error ? e.message : e);
          finalRows.push({
            ...row,
            quality: { verified: false, reason: "answer_disputed", reviewer_index: v.correctIndex },
          });
        }
      }

      return finalRows;
    };

    // Image generation calls run sequentially to keep the multipart payload sane;
    // text-only calls fan out in parallel for speed.
    let results: PromiseSettledResult<Awaited<ReturnType<typeof genFor>>>[];
    if (source === "image") {
      results = [];
      for (const lvl of effectiveLevels) {
        try {
          const v = await genFor(lvl);
          results.push({ status: "fulfilled", value: v });
        } catch (e) {
          results.push({ status: "rejected", reason: e });
        }
      }
    } else {
      results = await Promise.allSettled(effectiveLevels.map(genFor));
    }

    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        const lvl = levels[i];
        summary[lvl] = r.value.length;
        allRows.push(...r.value);
      }
    });

    if (!allRows.length) {
      // Surface the per-level reasons so the client (and the dev server log) can see what went wrong
      const reasons = results
        .map((r, i) => r.status === "rejected" ? `${effectiveLevels[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason).slice(0, 120)}` : `${effectiveLevels[i]}: 0 valid questions`)
        .join(" | ");
      // eslint-disable-next-line no-console
      console.error(`[generate] No questions produced. Per-level: ${reasons}`);
      return NextResponse.json({
        error: `AI returned no usable questions. ${reasons.slice(0, 300)}`,
      }, { status: 502 });
    }

    // Strip the in-memory `quality` field before persisting — question_bank
    // has no such column. We expose the aggregate verification stats on the
    // API response only, so existing consumers stay unaffected.
    //
    // Semantic embedding pass (migration 80) — compute a 768-dim vector
    // for every stem so future generations can cosine-dedup against the
    // student's prior questions. One Gemini batch call; null per-row on
    // failure (the DB column is nullable, dedup falls back to Jaccard).
    const stemTexts = allRows.map((r) => String(r.stem || ""));
    const stemEmbeddings = (await embedTexts(stemTexts)) || stemTexts.map(() => null);
    // eslint-disable-next-line no-console
    console.log(`[generate] embedded ${stemEmbeddings.filter((e) => Array.isArray(e)).length}/${stemTexts.length} stems`);
    const insertRows = allRows.map((r, i) => {
      const { quality, ...rest } = r;
      void quality;
      return { ...rest, stem_embedding: stemEmbeddings[i] || null };
    });
    const { error } = await sb.from("question_bank").insert(insertRows);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const verifiedCount = allRows.filter((r) => r.quality.verified).length;
    const disputedCount = allRows.length - verifiedCount;

    return NextResponse.json({
      ok: true,
      summary,
      total: allRows.length,
      verification: {
        verified: verifiedCount,
        disputed: disputedCount,
      },
      examFilter: examForFilter
        ? { name: examForFilter.name, omitted: omittedLevels, supported: examForFilter.bloomLevels }
        : null,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Generation failed" }, { status: 500 });
  }
}
