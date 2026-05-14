// lib/skillFewShot.ts
// =============================================================================
// Niche-skill FEW-SHOT QUESTION BANK
// -----------------------------------------------------------------------------
// Question-quality lever for the long tail of corporate / IT / fintech /
// security skills that the base LLM has weak priors on.
//
// Why this exists
// ---------------
// A vanilla "Generate 5 MCQs on JCL" prompt to Groq/Llama returns generic
// computer-science questions or wrong syntax. We've seen the model produce:
//   - Stems that confuse JCL with shell scripting
//   - "DD statement" questions with options labelled like Java method names
//   - ISO 8583 questions that quote made-up bit numbers
//   - HSM questions that conflate hardware with cryptographic libraries
//
// Few-shot grounding (2-3 real-shape examples per skill) reliably anchors
// the model to the correct domain register. The few-shot block is injected
// into the SYSTEM prompt of any generator route that detects a niche skill
// in the topic, in EXACTLY the same way EXAM_DETECTORS.sampleQuestions
// anchors competitive-exam generators (see lib/examDetectors.ts).
//
// What to put here
// ----------------
// Only the long-tail skills the base model is weakest on:
//   - Mainframe stack (JCL, COBOL, CICS, DB2, IMS, VSAM, RACF, ACF2, JES)
//   - Payments / fintech (ISO 8583, EMV, ARQC, DUKPT, P2PE, PCI-DSS)
//   - Crypto / HSM (HSM, KMS, ARQC/ARPC, key ceremonies, FIPS-140)
//   - Networking deep specifics (BGP attributes, MPLS, IS-IS)
//   - Niche certs (CISSP, CCSP, CISM, CRISC, CCNP-level only)
//
// Skills that the base model handles well (Java, Python, AWS, React,
// Kubernetes generic concepts) do NOT need few-shot grounding here —
// they'd just bloat the prompt. Add a row only when blind generation
// is demonstrably wrong.
//
// Example format
// --------------
// Each example is ONE sentence (the stem only). Keep them short — they
// anchor the SHAPE and TERMINOLOGY, not the difficulty. We deliberately
// do NOT include options or answers; that would teach the model to copy.
// =============================================================================

export type SkillFewShot = {
  /** Display label used in the prompt header. */
  label: string;
  /** What the topic is and why the LLM tends to get it wrong. Used in the
   *  prompt as an explicit "do NOT confuse with X" disambiguation. */
  disambiguation: string;
  /** 2-3 example stems in the real shape of an exam/training question in
   *  this domain. Used as FEW-SHOT anchors. The LLM is told NOT to copy
   *  them, only to match style + terminology + difficulty. */
  exampleStems: string[];
};

/**
 * Whole-word token keys. Topic is uppercased + split on punctuation/
 * whitespace and any token matching a key here triggers few-shot injection.
 * Keep keys aligned with the CORPORATE_SKILL_TOKENS set in
 * lib/rankPredictorEligibility.ts so we don't drift.
 */
export const SKILL_FEW_SHOT: Record<string, SkillFewShot> = {
  // ── Mainframe stack ─────────────────────────────────────────────────────
  JCL: {
    label: "JCL (Job Control Language, IBM z/OS)",
    disambiguation:
      "JCL is the batch-job scripting language on IBM mainframes (z/OS, OS/390). " +
      "It is NOT shell scripting, Jenkinsfile, or any modern CI/CD language. " +
      "Statement types include JOB, EXEC, DD; sub-parameters use COND, DISP, " +
      "DSN, UNIT, SPACE, DCB. Datasets, GDGs, and PROCs are the unit of work.",
    exampleStems: [
      "Given the following JOB and EXEC statements, what will the COND=(0,LT) parameter on STEP2 cause to happen when STEP1 ends with RC=4?",
      "Which DD statement attribute is required when allocating a new sequential dataset with SPACE=(CYL,(5,2),RLSE)?",
      "In a procedure invoked with EXEC PGM=IEFBR14, what is the role of the SYSIN DD DUMMY statement?",
    ],
  },
  COBOL: {
    label: "COBOL (Common Business-Oriented Language)",
    disambiguation:
      "COBOL is the procedural language behind core banking, insurance, and " +
      "government back-office systems. Programs have IDENTIFICATION, " +
      "ENVIRONMENT, DATA, and PROCEDURE divisions; FILE-CONTROL, FD, " +
      "WORKING-STORAGE; PERFORM, EVALUATE, COMPUTE verbs. It is NOT a " +
      "general scripting language — file I/O, PIC clauses, REDEFINES, COMP-3 " +
      "packed decimal, and 88-level condition names are central.",
    exampleStems: [
      "Given a WORKING-STORAGE entry '05 WS-AMOUNT PIC S9(7)V99 COMP-3', how many bytes does WS-AMOUNT occupy?",
      "In a PERFORM VARYING I FROM 1 BY 1 UNTIL I > 10 loop, what is the value of I when the loop terminates?",
      "Which COBOL clause would you use to allow one WORKING-STORAGE field to be referenced under two different names with different PIC clauses?",
    ],
  },
  CICS: {
    label: "CICS (Customer Information Control System)",
    disambiguation:
      "CICS is IBM's transaction processing monitor for mainframe (z/OS). " +
      "It uses pseudo-conversational programming, EXEC CICS commands, BMS " +
      "maps, TDQ/TSQ for queues, COMMAREA for state. It is NOT a database, " +
      "NOT a web server, and 'transaction' here means a CICS TRANSID, not a " +
      "DB transaction. EIB (Execute Interface Block) holds runtime metadata.",
    exampleStems: [
      "In a pseudo-conversational CICS program, where should state that must persist between consecutive screen sends be stored?",
      "What EXEC CICS command returns control to CICS while leaving the next program to start with a specified TRANSID?",
      "Which EIB field contains the CICS response code from the most recent EXEC CICS request?",
    ],
  },
  DB2: {
    label: "DB2 (IBM Db2 for z/OS)",
    disambiguation:
      "Db2 on the mainframe — NOT Db2 LUW, NOT generic SQL. Concepts unique " +
      "to z/OS Db2: tablespaces (segmented vs partitioned vs LOB), bufferpools " +
      "(BP0, BP32K), RUNSTATS / REORG / IBM utility chains, plans/packages, " +
      "BIND, DBRMs, PLAN_TABLE for EXPLAIN, threadsafe vs non-threadsafe.",
    exampleStems: [
      "Which Db2 for z/OS utility rebuilds catalog statistics so the optimizer can choose efficient access paths after large data changes?",
      "In Db2 for z/OS, what is the role of the PLAN_TABLE rows produced by an EXPLAIN of an embedded SQL statement?",
      "A high-frequency batch program issuing OPEN CURSOR / FETCH / CLOSE CURSOR consumes excessive CPU. Which BIND parameter or program design choice is most likely to reduce it?",
    ],
  },
  VSAM: {
    label: "VSAM (Virtual Storage Access Method)",
    disambiguation:
      "VSAM is the IBM z/OS access method for keyed/indexed datasets. Four " +
      "organisations: KSDS (key-sequenced), ESDS (entry-sequenced), RRDS " +
      "(relative-record), LDS (linear). Concepts: CI (control interval), CA " +
      "(control area), CI splits, FREESPACE, IDCAMS utility commands (DEFINE " +
      "CLUSTER, REPRO, LISTCAT, PRINT). It is NOT a relational database.",
    exampleStems: [
      "In a KSDS VSAM cluster, what triggers a CI split, and what is the typical cost of a CA split versus a CI split?",
      "Which IDCAMS command would you use to copy records from a flat sequential file into a previously-defined KSDS?",
      "What does the FREESPACE(20 10) parameter on DEFINE CLUSTER reserve, and why does it matter for insertion-heavy workloads?",
    ],
  },
  RACF: {
    label: "RACF (Resource Access Control Facility)",
    disambiguation:
      "RACF is IBM z/OS security manager. NOT AD, NOT IAM, NOT LDAP — it has " +
      "its own user IDs, groups, dataset/general-resource profiles, UACC, " +
      "PERMIT lists. ACEE in memory carries the user's authority at runtime. " +
      "Commands run under TSO (ADDUSER, PERMIT, RDEFINE, LISTUSER, SETROPTS).",
    exampleStems: [
      "Which RACF command grants a user READ access to a discrete dataset profile?",
      "What is the difference between UACC(NONE) on a generic dataset profile and the absence of an explicit PERMIT for a user?",
      "In RACF, what does SETROPTS GENERIC(*) followed by PROTECTALL(WARNING) do to dataset access enforcement on a system?",
    ],
  },
  IMS: {
    label: "IMS DB/DC (Information Management System)",
    disambiguation:
      "IMS is IBM's hierarchical database (IMS DB) + transaction manager (IMS DC), " +
      "still core in many banking/insurance back-offices. Segments and " +
      "PCBs/PSBs, DL/I calls (GU, GN, ISRT, REPL, DLET), DBDs, MFS for screens.",
    exampleStems: [
      "What is the difference between a 'Get Unique' (GU) and 'Get Next' (GN) DL/I call against an IMS DB segment?",
      "Which IMS control block defines the segments and their parent-child relationships for a database?",
      "A program receives status code 'GE' from a DL/I call — what does that signify, and what is the typical fix?",
    ],
  },

  // ── Payments / fintech ──────────────────────────────────────────────────
  ISO8583: {
    label: "ISO 8583 (card-payment messaging standard)",
    disambiguation:
      "ISO 8583 defines the wire format for card-issuer/acquirer messages " +
      "(authorisation, reversal, chargeback). Fields are numbered (DE-2 PAN, " +
      "DE-3 processing code, DE-4 amount, DE-39 response code, DE-55 EMV " +
      "tags, DE-128 MAC). Message types: 0100/0110 auth, 0200/0210 financial, " +
      "0420 reversal. This is binary/BCD over TCP, NOT a REST API. Do NOT " +
      "invent field numbers.",
    exampleStems: [
      "Which ISO 8583 data element carries the EMV chip data (TLV-encoded tags) on an 0100 authorisation request?",
      "If an acquirer receives an 0110 authorisation response with DE-39 = '51', what should it return to the merchant terminal?",
      "What is the standard ISO 8583 message type used by an acquirer to reverse a previously approved authorisation when the terminal fails to receive the response?",
    ],
  },
  EMV: {
    label: "EMV chip-card processing",
    disambiguation:
      "EMV is the Europay/Mastercard/Visa chip-card standard. Concepts: " +
      "CDA/DDA/SDA offline data authentication, ARQC (Authorisation Request " +
      "Cryptogram) generated by the card, ARPC sent back by the issuer, " +
      "CVM (Cardholder Verification Method) list, Terminal Action Codes vs " +
      "Issuer Action Codes, TVR/TSI. Distinct from magstripe and from " +
      "tokenisation.",
    exampleStems: [
      "An EMV terminal sends an authorisation request including an ARQC. What does the issuer return in the response to prove it processed the chip data?",
      "What is the purpose of the Terminal Verification Results (TVR) byte set during EMV transaction processing?",
      "On a contactless EMV transaction, which Cardholder Verification Method (CVM) is typically applied for amounts below the floor limit?",
    ],
  },
  PCIDSS: {
    label: "PCI-DSS (Payment Card Industry Data Security Standard)",
    disambiguation:
      "PCI-DSS is the security standard for entities handling cardholder " +
      "data. 12 high-level requirements. Distinct from PA-DSS, P2PE, 3DS. " +
      "Concepts: scope reduction via tokenisation, CDE (cardholder data " +
      "environment), SAQ vs ROC, ASV scans, segmentation tests.",
    exampleStems: [
      "Which PCI-DSS requirement covers quarterly external vulnerability scans performed by an Approved Scanning Vendor (ASV)?",
      "How does network segmentation reduce PCI-DSS scope for a merchant?",
      "Under PCI-DSS, what cardholder data elements are forbidden from being stored after authorisation?",
    ],
  },

  // ── Cryptography / security hardware ────────────────────────────────────
  HSM: {
    label: "HSM (Hardware Security Module)",
    disambiguation:
      "An HSM is a tamper-resistant hardware appliance that performs " +
      "cryptographic operations without exposing private keys to the host. " +
      "FIPS 140-2 / 140-3 certified, used for payment processing (Thales " +
      "payShield), PKI CA root key storage, code-signing. Concepts: key " +
      "ceremonies, M-of-N, LMK (Local Master Key) on payment HSMs, key " +
      "blocks. Distinct from KMS-as-a-service (AWS KMS, Azure Key Vault).",
    exampleStems: [
      "In a payment HSM, what is the Local Master Key (LMK) used for and how is it protected against extraction?",
      "Why are HSM key ceremonies typically performed under M-of-N (e.g. 3-of-5) custodian rules?",
      "A FIPS 140-2 Level 3 HSM differs from Level 2 primarily in which physical-security characteristic?",
    ],
  },
  DUKPT: {
    label: "DUKPT (Derived Unique Key Per Transaction)",
    disambiguation:
      "DUKPT is the key-management scheme for PIN-entry devices in payments. " +
      "Each transaction derives a unique key from a Base Derivation Key (BDK) " +
      "+ Key Serial Number (KSN). The PED never stores future keys (forward " +
      "secrecy). Used with TDES historically, AES in modern variants.",
    exampleStems: [
      "Why is DUKPT preferred over a fixed-key scheme for PIN-encryption in card-present payments?",
      "What component of the DUKPT KSN identifies the specific PIN-entry device that produced a transaction key?",
      "In TDES DUKPT, after a device exhausts its key-counter space (2^21 transactions), what must the acquirer do?",
    ],
  },
  PKI: {
    label: "PKI (Public Key Infrastructure)",
    disambiguation:
      "PKI is the asymmetric-cryptography trust framework: root CA, " +
      "intermediate CAs, end-entity certificates, CRLs, OCSP, certificate " +
      "policies (CP/CPS), key-usage extensions, EKU. Distinct from TLS (PKI " +
      "underpins TLS but is not TLS).",
    exampleStems: [
      "Why is an intermediate CA used instead of issuing end-entity certificates directly from the root?",
      "What is the practical difference between a CRL and an OCSP response from a relying-party's perspective?",
      "Which X.509 certificate extension specifies that a certificate may only be used for TLS server authentication and not for code signing?",
    ],
  },

  // ── Networking deep ────────────────────────────────────────────────────
  BGP: {
    label: "BGP (Border Gateway Protocol)",
    disambiguation:
      "BGP is the inter-AS routing protocol of the internet. Path-vector " +
      "(NOT distance-vector, NOT link-state). eBGP vs iBGP, route-reflector, " +
      "confederation, path attributes (AS_PATH, LOCAL_PREF, MED, NEXT_HOP, " +
      "ORIGIN, COMMUNITIES). Best-path selection has a strict ordered list.",
    exampleStems: [
      "Two iBGP-learned routes have equal LOCAL_PREF and identical AS_PATH lengths — which BGP best-path attribute is consulted next?",
      "Why is a full iBGP mesh among all routers in a single AS impractical at scale, and what two mechanisms solve it?",
      "What does a route-map setting 'set local-preference 200' on an inbound eBGP policy achieve compared to the default of 100?",
    ],
  },

  // ── Certs / governance ─────────────────────────────────────────────────
  CISSP: {
    label: "CISSP (Certified Information Systems Security Professional)",
    disambiguation:
      "CISSP is a broad management-leaning security cert. 8 domains: " +
      "Security & Risk Management, Asset Security, Architecture, " +
      "Communications & Network Security, IAM, Security Assessment, " +
      "Security Operations, Software Dev Security. Questions favour the " +
      "'best from a management perspective' answer, NOT the most technical.",
    exampleStems: [
      "From a CISSP risk-management perspective, which of the following is the BEST first step after discovering an unpatched critical vulnerability in a production system?",
      "Which security control category does a documented disaster-recovery plan primarily belong to?",
      "When designing access control for a multi-tenant SaaS application, which principle minimises blast radius when an account is compromised?",
    ],
  },
};

/**
 * Whole-word topic tokenisation, mirroring the splitter in
 * lib/rankPredictorEligibility.tokenise + lib/examDetectors.detectExamFromTopic.
 * Appends concatenated forms so "ISO 8583" matches "ISO8583", "PCI DSS"
 * matches "PCIDSS", "OAuth 2" matches "OAUTH2", etc.
 */
function tokenise(s: string): string[] {
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

/**
 * Detect a niche-skill few-shot block for a free-text topic. Returns the
 * SkillFewShot meta or null. Whole-word match — "Java" won't match "JavaScript"
 * (different tokens), "ISO 8583 deep dive" matches "ISO8583".
 */
export function detectSkillFewShot(topic: string | null | undefined): SkillFewShot | null {
  if (!topic) return null;
  for (const tok of tokenise(topic)) {
    if (SKILL_FEW_SHOT[tok]) return SKILL_FEW_SHOT[tok];
  }
  return null;
}

/**
 * Build a few-shot grounding block ready to prepend (or append) to a
 * SYSTEM prompt. Returns "" when no niche skill is detected so callers can
 * unconditionally concatenate. Example use in a generator route:
 *
 *   const sysWithFewShot = SYSTEM_PROMPT + buildSkillFewShotBlock(topic);
 *   await groqJSON(sysWithFewShot, userPrompt);
 */
export function buildSkillFewShotBlock(topic: string | null | undefined): string {
  const fs = detectSkillFewShot(topic);
  if (!fs) return "";
  const examples = fs.exampleStems
    .map((s, i) => `Example ${i + 1}: ${s}`)
    .join("\n");
  return `

NICHE-SKILL CONTEXT — read carefully before generating questions on this topic.

Topic family: ${fs.label}
Domain disambiguation: ${fs.disambiguation}

EXAMPLES of real ${fs.label} question stems (use these to anchor STYLE, TERMINOLOGY, and DIFFICULTY — DO NOT copy verbatim, and do NOT re-use the exact scenarios above):
${examples}

When generating, every question must:
- Use the precise terminology of ${fs.label} (real field names, real syntax, real product names) — never invent identifiers.
- Match the difficulty register of the examples — practitioner-level, scenario- or syntax-grounded, NOT trivia or definitions.
- Avoid generic computer-science framings that could apply to any language/platform.
`;
}
