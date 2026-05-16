// lib/rankPredictorEligibility.ts
// -----------------------------------------------------------------------------
// Foolproof "is this quiz a competitive-exam mock?" classifier for the Mock
// Rank Predictor.
//
// Why this exists
// ---------------
// Until 2026-05-13 a student could take a Java quiz, open /student/results,
// pick "CAT" from the Predict-my-rank dropdown, and ZCORIQ would happily
// return "Your CAT AIR is ~12,300." That's nonsense: a 50-question Java MCQ
// isn't a CAT mock. The rank predictor's cohort baselines (CAT ≈ 330k MBA
// aspirants, NEET ≈ 2.3M medical aspirants) only make sense when the test
// the student took is actually a mock of that exam.
//
// This module looks at the quiz's metadata (topic, name, topic_family) and
// answers three questions:
//
//   1. Does the topic name look like a known competitive exam? → which one?
//   2. Does it look like a corporate / programming skill (Java, Python, AWS)?
//   3. Is it just a generic school topic (Photosynthesis, Algebra)?
//
// The three callers — /api/rank/predict, /student/results UI, and any future
// surface that wants to gate on rank-eligibility — all agree on the verdict
// via this one shared function. That's the foolproof bit: the backend hard-
// validates, the UI hides the button proactively, and the standalone form
// surfaces a clear error — all from the same source of truth.
//
// Adding a new exam → push a row into EXAM_TOKEN_MAP. Adding a new corporate
// skill (used as a "do NOT predict rank" signal) → push to CORPORATE_SKILL_TOKENS.
// =============================================================================

/** The four exam baselines the rank predictor actually models. Keep in sync
 *  with EXAM_BASELINES in app/api/rank/predict/route.ts. */
export type RankExamType = "JEE_MAIN" | "NEET" | "CAT" | "CUSTOM";

export function isRankExamType(s: unknown): s is RankExamType {
  return s === "JEE_MAIN" || s === "NEET" || s === "CAT" || s === "CUSTOM";
}

// Whole-word tokens that map to a specific rank-baseline exam_type. We only
// include the exams the rank predictor has cohort baselines for. JEE Advanced,
// BITSAT, GATE, etc. are recognised as "competitive-exam-style" by /api/generate
// but they don't have a rank baseline here yet, so the predictor will fall
// back to CUSTOM for them.
const EXAM_TOKEN_MAP: Record<string, RankExamType> = {
  // ---- JEE family ----
  JEE: "JEE_MAIN",
  "JEE-MAIN": "JEE_MAIN",
  "JEE-MAINS": "JEE_MAIN",
  "JEE-ADVANCED": "JEE_MAIN", // approximate — falls back to JEE_MAIN cohort
  IIT: "JEE_MAIN",
  IITJEE: "JEE_MAIN",
  NIT: "JEE_MAIN",
  // ---- NEET family ----
  NEET: "NEET",
  AIIMS: "NEET",
  // ---- CAT family ----
  CAT: "CAT",
  IIM: "CAT",
  XAT: "CAT",
  SNAP: "CAT",
  MBA: "CAT",
};

// Tokens we recognise as "this is a competitive exam — just not one we have
// cohort baselines for." Hitting one of these still passes the gate; we map
// the user's chosen exam_type through, or default to CUSTOM if they didn't
// pick one. The IMPORTANT thing is these tokens are NOT corporate skills,
// so they don't trigger the refusal path.
const OTHER_EXAM_TOKENS = new Set([
  "GMAT", "GRE", "UPSC", "IELTS", "TOEFL", "CLAT",
  "BITSAT", "SAT", "GATE", "NDA", "CUET",
  "SSC", "RRB", "IBPS", "RBI", "LIC", "AFCAT", "CDS",
]);

// Tokens that scream "this test is a corporate / programming / IT skill, NOT
// a competitive-exam mock." Sources: the SKILL_DEFAULTS table in
// lib/skillDetectors.ts, plus a few common variants.
//
// IMPORTANT: keep these as whole-word tokens. We deliberately match strict
// uppercase tokens after splitting on punctuation/whitespace — so "Javascript"
// will tokenise to "JAVASCRIPT" and won't match the JAVA token.
const CORPORATE_SKILL_TOKENS = new Set([
  // Languages
  "JAVA", "PYTHON", "JAVASCRIPT", "TYPESCRIPT", "GO", "GOLANG", "RUST",
  "C", "C++", "CPP", "C#", "CSHARP", "RUBY", "PHP", "SWIFT", "KOTLIN",
  "SCALA", "PERL", "R", "MATLAB", "DART", "ELIXIR", "HASKELL", "LUA",
  "ASSEMBLY", "FORTRAN", "PASCAL", "OBJECTIVEC",
  // Web frameworks
  "REACT", "REACTJS", "VUE", "VUEJS", "ANGULAR", "ANGULARJS", "NEXTJS",
  "NEXT.JS", "NUXT", "SVELTE", "DJANGO", "FLASK", "FASTAPI", "RAILS",
  "SPRING", "SPRINGBOOT", "EXPRESS", "NESTJS", "LARAVEL",
  "BACKBONE", "EMBER", "REMIX", "ASTRO", "GATSBY",
  // Cloud / Ops / Networking
  "AWS", "AZURE", "GCP", "KUBERNETES", "K8S", "DOCKER", "TERRAFORM",
  "ANSIBLE", "JENKINS", "GIT", "GITHUB", "GITLAB", "BITBUCKET",
  "LINUX", "UNIX", "DEVOPS", "DEVSECOPS",
  "PROMETHEUS", "GRAFANA", "DATADOG", "SPLUNK",
  "OPENSHIFT", "HELM", "ISTIO", "ENVOY", "NGINX", "APACHE",
  "HAPROXY", "CLOUDFLARE", "FASTLY", "AKAMAI",
  // Data / DB
  "SQL", "PLSQL", "TSQL", "POSTGRES", "POSTGRESQL", "MYSQL",
  "MONGODB", "MONGO", "REDIS", "MEMCACHED", "CASSANDRA",
  "DYNAMODB", "FIRESTORE", "FIREBASE", "ELASTICSEARCH", "OPENSEARCH", "SOLR",
  "KAFKA", "RABBITMQ", "PULSAR",
  "SPARK", "HADOOP", "HIVE", "AIRFLOW", "DBT",
  "SNOWFLAKE", "BIGQUERY", "REDSHIFT", "DATABRICKS",
  "TABLEAU", "POWERBI", "LOOKER", "METABASE",
  // Mainframe stack
  "MAINFRAME", "ZOS", "JCL", "COBOL", "CICS",
  "DB2", "IMS", "VSAM", "ISPF", "TSO", "JES2", "JES3", "RACF", "ACF2",
  // Payments / fintech
  "ISO8583", "EMV", "PCI", "PCIDSS", "P2PE", "DUKPT",
  "ACQUIRER", "ISSUER", "MERCHANT", "TOKENIZATION",
  "POS", "ATM", "EFTPOS", "PINPAD", "EFT", "ACH", "SWIFT",
  "SEPA", "RTP", "FEDNOW", "RTGS", "NEFT", "IMPS", "UPI",
  // Security / cryptography
  "HSM", "HARDWARESECURITYMODULE", "KMS", "KEYMANAGEMENTSERVICE",
  "PKI", "RSA", "ECC", "ECDSA", "AES", "DES", "TDES",
  "OAUTH", "OAUTH2", "JWT", "OPENID", "OPENIDCONNECT",
  "SHA", "SHA256", "HMAC", "ARQC", "ARPC", "CVV", "CVC",
  "SAML", "SSO", "LDAP", "KERBEROS", "X509", "TLS", "SSL", "MTLS",
  "IPSEC", "WIREGUARD", "WAF", "SIEM", "VPN", "ZEROTRUST",
  // Certs
  "CCNA", "CCNP", "CCIE", "CKA", "CKAD", "CKS", "OSCP", "CEH",
  "CISSP", "CISM", "CISA", "CRISC", "CCSP",
  "PMP", "PRINCE2", "SCRUM", "CSM", "CSPO", "SAFE", "ITIL",
]);

/** A small subset of school/exam-prep topics we recognise as "could plausibly
 *  be a JEE/NEET mock topic if the user picks the right exam_type." We don't
 *  auto-map to an exam_type here — we just decline to call it a corporate skill. */
const ACADEMIC_SUBJECT_TOKENS = new Set([
  "PHYSICS", "CHEMISTRY", "BIOLOGY", "BOTANY", "ZOOLOGY",
  "MATHEMATICS", "MATHS", "MATH", "ALGEBRA", "CALCULUS", "GEOMETRY",
  "TRIGONOMETRY", "STATISTICS", "PROBABILITY",
  "ENGLISH", "HISTORY", "GEOGRAPHY", "ECONOMICS", "POLITY",
  "ACCOUNTING", "COMMERCE", "BUSINESS",
]);

/** Split a free-text label into uppercase whole-word tokens, then append
 *  concatenated forms so "ISO 8583" matches "ISO8583", "PCI DSS" matches
 *  "PCIDSS", "OAuth 2" matches "OAUTH2", etc. */
function tokenise(s: string | null | undefined): string[] {
  if (!s) return [];
  const parts = s.toUpperCase().split(/[\s,;.\-/_()]+/).filter(Boolean);
  if (parts.length === 0) return [];
  const out: string[] = [...parts];
  for (let i = 0; i + 1 < parts.length; i++) {
    out.push(parts[i] + parts[i + 1]);
  }
  const fullConcat = parts.join("").replace(/[^A-Z0-9]/g, "");
  if (fullConcat && fullConcat !== parts[0]) out.push(fullConcat);
  return out;
}

/** Result of running the eligibility classifier against a quiz. */
export type RankEligibility =
  | {
      verdict: "matches_known_exam";
      suggestedExamType: RankExamType;
      matchedToken: string;
      reason: string;
    }
  | {
      verdict: "competitive_exam_other";
      matchedToken: string;
      reason: string;
    }
  | {
      verdict: "corporate_skill";
      matchedToken: string;
      reason: string;
    }
  | {
      verdict: "generic";
      reason: string;
    };

/**
 * Classify whether a quiz is rank-prediction-eligible based on its metadata.
 *
 * Decision order (first match wins):
 *   1. Any token matches a known rank-baseline exam (JEE / NEET / CAT) → matches_known_exam
 *   2. Any token matches OTHER_EXAM_TOKENS (GMAT, GATE, etc.) → competitive_exam_other
 *   3. Any token matches CORPORATE_SKILL_TOKENS → corporate_skill (REFUSE PATH)
 *   4. Otherwise → generic (allow but always warn)
 *
 * Why this order: an exam name in the topic ("CAT mock 1") wins over a
 * skill token because the student's intent is unambiguous. If their topic
 * is just "Java" or "AWS Solutions Architect" there is no way that's a
 * competitive-exam mock — refuse.
 */
export function classifyQuizForRankPrediction(input: {
  topic?: string | null;
  name?: string | null;
  topicFamily?: string | null;
  /**
   * The student's own profile.exam_goal slug (e.g. "neet_prep", "jee_main",
   * "cat_prep"). Added 2026-05-14 so the predictor can fall back to the
   * student's stated goal when the quiz's topic/name don't carry an
   * explicit exam token. Without this, a NEET student practising "blood
   * group" got refused because the topic alone has no NEET keyword.
   *
   * Corporate-skill matches on the TOPIC still win over this profile
   * fallback — we never claim a Java test is a NEET mock just because
   * the student is preparing for NEET. The fallback only applies when
   * topic-based detection is silent (neither exam nor corporate skill).
   */
  studentExamGoal?: string | null;
}): RankEligibility {
  // Pool every label string the quiz carries so a single match anywhere
  // (topic, name, or canonical family) is enough.
  const allTokens = [
    ...tokenise(input.topic),
    ...tokenise(input.name),
    ...tokenise(input.topicFamily),
  ];

  // 1. Known rank-baseline exam token in the quiz metadata.
  for (const t of allTokens) {
    if (EXAM_TOKEN_MAP[t]) {
      return {
        verdict: "matches_known_exam",
        suggestedExamType: EXAM_TOKEN_MAP[t],
        matchedToken: t,
        reason: `Quiz looks like a ${EXAM_TOKEN_MAP[t]} mock (matched "${t}").`,
      };
    }
  }

  // 2. Other competitive exam token in the quiz metadata.
  for (const t of allTokens) {
    if (OTHER_EXAM_TOKENS.has(t)) {
      return {
        verdict: "competitive_exam_other",
        matchedToken: t,
        reason: `Quiz looks like a ${t} mock — rank predictor will use the CUSTOM cohort baseline since we don't have a dedicated ${t} model yet.`,
      };
    }
  }

  // 3. Corporate / programming / IT skill in the quiz metadata. This
  //    refuse-path takes precedence over the studentExamGoal fallback —
  //    a Java test is never a NEET mock no matter what the student's
  //    profile says.
  for (const t of allTokens) {
    if (CORPORATE_SKILL_TOKENS.has(t)) {
      return {
        verdict: "corporate_skill",
        matchedToken: t,
        reason: `Quiz is on "${t}", a programming/IT skill — the Mock Rank Predictor only works for competitive-exam mocks (JEE / NEET / CAT). A ${t} test doesn't map to an All-India Rank.`,
      };
    }
  }

  // 4. Topic was silent on exam type but we can lean on the student's
  //    own profile. If their goal is NEET-prep / JEE-prep / CAT-prep /
  //    etc., treat the quiz as a mock of that exam. This unblocks the
  //    "blood group + NEET student" case — the test was GENERATED for
  //    the student's NEET prep, even though the topic name doesn't
  //    contain "NEET". Mirrors the same profile-aware pattern used in
  //    examDetectors.shouldUseCompetitiveExamFraming.
  if (input.studentExamGoal) {
    const g = String(input.studentExamGoal).toLowerCase().trim();
    if (g.startsWith("jee")) {
      return {
        verdict: "matches_known_exam",
        suggestedExamType: "JEE_MAIN",
        matchedToken: g,
        reason: `Quiz was generated as part of your JEE preparation (exam_goal = "${g}").`,
      };
    }
    if (g.startsWith("neet")) {
      return {
        verdict: "matches_known_exam",
        suggestedExamType: "NEET",
        matchedToken: g,
        reason: `Quiz was generated as part of your NEET preparation (exam_goal = "${g}").`,
      };
    }
    if (g === "cat" || g === "cat_prep") {
      return {
        verdict: "matches_known_exam",
        suggestedExamType: "CAT",
        matchedToken: g,
        reason: `Quiz was generated as part of your CAT preparation (exam_goal = "${g}").`,
      };
    }
    // Other competitive-exam goals fall through to "competitive_exam_other"
    // — the predictor will use the CUSTOM cohort baseline.
    if (
      g === "upsc" || g === "upsc_prep" ||
      g === "gmat" || g === "gmat_prep" ||
      g === "gre"  || g === "gre_prep"  ||
      g === "gate" || g === "gate_prep" ||
      g === "clat" || g === "clat_prep" ||
      g === "bitsat" || g === "bitsat_prep" ||
      g === "sat"  || g === "sat_prep"  ||
      g === "nda"  || g === "nda_prep"  ||
      g === "cuet" || g === "cuet_prep" ||
      g === "bank_exams" || g === "bank_prep" ||
      g === "ielts" || g === "ielts_prep" ||
      g === "toefl" || g === "toefl_prep"
    ) {
      return {
        verdict: "competitive_exam_other",
        matchedToken: g,
        reason: `Quiz was generated as part of your ${g.replace(/_/g, " ")} preparation — predictor will use the CUSTOM cohort baseline.`,
      };
    }
  }

  // 5. Generic / academic / unknown — neither the quiz metadata nor
  //    the student's profile resolves to a competitive exam. The
  //    caller (UI or backend) will refuse rank prediction.
  const hasAcademic = allTokens.some((t) => ACADEMIC_SUBJECT_TOKENS.has(t));
  return {
    verdict: "generic",
    reason: hasAcademic
      ? "Quiz topic looks like a general academic subject — the rank prediction will be a rough benchmark only."
      : "Quiz topic doesn't match a known exam or skill — the rank prediction will be a rough benchmark only.",
  };
}

/**
 * Hard-validate exam_type for the rank predictor. Used by both ad-hoc
 * (raw_score + max_score) and attempt-based paths.
 *
 * Returns either a strict RankExamType or an error string. The previous
 * code silently coerced unknown values to JEE_MAIN, which masked client
 * bugs and frustrated users who later saw "JEE Main" appear without
 * picking it. Fail loudly instead.
 */
export function validateExamType(raw: unknown): { ok: true; value: RankExamType } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") {
    // Empty → treat as CUSTOM so the predictor still works without the
    // caller having to pick. CUSTOM uses a generic-mock cohort baseline.
    return { ok: true, value: "CUSTOM" };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: "exam_type must be a string." };
  }
  const up = raw.toUpperCase();
  if (isRankExamType(up)) return { ok: true, value: up };
  return {
    ok: false,
    error: `Unknown exam_type "${raw}". Expected one of: JEE_MAIN, NEET, CAT, CUSTOM.`,
  };
}

/**
 * Hard-validate a (raw_score, max_score) pair. Catches NaN, Infinity,
 * negative scores, scores > max, max <= 0, and (optionally) very-short tests.
 *
 * `minQuestions` is the smallest test length we'll accept. Default 1 —
 * the route already requires non-zero, but callers may want to demand
 * more for the bigger-tests-narrower-band reason.
 */
export function validateScorePair(
  raw_score: unknown,
  max_score: unknown,
  opts: { minQuestions?: number } = {}
): { ok: true; raw: number; max: number } | { ok: false; error: string } {
  const r = Number(raw_score);
  const m = Number(max_score);
  if (!Number.isFinite(r)) return { ok: false, error: "raw_score must be a finite number." };
  if (!Number.isFinite(m)) return { ok: false, error: "max_score must be a finite number." };
  if (m <= 0) return { ok: false, error: "max_score must be greater than zero — you can't predict rank with zero questions." };
  if (r < 0) return { ok: false, error: "raw_score cannot be negative." };
  if (r > m) return { ok: false, error: `raw_score (${r}) cannot exceed max_score (${m}).` };
  const minQ = opts.minQuestions ?? 1;
  if (m < minQ) return { ok: false, error: `Need at least ${minQ} question${minQ === 1 ? "" : "s"} to predict rank.` };
  return { ok: true, raw: r, max: m };
}
