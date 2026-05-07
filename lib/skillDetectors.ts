// lib/skillDetectors.ts
// -----------------------------------------------------------------------
// Corporate-style technical skill detection for the generate pages.
//
// This is the corporate analog of EXAM_DETECTORS (which detects CAT,
// JEE, NEET etc. in /api/generate and /api/student/quick-test). Where
// the exam detectors tune for "Indian competitive exam style," these
// tune for "professional / training assessment style" — code-completion
// fragments, scenario-based reasoning, troubleshooting, certification-
// shaped questions.
//
// The user's `learner_profile` ('k12' | 'competitive_exam' | 'corporate')
// drives which detector table the generate page consults. K-12 users
// don't see this surface at all; corporate users skip the exam table
// and only see skill suggestions; competitive_exam users see exam
// suggestions only. Crucially: terminology stays the same ("student",
// "teacher", "test") regardless — only the content of the suggestions
// + the generation prompt style changes.
//
// Adding a new skill: push another entry below with whole-word tokens
// the user might type. Token match is whole-word + uppercase, same
// behaviour as detectExamFromTopic.

import type { BloomLevel } from "@/lib/bloom";

export type SkillDefault = {
  /** Display label for tooltips and the "why" caption. */
  displayName: string;
  /** Domain bucket — used by the prompt builder if it wants to
   *  switch register (e.g., code-completion vs. troubleshooting). */
  domain: "language" | "framework" | "cloud" | "data" | "ops" | "legacy" | "cert";
  /** Short rationale shown to the teacher / corporate trainer when the
   *  detector fires. Keep under 80 chars. */
  rationale: string;
  /** Bloom levels this skill realistically tests. We filter at the UI
   *  layer + warn if the teacher picks levels outside this set. */
  supportedBloomLevels: BloomLevel[];
};

export const SKILL_DEFAULTS: Record<string, SkillDefault> = {
  // ---- Programming languages ------------------------------------------
  JAVA: {
    displayName: "Java",
    domain: "language",
    rationale: "Apply / Analyze: read code, predict output, fix the bug.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  PYTHON: {
    displayName: "Python",
    domain: "language",
    rationale: "Apply / Analyze: idioms, comprehensions, library use.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  JAVASCRIPT: {
    displayName: "JavaScript",
    domain: "language",
    rationale: "Apply / Analyze: closures, async, type coercion gotchas.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  TYPESCRIPT: {
    displayName: "TypeScript",
    domain: "language",
    rationale: "Analyze: type narrowing, generics, declaration merging.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  GO: {
    displayName: "Go",
    domain: "language",
    rationale: "Apply / Analyze: goroutines, channels, error handling.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  COBOL: {
    displayName: "COBOL",
    domain: "legacy",
    rationale: "Apply / Analyze: WORKING-STORAGE, batch flow, file I/O.",
    supportedBloomLevels: ["remember", "understand", "apply", "analyze"],
  },

  // ---- Mainframe / legacy ---------------------------------------------
  JCL: {
    displayName: "JCL (Job Control Language)",
    domain: "legacy",
    rationale: "Apply / Analyze: job steps, DD statements, condition codes.",
    supportedBloomLevels: ["remember", "understand", "apply", "analyze"],
  },
  MAINFRAME: {
    displayName: "Mainframe",
    domain: "legacy",
    rationale: "Apply / Analyze: TSO/ISPF, JCL, COBOL, datasets.",
    supportedBloomLevels: ["remember", "understand", "apply", "analyze"],
  },
  DB2: {
    displayName: "DB2",
    domain: "data",
    rationale: "Apply / Analyze: SQL on DB2, performance, locking.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  CICS: {
    displayName: "CICS",
    domain: "legacy",
    rationale: "Apply / Analyze: transactions, BMS maps, EXEC CICS.",
    supportedBloomLevels: ["remember", "understand", "apply", "analyze"],
  },

  // ---- Frameworks -----------------------------------------------------
  REACT: {
    displayName: "React",
    domain: "framework",
    rationale: "Apply / Analyze: hooks, render lifecycle, state vs props.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  SPRING: {
    displayName: "Spring / Spring Boot",
    domain: "framework",
    rationale: "Apply / Analyze: DI, AOP, transactions, REST controllers.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  DJANGO: {
    displayName: "Django",
    domain: "framework",
    rationale: "Apply / Analyze: ORM, middleware, signals, security.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  NODE: {
    displayName: "Node.js",
    domain: "framework",
    rationale: "Apply / Analyze: event loop, streams, async patterns.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },

  // ---- Cloud ----------------------------------------------------------
  AWS: {
    displayName: "AWS",
    domain: "cloud",
    rationale: "Apply / Analyze: choose the right service, IAM, VPC.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  GCP: {
    displayName: "Google Cloud",
    domain: "cloud",
    rationale: "Apply / Analyze: GKE, BigQuery, IAM, networking.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  AZURE: {
    displayName: "Microsoft Azure",
    domain: "cloud",
    rationale: "Apply / Analyze: AKS, Cosmos DB, Entra ID, networking.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  KUBERNETES: {
    displayName: "Kubernetes",
    domain: "ops",
    rationale: "Apply / Analyze: pods, services, RBAC, debugging.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  K8S: {
    displayName: "Kubernetes",
    domain: "ops",
    rationale: "Apply / Analyze: pods, services, RBAC, debugging.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  DOCKER: {
    displayName: "Docker",
    domain: "ops",
    rationale: "Apply / Analyze: images, networks, multi-stage builds.",
    supportedBloomLevels: ["understand", "apply", "analyze"],
  },
  TERRAFORM: {
    displayName: "Terraform",
    domain: "ops",
    rationale: "Apply / Analyze: state, modules, drift, import.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },

  // ---- Data ------------------------------------------------------------
  SQL: {
    displayName: "SQL",
    domain: "data",
    rationale: "Apply / Analyze: joins, window functions, query plans.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },
  POSTGRES: {
    displayName: "PostgreSQL",
    domain: "data",
    rationale: "Apply / Analyze: indexes, EXPLAIN, MVCC, RLS.",
    supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"],
  },

  // ---- Common certifications & platforms ------------------------------
  SAP: {
    displayName: "SAP",
    domain: "cert",
    rationale: "Apply / Analyze: modules, transactions, customization.",
    supportedBloomLevels: ["remember", "understand", "apply", "analyze"],
  },
  SERVICENOW: {
    displayName: "ServiceNow",
    domain: "cert",
    rationale: "Apply / Analyze: ITSM, scripting, workflows.",
    supportedBloomLevels: ["remember", "understand", "apply"],
  },
  SALESFORCE: {
    displayName: "Salesforce",
    domain: "cert",
    rationale: "Apply / Analyze: Apex, flows, security model.",
    supportedBloomLevels: ["understand", "apply", "analyze"],
  },
};

/**
 * Detect a corporate skill from the topic field. Same whole-word matching
 * pattern as detectExamFromTopic — splits on punctuation/whitespace, checks
 * each token uppercased against the table.
 *
 * Returns the first match (so if a teacher types "Java Spring Boot" they
 * get the JAVA detector; future enhancement: rank matches and return the
 * most specific).
 */
export function detectSkillFromTopic(topic: string): SkillDefault | null {
  if (!topic) return null;
  const tokens = topic.toUpperCase().split(/[\s,;.\-/_()]+/).filter(Boolean);
  for (const t of tokens) {
    if (SKILL_DEFAULTS[t]) return SKILL_DEFAULTS[t];
  }
  return null;
}
