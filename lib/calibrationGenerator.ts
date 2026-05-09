/**
 * lib/calibrationGenerator.ts
 *
 * Generates a 12-question Bloom-taxonomy-tagged calibration quiz tailored
 * to the student's exam goal. Used by /api/student/calibration/start to
 * produce the first-run experience that powers the BloomIQ Score and
 * Future You reveal.
 *
 * WHY 12 QUESTIONS:
 *   Long enough to span all six Bloom levels with at least one signal per
 *   level (and two on the workhorse mid-range levels). Short enough to
 *   honour our "7-minute first-run promise". Beyond 12, drop-off climbs
 *   sharply in our user-research from comparable products.
 *
 * THE BLOOM MIX (frozen for v1):
 *   Remember   2
 *   Understand 2
 *   Apply      3
 *   Analyze    2
 *   Evaluate   2
 *   Create     1
 *   = 12 total
 *
 *   Apply gets the extra slot because it's the most discriminating level
 *   between "knows definitions" students and "can use them" students,
 *   which is the single biggest predictor of competitive-exam success in
 *   our internal data. Create gets only one because it's expensive to
 *   author auto-gradeable Create questions and one well-chosen Create
 *   question already separates the top decile.
 *
 * WHY GROQ EVERY TIME (instead of a hardcoded seed bank):
 *   If the calibration is hardcoded, every student sees the same 12
 *   questions on first sign-in. They share screenshots, the calibration
 *   becomes gameable, and the personalisation promise dies in week one.
 *   Groq generates fresh, exam-goal-tailored questions per session at
 *   ~₹0.02 per calibration — well within unit economics for a Free user
 *   we want to convert.
 */

import { groqJSON, GROQ_MODEL } from "@/lib/groq";

import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";
export { BLOOM_LEVELS, type BloomLevel };

/**
 * The target distribution of Bloom levels in the 12-question calibration.
 * Re-ordering here changes what comes out of Groq — the prompt explicitly
 * enforces the count per level.
 */
export const BLOOM_MIX: Record<BloomLevel, number> = {
  remember: 2,
  understand: 2,
  apply: 3,
  analyze: 2,
  evaluate: 2,
  create: 1,
};

export type CalibrationQuestion = {
  index: number; // 0..11
  stem: string;
  options: [string, string, string, string]; // exactly 4 MCQ options
  correct_index: 0 | 1 | 2 | 3;
  bloom_level: BloomLevel;
  topic: string; // free-form, exam-syllabus topic label
  benchmark_seconds: number; // how long a strong student should need
  explanation?: string; // shown post-answer, optional
};

export type CalibrationGenerationResult = {
  questions: CalibrationQuestion[];
  groq_model: string;
};

const SYSTEM_PROMPT = `You are an expert exam-prep assessment designer for BloomIQ, an Indian education platform. You write Bloom's Taxonomy-tagged multiple-choice calibration questions for students preparing for Indian competitive and board exams.

You MUST return strict JSON in the exact shape specified. No prose, no markdown, no commentary. The response is parsed by code; any deviation from the schema breaks the user experience.

BLOOM LEVELS (use exactly these lowercase strings):
- remember: factual recall (definitions, formulas, dates, names)
- understand: explain in own words, classify, summarize, paraphrase
- apply: use a concept/formula in a new but routine situation
- analyze: break a problem into parts, compare, identify patterns or causes
- evaluate: judge, critique, justify a decision, weigh trade-offs
- create: design, construct, devise something new

ABSOLUTE BANS — these will silently fail the calibration if violated:
- DO NOT ask meta-questions about the exam itself (full form, exam history, exam pattern, marking scheme, eligibility, attempt limits, exam dates, exam centres, application process, syllabus structure, conducting body, paper count, etc.).
- DO NOT ask about coaching institutes, study materials, books, authors, or test-prep companies.
- DO NOT ask about famous people, current affairs, GK, or trivia unrelated to the academic syllabus.
- DO NOT use the word "exam", "test", "paper", "syllabus", "section" in the question stem.
- The student is being measured on academic CONTENT KNOWLEDGE in the subjects the exam covers — nothing else.

QUALITY BAR:
- Every question must test ACADEMIC SUBJECT CONTENT from the named exam's curriculum (e.g. Physics/Chemistry/Biology for NEET; Physics/Chemistry/Math for JEE; Quant/Verbal/DI/Logic for CAT; History/Polity/Geography/Economy/Science for UPSC; subject content for Boards). The question is indistinguishable from a real syllabus question a teacher would ask in class.
- The correct option must be unambiguously correct; the three distractors must be plausible (common misconceptions, near-misses, or partial truths in the same subject).
- Apply / Analyze / Evaluate / Create questions MUST require thinking beyond memorisation. If a Remember question would suffice, it does not belong in a higher Bloom slot.
- Topics span the breadth of the named exam's subjects — not all from one chapter, not all from one subject if the exam has multiple.
- benchmark_seconds: realistic seconds a strong student needs (not a sluggish average). Typical ranges: remember 30, understand 45, apply 60, analyze 75, evaluate 75, create 90.

EXAMPLES OF BAD QUESTIONS (do NOT generate these):
- "What is the full form of NEET?"
- "How many sections does the JEE Main paper have?"
- "Who conducts the CAT exam?"
- "Which year was UPSC established?"

EXAMPLES OF GOOD QUESTIONS (this is the bar):
- NEET: "A photon of wavelength 500 nm is incident on a metal of work function 2.0 eV. Calculate the maximum kinetic energy of the emitted photoelectron." (Apply, Physics)
- JEE: "If f(x) = x³ − 3x + 2, the number of real roots of f(x) = 0 is..." (Analyze, Math)
- CAT: "If a + b = 10 and ab = 21, find the value of a³ + b³." (Apply, Quantitative Aptitude)
- UPSC: "Which Article of the Indian Constitution provides for the Union Public Service Commission?" (Remember, Polity)
- Boards: "Balance the chemical equation: Fe + H₂O → Fe₃O₄ + H₂" (Apply, Chemistry)`;

/**
 * Per-exam difficulty + subject profile. The Groq prompt is dynamically
 * tuned to whichever exam the student picked at goal-picker time. Without
 * this layer, "CAT prep" and "Class 10 boards" got the same generic prompt
 * — which produced grade-6 questions for CAT and ended up insulting the
 * user. Each profile briefs Groq with: who the candidate is, what the
 * difficulty bar is, what subjects must be covered, and concrete in-band
 * sample questions per Bloom level.
 *
 * Slugs match `profiles.exam_goal` values stored at goal-picker time.
 * Free-form goals fall through to the GENERIC profile.
 */
type ExamProfile = {
  /** Display name used in the prompt brief. */
  name: string;
  /** One-line describer that primes Groq on the candidate. */
  audience: string;
  /** Subjects the questions must span. Required: at least 4-6 distinct topics. */
  subjects: string[];
  /** What "calibration-grade" difficulty looks like for this exam. */
  difficulty: string;
  /** 3+ anchored sample questions across Bloom levels (calibration-grade). */
  samples: string;
};

const EXAM_PROFILES: Record<string, ExamProfile> = {
  cat_prep: {
    name: "CAT (Common Admission Test for IIM admission)",
    audience:
      "Indian undergraduate / fresh-graduate aspiring to top IIMs. CAT is the most selective MBA entrance in India — top 1-2 percent qualify for IIM-A/B/C. Candidates are post-Class-12 with strong quantitative and verbal foundations.",
    subjects: [
      "Quantitative Aptitude (Arithmetic — percentages, profit/loss, ratio, time-speed-distance, time-work, mixtures; Algebra — linear, quadratic, inequalities, progressions, functions; Geometry & Mensuration; Modern Math — permutations, combinations, probability, set theory, logarithms)",
      "Verbal Ability & Reading Comprehension (RC inference, main-idea, tone; para-jumbles; para-completion; para-summary; critical reasoning — strengthen/weaken/assumption)",
      "Data Interpretation (table-based, bar/line/pie charts, caselets, multi-source data sets)",
      "Logical Reasoning (arrangements — linear/circular; ranking; blood relations; binary logic; cubes; syllogisms; sequences)",
    ],
    difficulty:
      "GRADUATE-LEVEL. CAT questions are time-pressured (avg ~2 min/question), often multi-step, with deliberately tempting wrong options. A Class-12 student should NOT find these easy. AVOID single-fact recall like \"what is the formula for compound interest\" — instead set up a word problem that USES the formula. Anchor difficulty at the level of past CAT papers, not at the level of school textbook exercises.",
    samples: `- Remember (QA, ~30s): "What is the formula for the sum of an infinite geometric progression with first term a and common ratio r where |r|<1?"
- Understand (VARC): Provide a 4-line passage, ask which option best captures the author's primary inference. Distractors must include partial-truth and over-broad summaries.
- Apply (QA, ~90s): "A trader sells two articles, one at 20% profit and the other at 20% loss. If the cost price of the first is twice the second, what is his overall percentage profit or loss?"
- Apply (DI, ~75s): Pose a small bar-chart caselet (3 categories × 4 years), ask for a derived ratio.
- Analyze (LR, ~120s): Set a 5-person seating-arrangement puzzle with 4 clues, ask who sits at position 3.
- Evaluate (VARC): Two short arguments; ask which weakens the second argument the most.
- Create: "Construct a 4-step word problem whose answer is exactly 240, using profit-loss and ratio together." (a real CAT-style design question)`,
  },
  jee_prep: {
    name: "JEE Main (Engineering entrance for IITs/NITs)",
    audience:
      "Class 11-12 Science student aspiring to IITs (JEE Advanced) or NITs (JEE Main). Strong PCM foundation expected. Top 2.5 lakh of ~12 lakh candidates qualify for Advanced.",
    subjects: [
      "Physics (Mechanics, Thermodynamics, Electromagnetism, Optics, Modern Physics, Waves & SHM)",
      "Chemistry (Physical — mole concept, equilibrium, electrochemistry, kinetics, thermodynamics; Organic — GOC, hydrocarbons, oxygen-containing groups, biomolecules; Inorganic — periodic table, chemical bonding, coordination compounds, p/d-block)",
      "Mathematics (Algebra — complex numbers, quadratic, sequences; Calculus — limits, continuity, differentiability, integration; Coordinate Geometry; Trigonometry; Vectors & 3D; Probability)",
    ],
    difficulty:
      "CLASS-12-COMPETITIVE. Multi-concept, often combining 2 chapters in one problem. Calculation-heavy. Distractors include common sign errors and unit slips. Anchor at past JEE Main papers — NOT at NCERT examples (those are too easy).",
    samples: `- Remember (Phys, ~30s): "What is the dimensional formula of magnetic flux?"
- Apply (Chem, ~75s): "0.1 M acetic acid (Ka = 1.8 × 10⁻⁵) is mixed with equal volume of 0.1 M sodium acetate. What is the pH of the resulting buffer?"
- Apply (Math, ~75s): "If f(x) = ∫₀ˣ (t² + 2t) dt, find f'(2)."
- Analyze (Phys, ~120s): A 2-block pulley problem with friction on one surface — set up equations, solve for acceleration.
- Evaluate (Chem): "Among four given reactions, which one violates the second law of thermodynamics? Justify."
- Create (Math): "Construct a quadratic with rational coefficients whose roots are 2 + √3 and 2 − √3."`,
  },
  neet_prep: {
    name: "NEET (Medical entrance for MBBS/BDS)",
    audience:
      "Class 11-12 Biology-stream student aspiring to MBBS/BDS at AIIMS, JIPMER, or top state-government medical colleges. Strong PCB foundation expected.",
    subjects: [
      "Biology (Class 11 — Diversity of life, Cell biology, Plant Physiology, Human Physiology; Class 12 — Reproduction, Genetics & Evolution, Biotechnology, Ecology). Biology = ~50% weight.",
      "Physics (Mechanics, Thermodynamics, Optics, Modern Physics, Electromagnetism — applied to medical/biological contexts where possible)",
      "Chemistry (Physical, Organic — esp. biomolecules and chemistry-in-everyday-life; Inorganic)",
    ],
    difficulty:
      "CLASS-12-NCERT-DRIVEN. NEET hews closely to NCERT textbooks but adds twist: assertion-reason, statement-correctness, multi-step physiology. Avoid pure recall — anchor at past NEET papers.",
    samples: `- Remember (Bio, ~30s): "Which enzyme is responsible for the unwinding of DNA during replication?"
- Apply (Phys, ~60s): "A photon of wavelength 500 nm is incident on a metal of work function 2.0 eV. Calculate the maximum kinetic energy of the emitted photoelectron in eV."
- Apply (Chem, ~75s): "Identify the major product when propan-1-ol is treated with concentrated sulphuric acid at 170 °C."
- Analyze (Bio, ~75s): "A child shows symptoms of haemophilia A. Trace the most likely inheritance pattern across three generations and identify which grandparent was the carrier."
- Evaluate (Bio): "Compare the efficacy of mRNA vs. inactivated-virus vaccines for a fast-mutating respiratory virus. Which is preferable and why?"
- Create (Bio): "Design a simple experiment to demonstrate the rate of photosynthesis varies with light intensity. State the hypothesis, controls, and dependent variable."`,
  },
  upsc_prep: {
    name: "UPSC Civil Services Preliminary (CSAT — Indian civil-service entrance)",
    audience:
      "Indian graduate aspiring to IAS/IFS/IPS. UPSC Prelims Paper-1 GS is the most competitive Indian government exam — ~1 percent qualify for Mains. Candidates are graduates with broad humanities + current-affairs awareness.",
    subjects: [
      "Indian Polity & Governance (Constitution, Articles, Schedules, Amendments, Parliament, Judiciary, Federal Structure, Local Govt, Rights, DPSP)",
      "Indian History (Ancient, Medieval, Modern — esp. Freedom Struggle 1857-1947)",
      "Geography (Indian Physical Geography, World Physical, Climate, Resources, Human Geography)",
      "Economy (Banking, Fiscal & Monetary Policy, Budget, GST, Inflation, Indian Economic Survey themes)",
      "General Science (Class-10-level Physics/Chem/Bio with applied focus — health, technology, environment)",
      "Environment & Ecology (Climate change, biodiversity, conservation laws — IUCN, RAMSAR, CITES)",
    ],
    difficulty:
      "GRADUATE-LEVEL. UPSC Prelims tests breadth + precision. Statement-based questions ('which of the following statements are correct') are common. Distractors are partial truths. Avoid pure trivia — anchor at past UPSC Prelims papers.",
    samples: `- Remember (Polity, ~30s): "Which Schedule of the Indian Constitution lists the languages recognised by the Union?"
- Understand (History, ~45s): "Which of the following statements about the Lucknow Pact (1916) are correct? 1. It united Congress and Muslim League. 2. It accepted separate electorates. 3. It was signed in the presence of Bal Gangadhar Tilak. (a) 1 only (b) 1 and 2 (c) 2 and 3 (d) 1, 2, and 3"
- Apply (Geo, ~60s): "If a country lies between 10°N and 30°N latitudes, which two climate types is it most likely to experience? Explain briefly."
- Analyze (Econ, ~90s): "Identify the most likely impact on the Indian rupee if the RBI raises the repo rate by 50 bps while the US Fed holds rates steady."
- Evaluate (Env): "Critically evaluate whether the Forest (Conservation) Amendment Act, 2023 strengthens or weakens India's forest protection regime."
- Create (Polity): "Frame a one-line constitutional amendment proposal to address the issue of horse-trading by elected legislators."`,
  },
  class_5_8: {
    name: "Class 5–8 (Primary + Middle School, NCERT)",
    audience:
      "Indian school student aged 10–13 in Classes 5 to 8. NCERT is the primary syllabus. The buyer of any subscription is typically the parent.",
    subjects: [
      "Mathematics (Numbers, Fractions, Decimals, Ratio & Proportion, Basic Algebra, Geometry, Mensuration, Data Handling)",
      "Science (Living World — plants/animals/body systems; Matter — physical/chemical changes; Energy — light/sound/heat; Earth — air/water/weather)",
      "English (Reading comprehension, vocabulary, grammar — tenses/parts of speech, sentence structure, basic writing)",
      "Social Studies (Geography — Indian states/maps; History — Indian Independence movement basics; Civics — Constitution at primary level; EVS for Class 5)",
      "Hindi or regional language (basic comprehension, vocabulary)",
    ],
    difficulty:
      "AGE-APPROPRIATE NCERT (Classes 5–8). DO NOT use Class 9-or-above content. Question stems should be short and use everyday situations a 10–13 year old recognises (apples, marbles, school day, family). AVOID heavy abstraction, derivations, or competitive-exam tricks. Anchor at the difficulty of NCERT exercises and Olympiad Level 1 (preliminary).",
    samples: `- Remember (Sci, ~30s): "Which gas do plants release during photosynthesis?"
- Understand (Math, ~45s): "Which of these fractions is the largest: 1/2, 1/3, 2/5, 3/8?"
- Apply (Math, ~60s): "A water tank holds 240 litres. If 1/3 is used in the morning and 1/4 in the afternoon, how many litres are left?"
- Analyze (Sci, ~75s): "A plant kept in the dark for a week shows yellowing leaves. What is the most likely reason?"
- Evaluate (English): "Read the short passage. Which statement best summarises the author's main idea?"
- Create (Math): "Write a story problem that uses subtraction and gives an answer of 47."`,
  },

  class_9: {
    name: "Class 9 (Foundation for Boards)",
    audience:
      "Indian Class 9 student (14–15 years) building the foundation for Class 10 boards. NCERT-aligned but expected to be more rigorous than Class 8.",
    subjects: [
      "Mathematics (Number Systems, Polynomials, Coordinate Geometry, Linear Equations in Two Variables, Triangles, Quadrilaterals, Circles, Surface Areas & Volumes, Statistics)",
      "Science — Physics (Motion, Force & Laws of Motion, Gravitation, Work-Energy-Power, Sound)",
      "Science — Chemistry (Matter in Our Surroundings, Atoms & Molecules, Structure of the Atom)",
      "Science — Biology (The Fundamental Unit of Life — Cells; Tissues; Diversity in Living Organisms)",
      "Social Studies (History — French Revolution, Russian Revolution, Nazism; Geography — India: Size and Location, Physical Features; Civics — Democracy in the Contemporary World)",
      "English (RC, grammar at Class 9 level, writing skills)",
    ],
    difficulty:
      "CLASS-9-NCERT-LEVEL. Notably tougher than Class 5–8 (introduces algebraic manipulation, atomic theory, formal proofs). Easier than Class 10 boards. Anchor at NCERT exercises and CBSE Class 9 sample papers.",
    samples: `- Remember (Sci, ~30s): "What is the SI unit of force?"
- Apply (Math, ~75s): "Find the value of x if 3(x − 2) = 2(x + 4)."
- Apply (Sci, ~75s): "A car accelerates uniformly from 0 to 20 m/s in 5 seconds. Calculate its acceleration."
- Analyze (Bio, ~75s): "Compare plant cells and animal cells. List two key structural differences and explain their functional significance."
- Evaluate (SST): "Did the French Revolution succeed in achieving its declared goals of liberty and equality? Justify with two reasons."
- Create (Math): "Construct a polynomial whose zeros are 2 and −3. Verify."`,
  },

  class10_boards: {
    name: "Class 10 Board Exams (CBSE / ICSE / state boards)",
    audience:
      "Indian Class 10 student (15-16 years old) preparing for the Class 10 board exam. NCERT is the primary syllabus.",
    subjects: [
      "Mathematics (Real Numbers, Polynomials, Linear Equations, Quadratic Equations, Arithmetic Progressions, Triangles, Coordinate Geometry, Trigonometry, Statistics & Probability)",
      "Science — Physics (Light & Reflection, Electricity, Magnetism, Sources of Energy)",
      "Science — Chemistry (Chemical Reactions, Acids/Bases/Salts, Metals & Non-metals, Carbon Compounds, Periodic Classification)",
      "Science — Biology (Life Processes, Control & Coordination, Reproduction, Heredity & Evolution, Our Environment)",
      "Social Studies (History — Nationalism in India and Europe; Geography — Resources, Agriculture; Civics — Power Sharing, Democracy)",
      "English (Grammar, RC, Writing skills)",
    ],
    difficulty:
      "CLASS-10-NCERT-LEVEL. Stay within NCERT. Avoid Class-12 / competitive-exam content. Anchor at past CBSE Class 10 board papers.",
    samples: `- Remember (Sci, ~30s): "What is the chemical formula of slaked lime?"
- Apply (Math, ~60s): "Solve for x: 2x² − 7x + 3 = 0 using the quadratic formula."
- Apply (Sci, ~60s): "A resistor of 10 Ω is connected to a 6V battery. Calculate the current through it and the power dissipated."
- Analyze (SST, ~75s): "Why did the Non-Cooperation Movement lose momentum after the Chauri Chaura incident?"
- Evaluate (Sci): "Compare aerobic and anaerobic respiration in terms of energy yield and end products. Which is more efficient and why?"
- Create (Math): "Construct a word problem involving an arithmetic progression where the 7th term is 25 and the common difference is 4."`,
  },
  class12_boards: {
    name: "Class 12 Board Exams (CBSE / ICSE / state boards)",
    audience:
      "Indian Class 12 student (17-18 years old) preparing for the Class 12 board exam. NCERT is the primary syllabus, but board-paper-grade depth is expected.",
    subjects: [
      "Mathematics (Relations & Functions, Inverse Trig, Matrices, Determinants, Continuity & Differentiability, Application of Derivatives, Integrals, Differential Equations, Vectors, 3D Geometry, Linear Programming, Probability)",
      "Physics (Electrostatics, Current Electricity, Magnetism, EMI, AC, EM Waves, Optics, Dual Nature of Matter, Atoms, Nuclei, Semiconductors)",
      "Chemistry (Solid State, Solutions, Electrochemistry, Kinetics, Surface Chemistry; Organic — Haloalkanes, Alcohols, Aldehydes, Carboxylic acids, Amines, Biomolecules; Inorganic — p/d/f-block, Coordination Compounds)",
      "Biology (if PCB stream — Reproduction, Genetics, Evolution, Biotechnology, Ecology)",
    ],
    difficulty:
      "CLASS-12-NCERT-LEVEL with board-paper twists. Higher than Class 10, lower than JEE/NEET. Anchor at past CBSE Class 12 board papers.",
    samples: `- Remember (Phys): "What is the unit of magnetic flux in SI?"
- Apply (Math, ~75s): "Find the derivative of y = x^x at x = 1."
- Apply (Chem, ~75s): "Calculate the EMF of the cell Zn | Zn²⁺(0.1 M) || Cu²⁺(1 M) | Cu given E°cell = 1.10 V."
- Analyze (Phys, ~90s): "Two coherent sources S₁ and S₂ are 4 mm apart and screen is 1 m away. If the third bright fringe is at 1.5 mm, find the wavelength of light used."
- Evaluate (Bio): "Compare in-vitro fertilisation and gamete intrafallopian transfer. Which is preferred when male fertility is also compromised, and why?"`,
  },
  bank_exams: {
    name: "Bank Exams (IBPS PO / SBI PO / RBI Grade B etc.)",
    audience:
      "Indian graduate aspiring to public-sector banking. Tests Reasoning, Quantitative Aptitude, English, General Awareness — at graduate level.",
    subjects: [
      "Quantitative Aptitude (Arithmetic, Number Series, DI — bar/line/pie/caselet, Approximation, Simplification, Quadratic Equations)",
      "Reasoning (Puzzles — seating, scheduling; Coding-Decoding; Syllogisms; Inequalities; Direction Sense; Blood Relations; Input-Output)",
      "English (RC, Cloze test, Para-jumbles, Sentence Improvement, Error Detection, Vocab in context)",
      "General/Banking Awareness (RBI policy, banking acronyms, current schemes, financial markets — limited use; we focus on the first three subjects for calibration)",
    ],
    difficulty:
      "GRADUATE-LEVEL but speed-focused. ~30-40 sec/question average. Distractors are close numerical values to test precision under speed.",
    samples: `- Apply (QA, ~45s): "A sum becomes ₹6,250 in 2 years and ₹7,812.50 in 3 years at compound interest. Find the rate of interest."
- Analyze (Reasoning, ~90s): "8 friends sit around a circular table. A is opposite B. C is third to the right of A. D is between A and B. Where does C sit?"
- Apply (English, ~30s): A cloze passage with one blank requiring a discourse marker — pick the right option.`,
  },
  exploring: {
    name: "General academic preparation (no specific exam yet)",
    audience:
      "Indian higher-secondary student exploring options. Cover a balanced mix across Maths, Science (Physics/Chem/Bio), and English at Class-11-or-12 level.",
    subjects: [
      "Mathematics (Algebra, Calculus, Geometry, Probability)",
      "Physics (Mechanics, Electricity, Optics)",
      "Chemistry (Stoichiometry, Organic Reactions, Periodic Trends)",
      "Biology (Cells, Genetics, Physiology, Ecology)",
      "English (Reading Comprehension, Sentence Structure)",
    ],
    difficulty:
      "CLASS-11-or-12 level. Avoid grade-9-or-below content; avoid JEE-Advanced-or-CAT-graduate-level content.",
    samples: `- Remember (Bio): "What is the role of the enzyme RuBisCO?"
- Apply (Math): "Find the derivative of sin(2x) cos(3x)."
- Analyze (Chem): "Predict the major product when 1-bromopropane reacts with alcoholic KOH and explain the mechanism."`,
  },
};

const GENERIC_PROFILE: ExamProfile = EXAM_PROFILES.exploring;

/**
 * Resolves the user's exam_goal slug or free-form string to one of our
 * curated profiles. Slug-first lookup (fast), then keyword-fallback for
 * legacy free-form goals like "NEET 2026".
 */
function resolveProfile(examGoal: string): ExamProfile {
  const key = examGoal.toLowerCase().trim();
  // Direct slug match (matches what StudentGoalPicker stores).
  if (EXAM_PROFILES[key]) return EXAM_PROFILES[key];
  if (/cat\b/.test(key) || /mba|iim/.test(key)) return EXAM_PROFILES.cat_prep;
  if (/jee|iit|nit/.test(key)) return EXAM_PROFILES.jee_prep;
  if (/neet|aiims|mbbs|medical/.test(key)) return EXAM_PROFILES.neet_prep;
  if (/upsc|civil services|ias|ips/.test(key)) return EXAM_PROFILES.upsc_prep;
  // Younger grades — match before Class 10/12 because "class_5_8" string contains "10" or "12" inside it would mis-route.
  if (/class[\s_]*[5678]\b/.test(key) || /class[\s_]*5[\s_]*8/.test(key) || /primary|middle/.test(key)) return EXAM_PROFILES.class_5_8;
  if (/class[\s_]*9\b/.test(key)) return EXAM_PROFILES.class_9;
  if (/class[\s_]*10|10th|x board/.test(key)) return EXAM_PROFILES.class10_boards;
  if (/class[\s_]*12|12th|xii board|board/.test(key)) return EXAM_PROFILES.class12_boards;
  if (/bank|ibps|sbi|rbi/.test(key)) return EXAM_PROFILES.bank_exams;
  return GENERIC_PROFILE;
}

function buildUserPrompt(examGoal: string): string {
  const profile = resolveProfile(examGoal);
  const mixLines = (Object.entries(BLOOM_MIX) as Array<[BloomLevel, number]>)
    .map(([lvl, count]) => `  - ${lvl}: ${count}`)
    .join("\n");
  const subjectLines = profile.subjects.map((s, i) => `  ${i + 1}. ${s}`).join("\n");

  return `Generate 12 calibration questions for: ${profile.name}.

CANDIDATE PROFILE:
${profile.audience}

DIFFICULTY BAR (CRITICAL — calibration-grade, NOT introductory):
${profile.difficulty}

SUBJECTS THE QUESTIONS MUST SPAN (cover at least 4-6 distinct subjects from this list):
${subjectLines}

ANCHORED SAMPLE QUESTIONS (target this exact difficulty level):
${profile.samples}

REQUIRED BLOOM-LEVEL MIX (exact counts):
${mixLines}

Return JSON in this exact shape:

{
  "questions": [
    {
      "stem": "string — the question text, no leading numbering",
      "options": ["string","string","string","string"],
      "correct_index": 0,
      "bloom_level": "remember",
      "topic": "string — short syllabus-topic label",
      "benchmark_seconds": 60,
      "explanation": "string — one-sentence reason the answer is correct"
    }
  ]
}

Rules:
- Exactly 12 questions in the "questions" array.
- Bloom-level distribution must match the counts above exactly.
- Each "options" array has exactly 4 entries.
- "correct_index" is an integer 0-3.
- Order the questions roughly easiest-first (within the chosen difficulty band — easiest does NOT mean grade-school).
- Cover at least 4-6 different topics from the SUBJECTS list above. Don't cluster all questions in one subject.
- NO meta-questions about the exam, its structure, eligibility, dates, or conducting body.
- The "topic" field must name an academic subject area from the SUBJECTS list (e.g. "Quantitative Aptitude — Time-Speed-Distance", "Polity — Fundamental Rights"), NOT "exam pattern" or "general knowledge".
- DO NOT generate questions that are below the difficulty band of the candidate profile. Re-read the DIFFICULTY BAR before writing each question. If a Class-12 student would answer it in 5 seconds, it is too easy for graduate-level exams.`;
}

/**
 * Validates a single question object received from Groq. Returns a typed
 * CalibrationQuestion or throws.
 */
function validateQuestion(raw: unknown, index: number): CalibrationQuestion {
  if (!raw || typeof raw !== "object") throw new Error(`Q${index}: not an object`);
  const q = raw as Record<string, unknown>;

  const stem = q.stem;
  if (typeof stem !== "string" || stem.trim().length < 6) {
    throw new Error(`Q${index}: invalid stem`);
  }
  const options = q.options;
  if (
    !Array.isArray(options) ||
    options.length !== 4 ||
    !options.every((o) => typeof o === "string" && o.trim().length > 0)
  ) {
    throw new Error(`Q${index}: options must be 4 non-empty strings`);
  }
  const correct = q.correct_index;
  if (
    typeof correct !== "number" ||
    !Number.isInteger(correct) ||
    correct < 0 ||
    correct > 3
  ) {
    throw new Error(`Q${index}: correct_index must be 0..3`);
  }
  const bloom = q.bloom_level;
  if (typeof bloom !== "string" || !BLOOM_LEVELS.includes(bloom as BloomLevel)) {
    throw new Error(`Q${index}: invalid bloom_level "${String(bloom)}"`);
  }
  const topic = typeof q.topic === "string" ? q.topic : "";
  const benchmark =
    typeof q.benchmark_seconds === "number" && q.benchmark_seconds > 0
      ? Math.round(q.benchmark_seconds)
      : 60;
  const explanation = typeof q.explanation === "string" ? q.explanation : undefined;

  return {
    index,
    stem: stem.trim(),
    options: options as [string, string, string, string],
    correct_index: correct as 0 | 1 | 2 | 3,
    bloom_level: bloom as BloomLevel,
    topic: topic.trim(),
    benchmark_seconds: benchmark,
    explanation,
  };
}

/**
 * Validates the full Groq payload. Returns the 12 typed questions in
 * order, or throws describing the first violation found.
 */
function validatePayload(raw: unknown): CalibrationQuestion[] {
  if (!raw || typeof raw !== "object") throw new Error("payload not an object");
  const arr = (raw as { questions?: unknown }).questions;
  if (!Array.isArray(arr)) throw new Error("missing questions array");
  if (arr.length !== 12) throw new Error(`expected 12 questions, got ${arr.length}`);

  const questions = arr.map((q, i) => validateQuestion(q, i));

  // Bloom-mix check (forgiving by ±1 — Groq sometimes drifts by one slot
  // and a hard reject just to retry isn't worth the latency).
  const counts: Record<BloomLevel, number> = {
    remember: 0, understand: 0, apply: 0, analyze: 0, evaluate: 0, create: 0,
  };
  questions.forEach((q) => { counts[q.bloom_level] += 1; });
  for (const lvl of BLOOM_LEVELS) {
    const target = BLOOM_MIX[lvl];
    const got = counts[lvl];
    if (Math.abs(got - target) > 1) {
      throw new Error(`bloom mix off: ${lvl} target=${target} got=${got}`);
    }
  }

  return questions;
}

/**
 * Generates 12 calibration questions for the given exam goal.
 *
 * Retries once on malformed output (Groq output drifts occasionally with
 * temperature > 0). If the second attempt also fails, throws — the API
 * route catches and returns 502 to the client with a "try again" CTA.
 *
 * @param examGoal — free-form like "NEET 2026", "JEE Main 2026", "Class
 *   10 CBSE Boards 2026", "CUET English Honours". If null/empty we fall
 *   back to a generic-but-rigorous quiz.
 */
export async function generateCalibration(
  examGoal: string | null
): Promise<CalibrationGenerationResult> {
  const goal = (examGoal && examGoal.trim()) ||
    "general competitive Indian higher-secondary syllabus (mix of physics, chemistry, biology, math, English)";

  const userPrompt = buildUserPrompt(goal);

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const raw = await groqJSON(SYSTEM_PROMPT, userPrompt);
      const questions = validatePayload(raw);
      return { questions, groq_model: GROQ_MODEL };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      // Loop and retry. The second attempt benefits from the fact that
      // Groq's output is non-deterministic at temperature 0.4, so the
      // failure is unlikely to repeat for the same reason.
    }
  }

  throw new Error(
    `calibration generation failed after 2 attempts: ${lastError?.message || "unknown"}`
  );
}
