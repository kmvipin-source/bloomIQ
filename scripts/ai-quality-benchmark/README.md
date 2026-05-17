# ZCORIQ AI Quality Benchmark Harness

A 3-step pipeline to empirically validate the AI generation pipeline against
a fixed set of ~50 production-shaped prompts, before any pilot launch.

## Why this exists

The UAT pre-pilot conditions require an empirical AI-quality benchmark:
> Run 50 real prompts through /api/generate covering: K-12 board topics,
> JEE, NEET, CAT, IELTS, niche-domain (Cobol/JCL/etc.). Have a subject-matter
> educator grade outputs on Bloom appropriateness, factual correctness,
> distractor quality, etc. Target: ≥ 85% acceptance.

The codebase already has 145 unit tests and full strict-TS coverage. What
it doesn't have is a way to answer "does the AI actually produce good
questions?". This harness fills that gap.

## Three steps, three scripts

### Step 1 — `run.mjs` — send the prompts

```bash
# Start the dev server (or point at staging):
npm run dev
# In another shell, copy your teacher JWT to .token:
echo "<jwt-from-sb-*-auth-token-cookie>" > scripts/ai-quality-benchmark/.token
# Run:
node scripts/ai-quality-benchmark/run.mjs
```

Sends each prompt in `prompts.json` through `POST /api/generate` (with the
full pipeline: SYSTEM prompt, topic grounding, Bloom verifier, dedup,
acronym disambiguation, etc.). Captures responses to
`out/<run-id>/<prompt-id>.json`.

Pauses 2 seconds between prompts (within the 5-burst rate limit). Retries
on 429 after a 30-second pause. Network failures are captured to
`<prompt-id>.error.txt` and the run continues.

### Step 2 — `grade.mjs` — generate the grading sheet

```bash
node scripts/ai-quality-benchmark/grade.mjs <run-id>
```

Produces two CSVs in `out/<run-id>/`:

  - **`grading.questions.csv`** — one row per generated question. The
    educator fills these columns:
      - `GRADE_bloom_ok` — Y if the Bloom level matches the cognitive demand
      - `GRADE_factually_correct` — Y if stem + options + explanation are factually correct
      - `GRADE_distractors_ok` — Y if the wrong options are plausible
      - `GRADE_answer_leak` — Y if the correct option's key terms are NOT in the stem
      - `GRADE_register_ok` — Y if language/difficulty matches the audience
      - `GRADE_accept` — Y if a teacher would use this question without modification
      - `GRADE_notes` — free-form

  - **`grading.coverage.csv`** — one row per prompt summarising
    delivered vs requested counts, verifier disputes, and the prompt's
    "verify" hint. The educator fills:
      - `GRADE_overall_accept` — Y if the full batch for this prompt is acceptable
      - `GRADE_overall_notes` — free-form

Open both CSVs in Excel / Numbers / LibreOffice. Fill the GRADE_ columns.
Save as CSV (not xlsx).

### Step 3 — `summarize.mjs` — compute the verdict

```bash
node scripts/ai-quality-benchmark/summarize.mjs <run-id>
```

Reads the filled CSVs, computes per-dimension and per-category acceptance
rates, compares against the 85% pass bar, writes:

  - `out/<run-id>/SUMMARY.md` — human-readable verdict
  - `out/<run-id>/SUMMARY.json` — machine-readable (for CI gates)

Exit code 0 = pass, 2 = fail.

## What the prompt set covers

50 prompts spanning:

  - **K-12 board** — math, science, English, history, geography, civics, probability, matrices
  - **JEE Main / Advanced** — physics (rotational, EM induction), chemistry (bonding), math (integrals)
  - **NEET** — biology (reproduction, genetics), chemistry (coordination), physics (optics)
  - **CAT** — quant (number systems, geometry), verbal (RC), DI/LR (line charts)
  - **UPSC, GMAT, GRE, IELTS, SAT, BITSAT** — at least one prompt each
  - **Disambiguation traps** — LCM, ROI, AC, PI, F (single letter)
  - **Niche domains** — COBOL PERFORM, ISO 8583 data elements, BGP route reflectors, DB2 cursors
  - **Mock-paper triggers** — bare exam names (JEE, NEET)
  - **Cross-validation traps** — off-topic prompts (French Revolution under JEE), tricky Bloom (Remember under CAT)
  - **Edge cases** — single-letter topic, audience-bias contradictions, sub-topic focus, additional_focus

Each "verify" field in `prompts.json` documents what the grader should
specifically look for. Examples:
  - "MUST be math/arithmetic. If output is Linear/Circular Motion → CRITICAL FAIL (acronym disambiguation broken)."
  - "Bare exam name as topic should trigger exam-style framing — questions look like JEE paper, NOT meta-questions ABOUT JEE."

## Adapting the benchmark

Add new prompts by appending to `prompts.json`. Each entry needs at minimum:
  - `id` (string, must be unique)
  - `category` (string, for per-category roll-up)
  - `topic` (string)
  - `bloom_levels` (array of Bloom strings)
  - `per_level` (number)
  - `source` (one of "topic_only" / "topic_syllabus" / "notes" / "image")

Optional:
  - `exam_goal` (string slug — affects audience defaults)
  - `teaching_context` (string slug — drives the AI's register + cross-checks)
  - `numerical_percent` (0-100)
  - `audience_level` ("beginner" / "practitioner" / "expert" / null)
  - `sub_topics` (array of strings)
  - `additional_focus` (free text)
  - `verify` (free-text hint for the grader)

## Cadence

This benchmark should be re-run:
  - Before any pilot launch.
  - Before any broad public launch.
  - After every change to the SYSTEM prompt in `app/api/generate/route.ts`.
  - After every change to `lib/aiClient.ts` or `lib/gemini.ts` or `lib/groq.ts`.
  - Monthly during the pilot to detect regression.

Save the SUMMARY.json output as a baseline. Diff new runs against the
baseline to catch quality regressions early.
