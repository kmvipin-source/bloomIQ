// lib/examDetectors.ts
// -----------------------------------------------------------------------------
// SINGLE SOURCE OF TRUTH for competitive-exam detection + per-exam style
// prompts.
//
// 2026-05-13 evening — hoisted out of `app/api/generate/route.ts` and
// `app/api/student/quick-test/route.ts` which had been carrying drift-prone
// copies of EXAM_DETECTORS, FORBIDDEN_INTERPRETATIONS, detectExamFromTopic
// and examStylePrompt. Every generator route should import from here.
//
// Adding a new exam:
//   - Drop a row into EXAM_DETECTORS (name, description, sections,
//     sampleQuestions, bloomLevels).
//   - Add an entry to FORBIDDEN_INTERPRETATIONS if the acronym is
//     ambiguous (CAT-the-animal, GATE-the-door, etc.).
// =============================================================================

import { BLOOM_META, type BloomLevel } from "@/lib/bloom";

export type ExamMeta = {
  /** Pretty display name (e.g. "JEE Main / JEE Advanced"). */
  name: string;
  /** One-line "what is this exam" — used inside the prompt. */
  description: string;
  /** Canonical paper sections — drives the "distribute across sections" line. */
  sections: string[];
  /** 2-3 sample questions used as few-shot anchors in the system prompt. */
  sampleQuestions: string[];
  /** Bloom levels the actual paper genuinely tests. Routes filter requested
   *  levels through this list — prevents fake "Remember CAT questions". */
  bloomLevels: BloomLevel[];
};

export const EXAM_DETECTORS: Record<string, ExamMeta> = {
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

/** Acronym disambiguation hints — prepended to the prompt for ambiguous slugs. */
const FORBIDDEN_INTERPRETATIONS: Record<string, string> = {
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

/** Detect a competitive exam from a free-text topic. Returns ExamMeta or null.
 *  Whole-word match — "Catalysis" won't match "CAT". */
export function detectExamFromTopic(topic: string | null | undefined): ExamMeta | null {
  if (!topic) return null;
  const tokens = topic.toUpperCase().split(/[\s,;.\-/_()]+/).filter(Boolean);
  for (const t of tokens) {
    if (EXAM_DETECTORS[t]) return EXAM_DETECTORS[t];
  }
  return null;
}

/** Whether the topic looks like a known competitive exam — handy for UI gates. */
export function isCompetitiveExamTopic(topic: string | null | undefined): boolean {
  return detectExamFromTopic(topic) !== null;
}

/**
 * Exam-goal slugs that indicate the student is preparing for a competitive
 * exam. Mirrors lib/learnerProfileFromGoal.GOAL_TO_PROFILE === "competitive_exam"
 * entries but kept as a self-contained list so this module has no upstream
 * dependency on learnerProfileFromGoal.
 *
 * Adding a new competitive goal in StudentGoalPicker → also add it here and
 * to lib/learnerProfileFromGoal.GOAL_TO_PROFILE.
 */
const COMPETITIVE_EXAM_GOAL_SLUGS = new Set<string>([
  "jee_main", "jee_advanced", "jee_prep",
  "neet_prep", "neet",
  "cat_prep", "cat",
  "upsc_prep", "upsc",
  "bank_exams", "bank_prep", "ibps", "sbi",
  "gmat_prep", "gmat",
  "gre_prep", "gre",
  "gate_prep", "gate",
  "clat_prep", "clat",
  "cuet_prep", "cuet",
  "bitsat_prep", "bitsat",
  "sat_prep", "sat",
  "nda_prep", "nda",
]);

/** Whether an exam_goal slug names a competitive-exam preparation goal. */
export function isCompetitiveExamGoal(examGoal: string | null | undefined): boolean {
  if (!examGoal) return false;
  return COMPETITIVE_EXAM_GOAL_SLUGS.has(String(examGoal).toLowerCase().trim());
}

/**
 * Combined check used by every UI gate + backend validator that asks "should
 * we apply competitive-exam framing (hide class/syllabus inputs, use
 * exam-style prompts, skip K-12 board defaults)?".
 *
 * Returns true if ANY of:
 *   1. The topic itself names a competitive exam (CAT, JEE, NEET, …)
 *   2. The student's learner_profile is "competitive_exam"
 *   3. The student's exam_goal slug maps to a competitive exam
 *
 * Fixes the long-standing bug where a JEE-prep student typing a generic
 * topic like "Algebra" or "Calculus" was shown CBSE/ICSE syllabus inputs
 * — the topic alone has no JEE token so the UI fell through to K-12 framing
 * even though the profile screamed "JEE".
 */
export function shouldUseCompetitiveExamFraming(opts: {
  topic?: string | null;
  learnerProfile?: string | null;
  examGoal?: string | null;
}): boolean {
  if (isCompetitiveExamTopic(opts.topic)) return true;
  if (opts.learnerProfile === "competitive_exam") return true;
  if (isCompetitiveExamGoal(opts.examGoal)) return true;
  return false;
}

/** Filter the user's requested Bloom levels through what this exam tests.
 *  Returns { effective, omitted } so the UI can warn about silently dropped levels. */
export function filterBloomLevelsForExam(
  requested: BloomLevel[],
  exam: ExamMeta | null,
): { effective: BloomLevel[]; omitted: BloomLevel[] } {
  if (!exam) return { effective: requested, omitted: [] };
  const allowed = new Set(exam.bloomLevels);
  const effective = requested.filter((l) => allowed.has(l));
  const omitted = requested.filter((l) => !allowed.has(l));
  return { effective, omitted };
}

/** Numerical-content hint shared by every prompt builder. */
function numericalHint(pct: number, n: number): string {
  if (pct <= 0) return "";
  const target = Math.max(1, Math.round((pct / 100) * n));
  return `\n\nNumerical-content target: about ${pct}% (~${target} of ${n}) of these questions should involve numerical reasoning — calculation, formulas, equations, units, or quantitative analysis — BUT ONLY IF the topic naturally supports it. If purely conceptual, ignore this and write conceptual questions instead.`;
}

function jsonShape(): string {
  return `Output JSON of the form:\n{ "questions": [ { "stem": "...", "options": ["A","B","C","D"], "correct_index": 0, "explanation": "..." } ] }`;
}

/** Build an exam-style system+user prompt fragment. Drop-in replacement for
 *  the inline `examStylePrompt` previously duplicated in two routes. */
export function examStylePrompt(
  exam: ExamMeta,
  level: BloomLevel,
  n: number,
  numPct: number,
  seedBlock: string,
): string {
  const examKey = exam.name.split(/\s/)[0].toUpperCase();
  const forbidden = FORBIDDEN_INTERPRETATIONS[examKey] || "any non-exam interpretation";

  const exampleBlock = exam.sampleQuestions.length > 0
    ? `\n\nEXAMPLES of REAL ${exam.name} questions (use these to anchor style and difficulty — DO NOT copy verbatim):\n${exam.sampleQuestions.map((q, i) => `Example ${i + 1}: ${q}`).join("\n")}`
    : "";

  return `You are writing multiple-choice questions for the ${exam.name} competitive exam paper.

CRITICAL DISAMBIGUATION (read carefully): When this prompt mentions the exam name, it refers EXCLUSIVELY to ${exam.name} — ${exam.description}. The acronym is NOT ${forbidden}. Any question that interprets the acronym as ${forbidden} is WRONG and must NOT be generated. Every single question must be the kind of question that would appear in a real ${exam.name} examination paper for ${exam.name} aspirants.

Typical paper sections of ${exam.name}: ${exam.sections.join("; ")}.${exampleBlock}

Generate ${n} multiple-choice questions in the STYLE, DIFFICULTY, and SECTION COVERAGE of a real ${exam.name} examination paper, at the "${level}" level of Bloom's Taxonomy. These should be questions that could plausibly appear on the exam paper — NOT meta-questions about the exam itself.

Distribute the questions across the canonical sections where applicable: ${exam.sections.join(", ")}. Match the difficulty and tone of past ${exam.name} papers — NOT introductory school-level content unless the section explicitly covers it.

Bloom Level: ${level} — ${BLOOM_META[level].description}
Verb hint: ${BLOOM_META[level].verb}
${numericalHint(numPct, n)}${seedBlock}

${jsonShape()}`;
}
// =============================================================================
// Topic-vs-exam-syllabus alignment validator (2026-05-14, evening)
// -----------------------------------------------------------------------------
// Catches the "NEET student types 'history' and gets no warning" class of bug.
// Each exam's syllabus is bounded — generating "history" questions in NEET
// style is nonsensical. Same for "biology" in CAT, "thermodynamics" in UPSC,
// etc. We don't BLOCK — student may have a legit reason to test off-syllabus
// (curiosity, cross-prep) — we just warn so they don't waste a generation
// thinking the topic will be exam-shaped.
//
// Implementation: per-exam keyword sets covering the syllabus subjects + their
// most common sub-topic tokens. Topic is tokenised whole-word + uppercased
// (same splitter as detectExamFromTopic). A topic "matches" the exam if ANY
// token hits the keyword set. K-12 / corporate goals are NOT validated — their
// syllabus is broad enough that almost anything is a fair topic.
// =============================================================================

/** Whole-word keyword sets for each competitive exam's syllabus. Covers the
 *  canonical subjects plus the most common sub-topic vocabulary students
 *  type. Maintenance: when adding a new exam to EXAM_DETECTORS, drop a
 *  matching row here. Missing rows = no validation = no warning fired. */
const EXAM_SUBJECT_KEYWORDS: Record<string, Set<string>> = {
  CAT: new Set([
    // Quant Aptitude — keep CAT-specific quant vocabulary. Removed
    // generic math single-words (MATH/NUMBERS/EQUATION/FUNCTION/etc.)
    // because they're shared with JEE/GMAT and cause cross-exam false
    // positives (a JEE student typing "equation" was being told to
    // switch to CAT).
    "QUANT", "QUANTITATIVE", "APTITUDE",
    "MENSURATION", "PROFIT", "LOSS",
    "PERMUTATION", "PERMUTATIONS", "COMBINATION", "COMBINATIONS",
    "PROBABILITY", "RATIO", "RATIOS", "PROPORTION", "PROPORTIONS",
    "PERCENTAGE", "PERCENTAGES",
    "AVERAGES", "INTEREST", "INTERESTS",
    "TIMEANDWORK", "TIMEANDDISTANCE",
    // Verbal Ability + Reading Comprehension
    "VARC", "RC", "PARAJUMBLES", "JUMBLES",
    "VOCABULARY", "SYNONYM", "SYNONYMS", "ANTONYM", "ANTONYMS",
    "SENTENCECORRECTION", "PARAGRAPHSUMMARY", "PARASUMMARY",
    "CRITICALREASONING",
    // Data Interpretation + Logical Reasoning. Single-word ambiguous
    // tokens (DATA, RELATION, DIRECTION, BLOOD, TABLES, CHARTS, GRAPHS,
    // BARS, PIE, LOGICAL) were removed — they triggered false positives
    // for "blood group" (NEET), "direction of force" (physics), "data
    // structures" (GATE), etc. We rely on the concatenated forms now,
    // which only match when both words appear adjacent.
    "DI", "LR", "DATAINTERPRETATION",
    "PUZZLES", "PUZZLE", "SEATINGARRANGEMENT", "SEATING",
    "CASELET", "CASELETS",
    "SYLLOGISM", "SYLLOGISMS",
    "BLOODRELATION", "BLOODRELATIONS",
    "DIRECTIONSENSE",
    // Exam tokens — these are unambiguous
    "CAT", "IIM", "IIMS", "MBAPREP", "MBAMOCK",
  ]),
  JEE: new Set([
    // Physics
    "PHYSICS", "MECHANICS", "KINEMATICS", "DYNAMICS", "ROTATIONAL", "GRAVITATION",
    "THERMODYNAMICS", "THERMAL", "HEAT", "WAVES", "OPTICS", "OPTICAL",
    "ELECTROSTATICS", "ELECTRICITY", "MAGNETISM", "ELECTROMAGNETISM", "EMI",
    "CURRENT", "CIRCUIT", "CIRCUITS", "MODERN", "ATOMIC", "NUCLEAR", "PHOTOELECTRIC",
    "ROTATION", "OSCILLATION", "OSCILLATIONS", "SHM", "ELASTICITY", "FLUID", "FLUIDS",
    "VECTOR", "VECTORS", "FORCE", "FORCES", "ENERGY", "MOMENTUM", "WORK", "POWER",
    // Chemistry
    "CHEMISTRY", "CHEM", "PHYSICAL", "ORGANIC", "INORGANIC", "MOLE",
    "ATOMIC", "STRUCTURE", "BONDING", "EQUILIBRIUM", "KINETICS", "ELECTROCHEMISTRY",
    "THERMOCHEM", "SOLUTIONS", "GAS", "GASES", "STATE", "STATES",
    "PERIODIC", "ELEMENTS", "REACTION", "REACTIONS", "ACID", "BASE", "REDOX",
    "ALKANE", "ALKENE", "ALKYNE", "BENZENE", "ALCOHOL", "ALDEHYDE", "KETONE", "CARBOXYLIC",
    "AMINE", "POLYMER", "POLYMERS", "BIOMOLECULES", "COORDINATION", "BLOCK",
    // Maths
    "MATH", "MATHS", "MATHEMATICS", "ALGEBRA", "CALCULUS", "DIFFERENTIAL", "INTEGRAL",
    "INTEGRATION", "DIFFERENTIATION", "LIMIT", "LIMITS", "CONTINUITY", "DERIVATIVE",
    "COORDINATE", "GEOMETRY", "TRIGONOMETRY", "VECTORS", "MATRICES", "MATRIX",
    "DETERMINANTS", "PROBABILITY", "PERMUTATION", "COMBINATION", "COMPLEX",
    "QUADRATIC", "BINOMIAL", "SEQUENCE", "SERIES", "PROGRESSION", "AP", "GP",
    "CONIC", "CIRCLE", "PARABOLA", "ELLIPSE", "HYPERBOLA", "STRAIGHT", "LINE",
    "FUNCTION", "FUNCTIONS", "INVERSE", "LOGARITHM",
    // Exam tokens
    "JEE", "MAIN", "ADVANCED", "PYQ", "MOCK", "NCERT",
  ]),
  NEET: new Set([
    // Physics (NEET subset)
    "PHYSICS", "MECHANICS", "KINEMATICS", "DYNAMICS", "GRAVITATION",
    "THERMODYNAMICS", "THERMAL", "HEAT", "WAVES", "OPTICS", "OPTICAL",
    "ELECTRICITY", "MAGNETISM", "CURRENT", "CIRCUIT", "MODERN", "ATOMIC",
    "NUCLEAR", "FORCE", "ENERGY", "MOMENTUM", "WORK",
    // Chemistry
    "CHEMISTRY", "CHEM", "PHYSICAL", "ORGANIC", "INORGANIC", "MOLE", "ATOM",
    "STRUCTURE", "BONDING", "EQUILIBRIUM", "KINETICS", "ELECTROCHEMISTRY",
    "SOLUTIONS", "GAS", "PERIODIC", "ELEMENTS", "REACTION", "ACID", "BASE",
    "ALKANE", "ALKENE", "ALCOHOL", "AMINE", "BIOMOLECULES", "POLYMER",
    // Biology (the heart of NEET)
    "BIOLOGY", "BIO", "BOTANY", "ZOOLOGY", "CELL", "CELLS", "TISSUE", "TISSUES",
    "PLANT", "PLANTS", "ANIMAL", "ANIMALS", "HUMAN", "ANATOMY", "PHYSIOLOGY",
    "MORPHOLOGY", "TAXONOMY", "ECOLOGY", "ECOSYSTEM", "BIODIVERSITY",
    "GENETICS", "EVOLUTION", "REPRODUCTION", "REPRODUCTIVE",
    "PHOTOSYNTHESIS", "RESPIRATION", "RESPIRATORY", "TRANSPORT", "CIRCULATORY",
    "DIGESTION", "DIGESTIVE", "EXCRETION", "EXCRETORY", "NERVOUS", "NEURON",
    "ENDOCRINE", "HORMONE", "HORMONES", "MUSCLE", "MUSCULAR", "SKELETON", "SKELETAL",
    "MICROBE", "MICROBES", "MICROBIOLOGY", "BACTERIA", "VIRUS", "VIRUSES", "FUNGI",
    "DNA", "RNA", "PROTEIN", "ENZYME", "ENZYMES", "BIOTECH", "BIOTECHNOLOGY",
    "DISEASE", "DISEASES", "IMMUNE", "IMMUNITY", "HEALTH", "MENDEL", "CHROMOSOME",
    "GENE", "GENES", "MITOSIS", "MEIOSIS", "BIOMOLECULES",
    // Body systems + anatomy (added 2026-05-14 after "blood group" bug)
    "BLOOD", "GROUP", "GROUPS", "BLOODGROUP", "BLOODGROUPS",
    "ABO", "RH", "RHESUS", "PLASMA", "SERUM", "RBC", "RBCS", "WBC", "WBCS",
    "HEMOGLOBIN", "HAEMOGLOBIN", "PLATELET", "PLATELETS", "CLOTTING",
    "ANTIBODY", "ANTIBODIES", "ANTIGEN", "ANTIGENS", "VACCINE", "VACCINES",
    "LYMPH", "LYMPHATIC", "LYMPHOCYTE", "LYMPHOCYTES",
    "HEART", "CARDIAC", "CARDIOVASCULAR", "ARTERY", "ARTERIES", "VEIN", "VEINS",
    "KIDNEY", "KIDNEYS", "RENAL", "NEPHRON", "NEPHRONS", "URINE", "URINARY",
    "LIVER", "HEPATIC", "BILE",
    "LUNG", "LUNGS", "PULMONARY", "ALVEOLI", "BRONCHI",
    "BRAIN", "CEREBRUM", "CEREBELLUM", "MEDULLA", "SPINAL", "CORD",
    "NEURON", "NEURONS", "SYNAPSE", "SYNAPSES", "REFLEX", "REFLEXES",
    "BONE", "BONES", "JOINT", "JOINTS", "CARTILAGE", "LIGAMENT", "TENDON",
    "SKIN", "EPIDERMIS", "DERMIS",
    "EYE", "EYES", "RETINA", "CORNEA", "LENS", "IRIS",
    "EAR", "EARS", "COCHLEA", "EARDRUM",
    "NOSE", "TONGUE", "TASTE", "SMELL",
    "ORGAN", "ORGANS", "SYSTEM", "SYSTEMS", "ORGANELLE", "ORGANELLES",
    "GLAND", "GLANDS", "PITUITARY", "THYROID", "PANCREAS", "ADRENAL", "OVARY", "OVARIES", "TESTIS", "TESTES",
    "STOMACH", "INTESTINE", "INTESTINES", "COLON", "RECTUM", "DUODENUM",
    "PHARYNX", "LARYNX", "TRACHEA", "ESOPHAGUS",
    "MITOCHONDRIA", "MITOCHONDRION", "RIBOSOME", "RIBOSOMES", "NUCLEUS", "MEMBRANE",
    "CHLOROPLAST", "CHLOROPLASTS", "VACUOLE", "VACUOLES", "CYTOPLASM",
    "CHLOROPHYLL", "STOMATA", "XYLEM", "PHLOEM", "ROOT", "ROOTS", "STEM", "LEAF", "LEAVES",
    "FLOWER", "FLOWERS", "FRUIT", "FRUITS", "SEED", "SEEDS", "POLLEN", "POLLINATION",
    "ALGAE", "BRYOPHYTE", "PTERIDOPHYTE", "GYMNOSPERM", "ANGIOSPERM", "ANGIOSPERMS",
    "CARBOHYDRATE", "CARBOHYDRATES", "LIPID", "LIPIDS", "AMINO", "ACID", "ACIDS",
    "ATP", "ADP", "GLUCOSE", "STARCH", "CELLULOSE",
    "MENSTRUAL", "OVULATION", "FERTILIZATION", "FERTILISATION", "EMBRYO", "FETUS", "FOETUS",
    "PREGNANCY", "GAMETE", "GAMETES", "ZYGOTE", "SPERM", "OVUM",
    "BLOODPRESSURE", "BP", "PULSE", "ECG",
    // Exam tokens
    "NEET", "AIIMS", "MEDICAL", "MBBS", "NCERT",
  ]),
  UPSC: new Set([
    // General Studies — Polity
    "POLITY", "CONSTITUTION", "GOVERNANCE", "PARLIAMENT", "JUDICIARY", "EXECUTIVE",
    "LEGISLATURE", "RIGHTS", "FUNDAMENTAL", "DIRECTIVE", "PRINCIPLES", "DUTIES",
    "PRESIDENT", "PRIME", "MINISTER", "CABINET", "GOVERNOR", "CHIEF",
    "ELECTION", "ELECTIONS", "COMMISSION", "AMENDMENT", "AMENDMENTS",
    // Economy
    "ECONOMY", "ECONOMIC", "ECONOMICS", "GDP", "INFLATION", "BANKING", "MONETARY",
    "FISCAL", "BUDGET", "TAX", "TAXATION", "GST", "TRADE", "INDUSTRY", "AGRICULTURE",
    "EMPLOYMENT", "UNEMPLOYMENT", "POVERTY", "INDIA", "INDIAN",
    // History
    "HISTORY", "ANCIENT", "MEDIEVAL", "MODERN", "FREEDOM", "STRUGGLE", "MOVEMENT",
    "MAURYAN", "GUPTA", "MUGHAL", "BRITISH", "COLONIAL", "INDEPENDENCE",
    "REVOLT", "REVOLUTION", "CONGRESS", "GANDHI", "NEHRU",
    // Geography
    "GEOGRAPHY", "PHYSICAL", "HUMAN", "WORLD", "RIVER", "RIVERS", "MOUNTAIN",
    "MOUNTAINS", "MONSOON", "CLIMATE", "SOIL", "MINERAL", "MINERALS", "POPULATION",
    "URBAN", "RURAL",
    // Environment + Ecology
    "ENVIRONMENT", "ENVIRONMENTAL", "ECOLOGY", "ECOSYSTEM", "BIODIVERSITY",
    "WILDLIFE", "FOREST", "CLIMATE", "POLLUTION", "CONSERVATION", "SUSTAINABLE",
    // Science & Tech
    "SCIENCE", "TECHNOLOGY", "SPACE", "ISRO", "DEFENCE", "NUCLEAR", "BIOTECH",
    "DIGITAL", "INTERNET", "CYBER", "AI",
    // Current Affairs / International
    "CURRENT", "AFFAIRS", "INTERNATIONAL", "RELATIONS", "DIPLOMACY", "UN",
    "BRICS", "G20", "SAARC", "ASEAN",
    // Ethics / Essay
    "ETHICS", "INTEGRITY", "APTITUDE", "VALUES",
    // CSAT
    "CSAT", "REASONING", "COMPREHENSION", "QUANT",
    // Exam tokens
    "UPSC", "IAS", "IPS", "CSE", "PRELIMS", "MAINS", "NCERT", "PYQ", "MOCK",
  ]),
  GMAT: new Set([
    "GMAT", "QUANT", "QUANTITATIVE", "VERBAL", "ENGLISH", "READING", "COMPREHENSION",
    "DATA", "INSIGHTS", "INTEGRATED", "LOGICAL", "REASONING",
    "ARITHMETIC", "ALGEBRA", "GEOMETRY", "STATISTICS", "PROBABILITY",
    "PROFIT", "LOSS", "PERCENTAGE", "RATIO", "AVERAGE",
    "SENTENCE", "CORRECTION", "PARAJUMBLES", "GRAMMAR", "VOCAB", "CRITICAL",
  ]),
  GRE: new Set([
    "GRE", "QUANT", "QUANTITATIVE", "VERBAL", "READING", "COMPREHENSION",
    "ANALYTICAL", "WRITING", "VOCAB", "VOCABULARY", "SYNONYM", "ANTONYM",
    "GRAMMAR", "ARITHMETIC", "ALGEBRA", "GEOMETRY", "STATISTICS", "PROBABILITY",
    "TEXT", "COMPLETION", "EQUIVALENCE", "ARGUMENT", "ESSAY",
  ]),
  GATE: new Set([
    "GATE", "ENGINEERING", "MATHEMATICS", "MATH", "MATHS", "APTITUDE",
    "COMPUTER", "SCIENCE", "CS", "CSE", "EC", "ECE", "EE", "ELECTRICAL",
    "ELECTRONICS", "MECHANICAL", "ME", "CIVIL", "CE", "CHEMICAL",
    "PROGRAMMING", "ALGORITHM", "ALGORITHMS", "DATA", "STRUCTURES", "DBMS",
    "OPERATING", "SYSTEM", "SYSTEMS", "OS", "NETWORK", "NETWORKS", "NETWORKING",
    "DIGITAL", "ANALOG", "MICROPROCESSOR", "VLSI", "SIGNALS", "CONTROL",
    "POWER", "MACHINE", "MACHINES", "THERMODYNAMICS", "FLUID", "STRENGTH",
    "MATERIALS", "LINEAR", "ALGEBRA", "CALCULUS", "PROBABILITY", "DISCRETE",
  ]),
  CLAT: new Set([
    "CLAT", "LEGAL", "LAW", "REASONING", "ENGLISH", "GENERAL", "KNOWLEDGE",
    "CURRENT", "AFFAIRS", "LOGICAL", "QUANTITATIVE", "QUANT", "MATHEMATICS",
    "CONSTITUTION", "CONTRACT", "TORT", "CRIME", "CRIMINAL", "FUNDAMENTAL",
    "RIGHTS", "JUDICIARY", "JURISPRUDENCE",
  ]),
  BITSAT: new Set([
    "BITSAT", "PHYSICS", "CHEMISTRY", "MATH", "MATHS", "MATHEMATICS", "BIOLOGY",
    "ENGLISH", "PROFICIENCY", "LOGICAL", "REASONING",
    // Same subject keywords as JEE/NEET subsets — keep concise
    "MECHANICS", "OPTICS", "THERMODYNAMICS", "ELECTROSTATICS",
    "ALGEBRA", "CALCULUS", "TRIGONOMETRY", "ORGANIC", "INORGANIC",
  ]),
  SAT: new Set([
    "SAT", "READING", "WRITING", "MATH", "MATHS", "ALGEBRA", "GEOMETRY",
    "STATISTICS", "FUNCTIONS", "GRAMMAR", "VOCAB", "ESSAY", "COMPREHENSION",
  ]),
  NDA: new Set([
    "NDA", "MATHEMATICS", "MATH", "MATHS", "GENERAL", "ABILITY", "ENGLISH",
    "KNOWLEDGE", "PHYSICS", "CHEMISTRY", "BIOLOGY", "HISTORY", "GEOGRAPHY",
    "CIVICS", "POLITY", "DEFENCE", "CURRENT", "AFFAIRS",
    "ALGEBRA", "CALCULUS", "TRIGONOMETRY", "STATISTICS", "PROBABILITY", "VECTOR",
  ]),
  CUET: new Set([
    "CUET", "LANGUAGE", "ENGLISH", "DOMAIN", "GENERAL", "TEST",
    "MATHEMATICS", "MATH", "MATHS", "PHYSICS", "CHEMISTRY", "BIOLOGY",
    "HISTORY", "GEOGRAPHY", "ECONOMICS", "POLITICAL", "POLITY", "BUSINESS",
    "ACCOUNTANCY", "COMMERCE", "PSYCHOLOGY", "SOCIOLOGY", "PHILOSOPHY",
  ]),
  IELTS: new Set([
    "IELTS", "LISTENING", "READING", "WRITING", "SPEAKING", "ENGLISH",
    "GRAMMAR", "VOCABULARY", "ESSAY", "ACADEMIC", "GENERAL",
  ]),
  TOEFL: new Set([
    "TOEFL", "READING", "LISTENING", "SPEAKING", "WRITING", "ENGLISH",
    "GRAMMAR", "VOCABULARY", "ESSAY", "ACADEMIC",
  ]),
};

/**
 * Decide whether `topic` plausibly fits inside the syllabus of `exam`.
 * Whole-word match against the per-exam keyword set. Returns:
 *   - true  → at least one token of the topic is a known syllabus subject
 *   - false → topic appears to be off-syllabus (UI should warn)
 *   - true  → if we don't have keyword data for this exam (no warning fired)
 *
 * Defensive default: when in doubt, return true (don't warn). False
 * positives in the warning are worse than false negatives — a wrong
 * "this isn't on the exam" message is annoying and undermines trust.
 */
export function topicMatchesExam(
  topic: string | null | undefined,
  exam: ExamMeta | null | undefined,
): boolean {
  if (!exam || !topic) return true;
  const examKey = exam.name.split(/\s/)[0].toUpperCase();
  const keywords = EXAM_SUBJECT_KEYWORDS[examKey];
  if (!keywords) return true; // no keyword data → no warning
  // Whole-word + concatenated forms, same splitter as detectExamFromTopic.
  const parts = topic.toUpperCase().split(/[\s,;.\-/_()]+/).filter(Boolean);
  for (const p of parts) {
    if (keywords.has(p)) return true;
  }
  // Also check pairwise concats for multi-word terms (e.g. "BLOOD RELATION").
  for (let i = 0; i + 1 < parts.length; i++) {
    if (keywords.has(parts[i] + parts[i + 1])) return true;
  }
  return false;
}

/**
 * When the topic doesn't match the current exam, try to guess which exam
 * it WOULD fit (so the UI can offer a "did you mean to switch your goal?"
 * suggestion). Returns the ExamMeta if a different exam claims the topic,
 * otherwise null.
 */
export function suggestExamForTopic(
  topic: string | null | undefined,
  currentExam: ExamMeta | null | undefined,
): ExamMeta | null {
  if (!topic) return null;
  const parts = topic.toUpperCase().split(/[\s,;.\-/_()]+/).filter(Boolean);
  const currentKey = currentExam ? currentExam.name.split(/\s/)[0].toUpperCase() : "";
  for (const [examKey, keywords] of Object.entries(EXAM_SUBJECT_KEYWORDS)) {
    if (examKey === currentKey) continue;
    for (const p of parts) {
      if (keywords.has(p)) {
        const meta = EXAM_DETECTORS[examKey];
        if (meta) return meta;
      }
    }
  }
  return null;
}
