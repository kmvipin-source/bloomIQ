// lib/topicEnrichment.ts
// -----------------------------------------------------------------------------
// Helpers for enriching the user-typed topic with extra context before it's
// handed to the LLM.
//
// Distribution model (2026-05-13 late evening)
// ---------------------------------------------
// The textbox text is treated as ONE MORE sub-area — co-equal with the chips,
// not a special "+1 slot". With N total questions and (k chips + textbox),
// the LLM distributes N questions evenly across (k + 1) sub-areas.
//
// Scaling check: 9 questions / 4 buckets → ~2-3 each. 120 questions / 4
// buckets → ~30 each. No question count "burns" on the textbox.
//
// Branches:
//   - chips only          → "distribute EQUALLY across <chips>"
//   - textbox only        → "Focus the questions on this sub-area: <text>"
//                           (treated as a single sub-area, no distribution needed)
//   - BOTH (single chip)  → "distribute EQUALLY across these 2 sub-areas:
//                            <chip>, <text>"
//   - BOTH (multi-chip)   → "distribute EQUALLY across these N+1 sub-areas:
//                            <chips>, <text>"
//
// validateFocusForTopic() rejects off-topic textbox content via a token
// overlap heuristic so the route can strip + warn rather than fabricate
// nonsense ("Krebs cycle on Mainframe" gets caught and dropped).
// =============================================================================

const STOPWORDS = new Set([
  "THE", "AND", "FOR", "WITH", "INTO", "FROM", "THIS", "THAT", "WHICH", "WHEN", "WHERE", "WHAT",
  "ARE", "WAS", "WERE", "BEEN", "BEING", "HAVE", "HAS", "HAD", "WILL", "WOULD", "SHOULD", "COULD",
  "ABOUT", "INCLUDING", "INCLUDE", "INCLUDES", "INCLUDED", "ALSO", "MORE", "SOME", "ANY", "ALL",
  "FOCUS", "ONLY", "JUST", "EVERY", "MAINLY", "MOSTLY", "EMPHASIZE", "EMPHASIZING",
]);

const MIN_TOKEN_LEN = 3;

function tokeniseStrong(s: string): Set<string> {
  if (!s) return new Set();
  return new Set(
    s.toUpperCase().split(/[\s,;.\-/_()\[\]{}"‘’“”]+/).filter((t) => {
      if (t.length < MIN_TOKEN_LEN) return false;
      if (STOPWORDS.has(t)) return false;
      return true;
    }),
  );
}

/**
 * Append additional focus + sub-topic chip context to a topic string.
 * Returns the topic unchanged when neither input is set.
 *
 * Key design rule (2026-05-13 late evening): the textbox is a co-equal
 * sub-area, not a "+1 standalone" slot. Distribution always spans
 * (chips.length + (textbox ? 1 : 0)) buckets evenly.
 */
/** Length above which we treat the textbox as "free-form instructions"
 *  rather than as a sub-area chip. ≤150 chars (most chip-style phrasings)
 *  keeps the legacy sub-area distribution. Longer text is sent as
 *  explicit student instructions so phrases like "tough questions",
 *  "clinical scenarios", "step-by-step working shown" survive into the
 *  prompt instead of being mangled into a sub-area label. */
const INSTRUCTIONS_LENGTH_THRESHOLD = 150;

export function applyAdditionalFocus(
  baseTopic: string,
  additionalFocus: string,
  subTopics: string[],
): string {
  let out = (baseTopic || "").trim();
  if (!out) return out;
  const cleanedChips = (subTopics || [])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s.length > 0 && s.length <= 80)
    .slice(0, 12);
  const rawFocus = (additionalFocus || "").trim();
  // Hard cap (matches the UI's maxLength=800). Slightly above the old 400
  // because the textarea now accepts longer natural-language instructions.
  const focusText = rawFocus.length > 800 ? rawFocus.slice(0, 800) + "…" : rawFocus;

  // Two branches based on the textbox length:
  //
  //   (a) Short (≤150 chars) or empty → treat as a sub-area, distribute
  //       with the chips. Legacy behaviour unchanged.
  //   (b) Long (>150 chars) → strip out of the sub-area distribution and
  //       append as explicit STUDENT INSTRUCTIONS in the prompt. The
  //       chips alone (if any) drive sub-area distribution.
  //
  // This means a student typing "Focus on absorption mechanisms — clinical
  // scenarios — show working" gets that phrase delivered to the AI as
  // instructions, not chopped into a single-line sub-area suffix.
  const useAsInstructions = focusText.length > INSTRUCTIONS_LENGTH_THRESHOLD;

  // Combine chips into the sub-area list. The textbox joins ONLY when
  // it's short (sub-area mode); long instructions get their own block.
  const areas: string[] = [...cleanedChips];
  if (focusText && !useAsInstructions) areas.push(`"${focusText}"`);

  if (areas.length === 1) {
    out += `. Focus the questions on this sub-area WITHIN THE MAIN TOPIC: ${areas[0]}. Do NOT fabricate off-topic content.`;
  } else if (areas.length >= 2) {
    out += `. IMPORTANT: distribute your questions roughly EQUALLY across these ${areas.length} sub-areas WITHIN THE MAIN TOPIC — ${areas.join(", ")}. Each sub-area must get at least one question. Do NOT cluster all questions in a single sub-area even if that sub-area is more common in training data. Do NOT fabricate off-topic content — if a listed sub-area cannot reasonably yield a question within the main topic, skip it and rebalance across the others.`;
  }

  // Append free-form student instructions when the textbox crossed the
  // length threshold. We DO NOT treat this as a sub-area — it's direct
  // guidance to the model about style/depth/coverage/etc. Phrased
  // explicitly so the LLM doesn't confuse it with topic content.
  if (focusText && useAsInstructions) {
    out += `\n\nADDITIONAL INSTRUCTIONS FROM THE STUDENT (verbatim — honour these while staying ON-TOPIC and respecting the requested Bloom levels):\n"""${focusText}"""\n\nIf any instruction asks for content outside the main topic, IGNORE that part and stay within the topic.`;
  }

  return out;
}

/**
 * Heuristic check: is the textbox text related to the main topic?
 * Returns ok:true (assume related) when there's any non-trivial token
 * overlap with the topic, chips, or topic's placeholder hints.
 */
export function validateFocusForTopic(
  topic: string | null | undefined,
  focus: string | null | undefined,
  chips: string[] = [],
): { ok: true } | { ok: false; reason: string } {
  const t = (topic || "").trim();
  const f = (focus || "").trim();
  if (!f) return { ok: true };
  if (!t) return { ok: true };

  const focusTokens = tokeniseStrong(f);
  if (focusTokens.size === 0) return { ok: true };

  const pool = new Set<string>();
  for (const tok of tokeniseStrong(t)) pool.add(tok);
  for (const c of chips) for (const tok of tokeniseStrong(c)) pool.add(tok);
  for (const topicTok of tokeniseStrong(t)) {
    const hint = PLACEHOLDER_HINTS[topicTok];
    if (hint) for (const ht of tokeniseStrong(hint)) pool.add(ht);
  }
  const concat = Array.from(tokeniseStrong(t)).join("").replace(/[^A-Z0-9]/g, "");
  if (concat && PLACEHOLDER_HINTS[concat]) {
    for (const ht of tokeniseStrong(PLACEHOLDER_HINTS[concat])) pool.add(ht);
  }

  for (const tok of focusTokens) {
    if (pool.has(tok)) return { ok: true };
    for (const p of pool) {
      if (p.length >= MIN_TOKEN_LEN && (p.includes(tok) || tok.includes(p))) {
        return { ok: true };
      }
    }
  }
  return {
    ok: false,
    reason: `"${f.slice(0, 80)}${f.length > 80 ? "…" : ""}" doesn't appear related to "${t}". The "Anything specific to cover" field will be ignored. Either add it as a sub-area chip if it belongs, or remove it and try a different angle.`,
  };
}

const PLACEHOLDER_HINTS: Record<string, string> = {
  ISO8583: "e.g. data elements, MTI, bitmap parsing, field types, length indicators",
  EMV: "e.g. ARQC generation, CVR/TVR, contactless flow, fallback rules",
  PCIDSS: "e.g. SAQ types, segmentation, tokenisation, audit requirements",
  MAINFRAME: "e.g. JCL, COBOL, CICS, DB2, VSAM, JES2/JES3, ISPF, batch processing, RACF",
  JCL: "e.g. job cards, DD statements, PROCs, SYSIN/SYSOUT, condition codes, batch jobs",
  COBOL: "e.g. data divisions, PERFORM loops, file handling, copybooks, paragraphs",
  CICS: "e.g. transactions, EXEC CICS, BMS maps, TSQ/TDQ, pseudo-conversational design",
  DB2: "e.g. DCLGEN, embedded SQL, cursor handling, isolation levels, BIND",
  VSAM: "e.g. KSDS vs ESDS vs RRDS, IDCAMS, cluster definition, secondary indexes",
  RACF: "e.g. user profiles, dataset profiles, resource classes, RACF commands, audit",
  KUBERNETES: "e.g. pod scheduling, services, ingress, RBAC, persistent volumes",
  DOCKER: "e.g. image layers, multi-stage builds, networking, volumes, security",
  AWS: "e.g. IAM policies, VPC peering, S3 lifecycle, Lambda cold starts",
  AZURE: "e.g. AAD roles, ARM templates, Functions, Storage, networking",
  GCP: "e.g. IAM, VPC, Cloud Functions, Cloud Run, BigQuery basics",
  TERRAFORM: "e.g. providers, state, modules, workspaces, drift detection",
  JAVA: "e.g. streams API, collections, concurrency, JVM tuning, lambdas",
  PYTHON: "e.g. decorators, generators, async/await, list comprehensions, GIL",
  JAVASCRIPT: "e.g. event loop, closures, promises, prototypes, ES modules",
  TYPESCRIPT: "e.g. generics, conditional types, type narrowing, decorators",
  POSTGRES: "e.g. indexes, query plans, MVCC, partitioning, EXPLAIN ANALYZE",
  POSTGRESQL: "e.g. indexes, query plans, MVCC, partitioning, EXPLAIN ANALYZE",
  MONGODB: "e.g. aggregation pipeline, sharding, indexes, replication, ACID",
  REDIS: "e.g. data structures, persistence, eviction, pub/sub, clustering",
  SQL: "e.g. joins, window functions, indexes, normalisation, transactions",
  OAUTH: "e.g. authorization code flow, PKCE, JWT vs opaque, scopes, refresh tokens",
  OAUTH2: "e.g. authorization code flow, PKCE, JWT vs opaque, scopes, refresh tokens",
  JWT: "e.g. signing algorithms, claims, expiry, refresh strategy, vulnerabilities",
  PHOTOSYNTHESIS: "e.g. light reactions, Calvin cycle, C3 vs C4, photorespiration",
  TRIGONOMETRY: "e.g. identities, angle sum, inverse functions, applications",
  ALGEBRA: "e.g. quadratic equations, polynomials, sequences, AP/GP",
};

const GENERIC_PLACEHOLDER = "e.g. specific sub-topics, examples, or angles to cover";

export function smartTopicPlaceholder(topic: string | null | undefined): string {
  if (!topic) return GENERIC_PLACEHOLDER;
  const tokens = topic.toUpperCase().split(/[\s,;.\-/_()]+/).filter(Boolean);
  for (const t of tokens) {
    if (PLACEHOLDER_HINTS[t]) return PLACEHOLDER_HINTS[t];
  }
  const concat = tokens.join("").replace(/[^A-Z0-9]/g, "");
  if (PLACEHOLDER_HINTS[concat]) return PLACEHOLDER_HINTS[concat];
  return GENERIC_PLACEHOLDER;
}
