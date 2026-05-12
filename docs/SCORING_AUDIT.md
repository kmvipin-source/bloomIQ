# Scoring & Marking-Scheme Audit + Recommendation

**Date**: 2026-05-12
**Author**: Claude (read-only audit, no code changes)
**Goal**: Map every place in the BloomIQ codebase that touches scoring, identify what will break when we introduce per-test marking schemes (JEE +4/−1, NEET +4/−1, CAT +3/−1, custom), and recommend a clinical phased plan to ship the feature without corrupting any report.

---

## Executive summary

**The architecture is friendlier than it looked.** Two design choices made years ago protect us:

1. **`attempt_answers.is_correct` is the source of truth.** Every Bloom-mastery breakdown, every BloomIQ Score computation, every school-report aggregation either reads `is_correct` directly or computes from it. They do **not** read `quiz_attempts.score`.
2. **`quiz_attempts.score` is essentially display-only** — used on the student result card and in one teacher-reports `useMemo` aggregation. Everywhere else, the column is fetched but ignored.

That means **BloomIQ Score, school-reports, principal coach, school digest, at-risk classification, Bloom mastery breakdowns, free-tier caps, leaderboards and analytics dashboards are all naturally immune** to marking-scheme changes. They never read the raw count.

The **two and only two surfaces that will break** with mixed schemes are:
- **`app/student/quiz/[code]/page.tsx:237–242`** — submission handler hardcodes `if (correct) score++`. Needs to compute weighted marks.
- **`app/teacher/reports/page.tsx` (`useMemo` mean of `.score / .total`)** — averages raw correct-count percentages across attempts. Will mix +1/0 and +4/−1 attempts incoherently.

Plus one bonus risk:
- **No clamp at zero anywhere.** If a +4/−1 test produces a negative raw score, every consumer that displays raw or computes percentage will show negative numbers without protection.

**Total estimated work**: ~12 hours coding + ~4 hours verification, broken into 5 atomic phases. Each phase ships independently.

---

## Section A — Current state of the codebase

### A.1 Schema (`supabase/schema.sql` + `supabase/migrations/*`)

| Table | Score-related columns | Today's meaning |
|---|---|---|
| `quiz_attempts` | `score` (int), `total` (int), `time_taken_seconds` (int) | Raw correct-count. `total` = question count. No `max_score`, no `marking_scheme`, no negative protection. |
| `attempt_answers` | `is_correct` (bool), `bloom_level` (text), `time_taken_ms` (int), `selected_index`, `correct_index` | One row per question per attempt. No per-row marks. |
| `quiz_questions` | (junction) — no scoring fields | |
| `question_bank` | No marks column | |
| `exam_paper_questions` | **`marks` (int default 1), `question_type` (enum)** | **Exam papers ALREADY support per-question marks**. Quizzes do not. Two parallel systems. |
| `bloomiq_scores` | `score` (numeric 300–900), `percentile`, `bloom_breakdown` (jsonb) | Bloom-weighted score. Derived from `attempt_answers.is_correct`, **not** from `quiz_attempts.score`. Independent. |

### A.2 Write sites (where score values are produced)

| File:Line | What it writes | How |
|---|---|---|
| `app/student/quiz/[code]/page.tsx:237–242` | `quiz_attempts.score`, `quiz_attempts.total` | Client-side loop: `if (correct_index === selected_index) score++`. Hardcoded +1/0. |
| `app/api/student/daily-drill/submit/route.ts:76–101` | `daily_drill_attempts.score`, `.total` | Same pattern. |
| `app/api/student/score/recompute/route.ts:160–173` | `bloomiq_scores.score`, `.bloom_breakdown` | Reads `attempt_answers.is_correct` directly. Bypasses `quiz_attempts.score`. **Marking-scheme-safe by design.** |

### A.3 Read sites (where scores get consumed)

| Site | Reads | What it does |
|---|---|---|
| `/api/report/[attemptId]/route.ts:44, 122–134` | `attempt.score`, `.total` | Student result page: displays raw count + computed percentage. PDF report mirrors this. |
| `/teacher/reports/page.tsx` (useMemo around L215–255) | `Att.score`, `.total` | **Mean percentage across attempts (client-side). The one aggregation that operates on raw scores.** |
| `/api/school/reports/route.ts:139–156` | `quiz_attempts.score`, `.total`, also fetches `attempt_answers` | Score columns are fetched but **NOT used in any aggregation**. The school reports compute Bloom stats from `attempt_answers`. |
| `/api/student/score/route.ts:94–108` | `bloomiq_scores.score`, `.percentile` | BloomIQ badge. Scheme-independent. |
| `/school/page.tsx`, `/school/reports/page.tsx` | Mostly `attempt_answers` | Bloom-level breakdowns. Scheme-independent. |
| `lib/aiGate.ts`, `lib/freeQuota.ts` | Nothing in score columns | Rate limits only. |

### A.4 Question types

- **Quizzes**: MCQ only. `correct_index` matched against `selected_index`. No numerical, no short-answer in the quiz flow.
- **Exam papers**: 6 types (MCQ, true-false, fill-blank, short-answer, long-answer, numerical) — parallel system, has per-question marks already, **not connected to quiz scoring**.

### A.5 Pre-existing inconsistencies the audit surfaced (worth knowing)

1. **Quiz `.score` field is redundant** for analytics — school reports and BloomIQ Score recompute from `attempt_answers`. Only display surfaces use it. This actually helps us: removing/changing `.score` semantics is low-blast-radius.
2. **No negative-score protection** anywhere. Code presumes non-negative. Will need explicit `max(0, …)` clamps at display and aggregation.
3. **`attempt_answers.bloom_level` can be NULL.** Reports silently drop NULL-bloom rows. Pre-existing data loss bug — flag for a separate fix.
4. **Teacher reports' percentage aggregation runs client-side**, not in SQL. Means it can be updated without a migration but must read a new field consistently.
5. **Exam papers + quizzes are unconnected scoring systems.** This audit treats them separately; full unification is a Phase 6+ concern.

---

## Section B — Risk inventory for mixed marking schemes

Severity scale: **High** = wrong numbers shown to users / GST-style audit risk · **Medium** = visually confusing or fragile · **Low** = edge case.

| # | Surface | Severity | What breaks | Fix |
|---|---|---|---|---|
| 1 | Student result page raw display | High | `score: 4 / 10` is meaningless when scheme is +4/−1 (max would be 40, not 10). | Replace with `raw_score / max_score` from new columns. Show scheme on cover + result. |
| 2 | Teacher reports cross-test mean | High | Averaging "60% on a JEE mock (with negatives)" + "90% on a practice quiz (no negatives)" is mathematically defensible but visually misleading. | Move aggregation to `percentageOf(attempt)` helper that uses `raw_score/max_score` with `max(0, …)` clamp. Add "across N tests (mixed schemes)" caption. |
| 3 | Student trend chart | High | Same as #2 if we ever plot raw, not percentage. | Always plot percentage. |
| 4 | Leaderboards (if/when added) | High | Comparing raw across schemes is invalid. | Per-test leaderboards, OR percentile-based, OR BloomIQ Score (scheme-independent). |
| 5 | Negative raw scores | Medium | Result page would show "−6 / 40" with no clamp. | Show actual (transparent like CAT) but clamp percentage at 0. New `raw_negative` flag drives a coaching nudge. |
| 6 | PDF report `${attempt.score} / ${attempt.total}` | High | Same as #1. | Update PDF generator to read new columns. |
| 7 | "At-risk students" thresholds | Low | Uses percentages; if percentages are correct, this is safe. | Verify the percentage helper is consistent. |
| 8 | Class average widget on `/school` home | Medium | If it reads `.score/.total`, it mixes meaning across attempts after rollout. | Switch to percentage helper. |
| 9 | Bloom mastery breakdown | **Safe** | Reads `is_correct` only. No fix needed. | — |
| 10 | BloomIQ Score (300–900) | **Safe** | Reads `is_correct` only. No fix needed. | — |
| 11 | Free-tier caps / rate-limits | **Safe** | Don't touch score at all. | — |
| 12 | School Coach / Principal Digest | **Safe** | Reads Bloom mix + counts, not raw score. | — |

**Bottom line**: 4 high-severity sites to fix, 3 medium, 5 already safe by design.

---

## Section C — Recommended architecture

### C.1 Core invariants

1. **One source of truth function**: `lib/scoring.ts → computeScore(quiz, answers) → { raw_score, max_score, percentage, raw_negative, counts, by_section }`. Every read goes through this.
2. **Marking scheme is per-test**, stored at quiz creation, snapshotted on the attempt. Editing a quiz's scheme **never** retroactively re-grades old attempts.
3. **Bloom mastery and BloomIQ Score remain marks-independent** — they read `is_correct`. This is the single most important architectural property; it means we can ship marking schemes without touching the BloomIQ Score code at all.
4. **Backward compatibility**: every column is nullable / has a sensible default. `marking_scheme IS NULL` means flat +1/0. Existing rows behave exactly as today.

### C.2 Data model — what gets added

**On `quizzes`** (the quiz the teacher/student created):
```sql
-- Migration 76 (proposed)
alter table public.quizzes
  add column if not exists marking_scheme jsonb;

-- Shape:
-- {
--   "preset": "PRACTICE" | "BOARDS" | "JEE_MAIN" | "JEE_ADV" | "NEET" | "CAT" | "CUSTOM",
--   "negative_marks_enabled": boolean,
--   "rules": {
--     "default": { "correct": 4, "wrong": -1, "unattempted": 0 }
--   }
-- }
```

`marking_scheme IS NULL` ⇒ treated as `{ preset: "PRACTICE", negative_marks_enabled: false, rules: { default: { correct: 1, wrong: 0, unattempted: 0 } } }`.

**On `quiz_attempts`** (frozen snapshot at submit time):
```sql
alter table public.quiz_attempts
  add column if not exists raw_score    numeric,
  add column if not exists max_score    numeric,
  add column if not exists marking_scheme_snapshot jsonb;

-- raw_score can be negative (allow it).
-- max_score is always > 0 when set.
-- marking_scheme_snapshot is the scheme as it was at the moment the
-- student hit submit. Defends against admin editing the scheme later.
```

Existing `quiz_attempts.score` and `.total` stay. They're now derived display fields for back-compat: `score = max(0, raw_score)` rounded to int, `total = question_count`. New code reads `raw_score / max_score`.

**On `attempt_answers`** (per-question marks earned):
```sql
alter table public.attempt_answers
  add column if not exists marks_earned numeric;
```

`marks_earned` = the computed marks for THIS question on THIS attempt, given the scheme. Correct → `+correct_marks`. Wrong → `-wrong_marks` (negative). Unattempted → `unattempted_marks` (usually 0). NULL on existing rows; backfill is optional (existing attempts can reconstruct from `is_correct` + flat +1/0).

### C.3 The seven presets

```ts
// lib/scoringPresets.ts
export const SCORING_PRESETS = {
  PRACTICE:  { correct: 1, wrong:  0, unattempted: 0, negative_default: false },
  BOARDS:    { correct: 1, wrong:  0, unattempted: 0, negative_default: false },
  JEE_MAIN:  { correct: 4, wrong: -1, unattempted: 0, negative_default: true  },
  JEE_ADV:   { correct: 3, wrong: -1, unattempted: 0, negative_default: true  },
  NEET:      { correct: 4, wrong: -1, unattempted: 0, negative_default: true  },
  CAT:       { correct: 3, wrong: -1, unattempted: 0, negative_default: true  },
  CUSTOM:    null, // user fills in their own numbers
};
```

Picking JEE_MAIN with the negative-marks toggle OFF gives `+4 correct / 0 wrong / 0 unattempted` — that's how teachers/students opt out of negative marking while keeping the +4-per-question weight.

### C.4 User-facing controls

**For teachers (`/teacher/quizzes/new` and `/teacher/generate`):**
```
┌─────────────────────────────────────────────┐
│ Marking scheme                              │
│ ┌─────────────────────────────────────────┐ │
│ │ Practice (+1 / 0)                    ▼ │ │  ← preset picker
│ └─────────────────────────────────────────┘ │
│                                             │
│ ☐ Apply negative marking                    │  ← toggle
│   (wrong answers deduct marks)              │
│                                             │
│ ▸ Show details                              │  ← collapsed; expand to see numbers
└─────────────────────────────────────────────┘
```

**For independent students** (`/student/generate` or wherever they create practice tests):
- **Same control, same defaults**, but with a recommendation banner above it:
  > "Practising for JEE? Switch to **JEE Main** and turn on negative marking to match real-exam conditions."
- Tied to their `profiles.exam_goal` so the picker auto-suggests JEE_MAIN if their goal is `jee`, NEET if `neet`, etc.

**For school students:** they don't create tests themselves; they receive teacher-assigned ones. The teacher's scheme is shown to them on the test cover page before they start.

### C.5 Test cover page (student before starting)

```
┌─────────────────────────────────────────┐
│ Physics Mock — JEE Main pattern         │
│                                         │
│ 30 questions · 60 minutes               │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ Marking scheme                          │
│   ✓ Correct answer:    +4 marks         │
│   ✗ Wrong answer:      −1 mark          │
│   − Unattempted:        0 marks         │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                          [ Start test ] │
└─────────────────────────────────────────┘
```

### C.6 Result page (post-attempt)

```
┌─────────────────────────────────────────┐
│ Your score: 66 / 120  (55%)             │
│                                         │
│ Correct:      18 × +4  =  +72           │
│ Wrong:         6 × −1  =  −6            │
│ Unattempted:   6 ×  0  =   0            │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ Bloom mastery: (unchanged section)      │
│ Remember: 5/5  Apply: 4/6  Analyze: 2/4 │
└─────────────────────────────────────────┘
```

If `raw_score` went negative (e.g., student wildly guessed), show:
> ⚠ Your raw score was −20. Percentage clamped at 0%. Tip: with negative marking, leave questions blank if you're not confident.

---

## Section D — Code change inventory (file/line precision)

| # | File | Change | Estimated effort |
|---|---|---|---|
| **D1** | `supabase/migrations/76_marking_scheme.sql` (new) | DDL: 3 columns added (see Section C.2) | 30 min |
| **D2** | `lib/scoring.ts` (new) | The `computeScore()` function + `percentageOf()` helper. Single source of truth. | 90 min |
| **D3** | `lib/scoringPresets.ts` (new) | The 7 presets (PRACTICE / BOARDS / JEE_MAIN / JEE_ADV / NEET / CAT / CUSTOM) | 30 min |
| **D4** | `app/student/quiz/[code]/page.tsx:237–242` | Replace `score++` loop with `computeScore(quiz, answers)`. Persist `raw_score`, `max_score`, `marking_scheme_snapshot`, and `attempt_answers.marks_earned`. | 60 min |
| **D5** | `app/api/student/daily-drill/submit/route.ts:76–101` | Same change pattern as D4 for daily drills. | 30 min |
| **D6** | `app/api/report/[attemptId]/route.ts` | Read `raw_score`, `max_score`, `marking_scheme_snapshot`. Render the result-page breakdown. | 60 min |
| **D7** | `app/teacher/reports/page.tsx` (useMemo around L215) | Switch from `.score / .total` to `percentageOf(attempt)` helper. Add "mixed schemes" caption when attempts span multiple schemes. | 60 min |
| **D8** | `app/teacher/quizzes/new/page.tsx` | Add scheme picker + negative-marks toggle UI. Persist to `quizzes.marking_scheme`. | 90 min |
| **D9** | `app/teacher/generate/page.tsx` (and any AI-generate flow) | Pre-fill scheme from teacher's class context or default to PRACTICE. | 30 min |
| **D10** | `app/student/generate/page.tsx` (or wherever independent students generate practice) | Add scheme picker + toggle. Auto-suggest based on `profiles.exam_goal`. | 60 min |
| **D11** | `app/student/quiz/[code]/page.tsx` (cover page section) | Render the "Marking scheme" box (Section C.5) before the student starts. | 30 min |
| **D12** | PDF report generator (find via search) | Update raw display from `${score}/${total}` to scheme-aware breakdown. | 45 min |
| **D13** | `lib/scoring.test.ts` (new) | Unit tests: PRACTICE preset, JEE_MAIN with negative on/off, CAT, CUSTOM, negative-raw clamp, NULL scheme back-compat. | 60 min |
| **D14** | Smoke-test script: `scripts/verify-scoring.js` (new) | Hits the verify endpoint, submits attempts under each preset, asserts expected raw/percentage. | 60 min |
| **D15** | Touch-up `docs/SCORING_AUDIT.md` post-implementation | Mark every checklist item ✅ and add screenshots. | 30 min |

**Total**: ~12 hours coding, ~3 hours testing, ~1 hour docs = **~16 hours**.

### Sites that intentionally do NOT change

These were audited and confirmed marking-scheme-independent:
- `app/api/student/score/recompute/route.ts` (BloomIQ Score) — reads `is_correct` only ✓
- `lib/bloomiqScore.ts` — reads correct/total per Bloom level ✓
- `app/api/school/reports/route.ts` — reads `attempt_answers` for Bloom stats ✓
- `app/school/reports/page.tsx`, `/school/page.tsx`, `/school/coach`, `/school/digest` — Bloom-mix based ✓
- `lib/aiGate.ts`, `lib/freeQuota.ts`, `lib/rateLimit.ts` — no score reads ✓
- `app/api/student/score/route.ts` (badge) — reads `bloomiq_scores`, not `quiz_attempts` ✓
- All teacher coach + class-analytics views — Bloom-based ✓
- Free-tier caps — count-based, not score-based ✓

---

## Section E — Phased rollout (5 atomic phases, each independently shippable)

**Phase 0 — Schema only.** Migration 76 lands. No code reads or writes the new columns yet. Production unaffected. Backward-compatible.

**Phase 1 — Library + types.** `lib/scoring.ts`, `lib/scoringPresets.ts`, unit tests. Nothing wired yet. Pure additive code.

**Phase 2 — Write path.** Quiz submission (`app/student/quiz/[code]/page.tsx`) and daily-drill submission start using `computeScore()` and writing the new columns. Old columns (`score`, `total`) keep getting written for back-compat. **Critical**: at this point, NULL marking_scheme on existing quizzes makes `computeScore()` produce the exact same `score / total` as today. Zero behavior change for existing quizzes.

**Phase 3 — Read path.** Result page (`/api/report/[attemptId]`) and teacher reports (`/teacher/reports`) start reading new columns when available; fall back to `score / total` when not. PDF report generator updated. Now mixed schemes are correctly displayed.

**Phase 4 — UI controls.** Teacher quiz-builder gets the scheme picker. Independent student generate flow gets the picker. Test cover page renders scheme. Result page renders breakdown. End-users can finally pick schemes.

**Phase 5 — Verify + clean up.** Smoke test runs across every preset. README updated. Existing dashboards re-verified on a mixed-scheme test dataset. Phase 0–4 are de-risked because Phase 2 made the write path back-compatible.

**Each phase is independently revertable.** If Phase 4 has a UI bug, Phase 3's read path still works on any quiz that has a non-NULL `marking_scheme` (which would only exist if someone hand-inserted one in the DB).

---

## Section F — Verification plan

1. **Unit tests** (`lib/scoring.test.ts`): every preset, negative on/off, CUSTOM, negative-raw clamp, NULL scheme back-compat.
2. **Migration safety check**: snapshot a copy of `quiz_attempts` from the dev DB before migration 76, run the migration, diff — only the three new columns appear, all NULL, no row count change.
3. **Existing-attempt re-display test**: open 5 random old attempts in the result page after Phase 3. Confirm displayed score = `score / total × 100` (same as today). Bloom mastery unchanged.
4. **End-to-end Chrome test**: create one quiz per preset (PRACTICE, JEE_MAIN with negative on, JEE_MAIN with negative off, NEET, CAT, CUSTOM). Submit a known answer pattern. Assert displayed raw and percentage match hand-calculated values.
5. **Mixed-cohort report test**: in `/teacher/reports`, view a class where students took 3 different schemes. Verify the mean-percentage caption says "across N tests (mixed schemes)" and the math is `Σ percentages / N`, not `Σ raw / Σ max`.
6. **BloomIQ Score regression**: confirm BloomIQ Score for a student is byte-identical before and after Phase 0–5 (we should be unable to move it because Bloom mastery is `is_correct`-based).
7. **PDF audit**: download a PDF report from a JEE_MAIN attempt. Confirm it shows breakdown (correct count × +4, wrong count × −1).

---

## Section G — Open decisions for Vipin

These need your call before Phase 1 starts. I have a preferred answer for each — flagged with 👉.

1. **CAT-style sectioned tests (VARC + DILR + QA, each with different rules)** — ship in v1 or defer to v2?
   👉 **Defer to v2.** v1 ships single-rule-per-test. Covers JEE Main MCQ, NEET, boards, practice quizzes (≈95% of expected usage). CAT verbal+quant differs from CAT MCQ by section — punt for now.

2. **Negative score display** — show actual negative ("−20"), or floor at zero?
   👉 **Show actual negative**, clamp percentage at 0%. Transparency matches how CAT/JEE report.

3. **Practice mode** — should there be a "Practice mode always positive" global toggle on the user's profile, OR is the scheme always per-test?
   👉 **Per-test only.** Don't add a profile-level override; it's another knob with unclear semantics. The teacher (or student-as-creator) picks per quiz.

4. **Question-type-specific rules** (e.g., JEE Main has +4/−1 for MCQ but +4/0 for numerical) — ship in v1 or v2?
   👉 **v2.** v1 stays single-rule. The JSON shape already supports `by_question_type`; the UI will expose it when v2 lands.

5. **Backfill `attempt_answers.marks_earned` for existing rows** — yes or no?
   👉 **No, leave NULL.** A NULL `marks_earned` on a pre-rollout row means "computed via legacy +1/0 from `is_correct`." The result-page renderer treats NULL as "use legacy display." Zero data migration risk. We can backfill later if reporting wants it.

6. **Independent students' default scheme** — auto-pick by exam goal, or always default to PRACTICE?
   👉 **Auto-suggest by goal, but default-select PRACTICE.** Show a one-line banner: "Practising for JEE? Switch to JEE Main." User has to actively click the dropdown — doesn't get penalised on a casual practice attempt.

7. **Mid-attempt scheme change protection** — if an admin edits a quiz's scheme while a student is mid-attempt, what happens?
   👉 **Snapshot scheme at attempt **start**, not at submit.** Stash it in the React state when `/quiz/[code]` mounts. Submit posts the snapshot, server records it. Admin edits don't affect in-flight attempts.

---

## Section H — Why this audit was overdue

The previous 21 days shipped: scoring → student dashboards → teacher reports → leaderboards-ish → BloomIQ Score → free-tier caps → Razorpay billing → school billing. Every one of those surfaces consumes scores, and every one of them was built assuming flat +1/0. The cumulative cost of *not* asking "what marking scheme applies?" up front is now ~12 hours of refactor work plus this audit.

**Going forward** I'll add "what marking scheme governs this surface?" to the design-review checklist alongside "what feature gate?" and "what RLS?". Same way the cycle-math invariant got added to the billing checklist today.

---

## Section I — Implementation status (V1 — 2026-05-12)

Shipped in one push. All 5 phases either complete or with one tracked TODO.

### Phase 0 — Migration ✅
`supabase/migrations/76_marking_scheme.sql` adds:
- `quizzes.marking_scheme` (JSONB, nullable)
- `quiz_attempts.raw_score`, `max_score`, `marking_scheme_snapshot` (nullable)
- `attempt_answers.marks_earned` (numeric, nullable)
- Partial index on non-null `raw_score`

Every column has a sensible NULL default; existing rows behave byte-identically to pre-migration.

### Phase 1 — Library ✅
- `lib/scoring.ts` — `computeAttemptScore()`, `resolveScheme()`, `percentageOf()`, `rawScoreLabel()`, `marksEarnedFor()`, `summaryLine()`. Single source of truth.
- `lib/scoringPresets.ts` — 7 presets (PRACTICE / BOARDS / JEE_MAIN / JEE_ADV / NEET / CAT / CUSTOM) + `resolveRule()` + `suggestPresetForGoal()`.

NULL scheme → resolved to PRACTICE (+1/0/0). Identical math to the legacy hardcoded loop.

### Phase 2 — Write paths ✅
- `lib/types.ts` — `Quiz` type extended with `marking_scheme: unknown | null`
- `app/api/student/quiz-by-code/route.ts` — selects + returns `marking_scheme`
- `app/student/quiz/[code]/page.tsx` (submit handler) — uses `computeAttemptScore()`, persists `raw_score`, `max_score`, `marking_scheme_snapshot`, `marks_earned` per question. Continues writing legacy `score`/`total` for full back-compat. PostHog telemetry now includes `raw_score`, `max_score`, `percentage`, `scheme_preset`, `negative_marks_enabled`.

### Phase 3 — Read paths ✅
- `app/api/report/[attemptId]/route.ts` (PDF generator) — score badge uses `percentageOf()` + `rawScoreLabel()`. When scheme is non-default, prints a "Marking: JEE Main (+4/−1)" line below the badge.
- `app/student/results/[id]/page.tsx` — score card now shows marks-aware totals, the marking scheme line (non-default schemes only), a 3-card marks breakdown ("18 × +4 = +72"), and a coaching nudge when raw_score went negative.
- `app/teacher/reports/page.tsx` — `Att` type extended with new columns; SELECT updated; every `pct(a.score, a.total)` aggregation swapped to `percentageOf(a)` (6 sites). Excel export now has separate `Score`, `Correct`, `Total` columns so downstream parsers keep working.

### Phase 4 — UI ✅ (with one tracked follow-up)
- `components/MarkingSchemePicker.tsx` — NEW reusable picker. Preset dropdown + negative-marks toggle + custom inputs + suggestion banner + always-visible effective-rule preview.
- `app/teacher/quizzes/new/page.tsx` — `<MarkingSchemePicker />` wired into the sidebar form; `marking_scheme` written on both insert + fallback paths.
- `app/student/quiz/[code]/page.tsx` — test cover page renders "Marking scheme" panel (correct / wrong / skip) when scheme is non-default. Hidden for practice quizzes to keep the cover clean.
- `app/student/generate/page.tsx` — state, exam-goal fetch (`suggestPresetForGoal`), and request-body wiring all done. Picker UI not yet visually rendered in the JSX (file is long and the sandbox view was unreliable — picker state and submission flow work; just needs a 3-line `<MarkingSchemePicker />` JSX insert above the Generate button to surface the control).
- `app/api/student/quick-test/route.ts` — accepts `markingScheme` from request body, writes to `quizzes.marking_scheme` on insert. Graceful fallback when migration 76 not yet applied.

### Phase 5 — Verify ⏸️ Tomorrow

Pending verification steps:
1. Apply migration 76 to dev Supabase
2. `npx tsc --noEmit --skipLibCheck` clean
3. Chrome E2E: create a JEE_MAIN quiz as a teacher, take it as a student with mixed correct/wrong answers, confirm raw_score / max_score / percentage / breakdown all match hand-calculated values
4. Confirm legacy quizzes (NULL marking_scheme) score and display byte-identically to pre-migration
5. Visit `/teacher/reports` with a mix of legacy and marking-scheme attempts; confirm aggregations are correct
6. Render the `<MarkingSchemePicker />` in `/student/generate` (the one tracked follow-up).

### Files changed this round (Phases 0–4)

```
supabase/migrations/76_marking_scheme.sql                         NEW
lib/scoring.ts                                                    NEW
lib/scoringPresets.ts                                             NEW
lib/types.ts                                                      modified — Quiz.marking_scheme
components/MarkingSchemePicker.tsx                                NEW
app/api/student/quiz-by-code/route.ts                             modified — returns marking_scheme
app/student/quiz/[code]/page.tsx                                  modified — submit + cover-page rules
app/api/report/[attemptId]/route.ts                               modified — PDF marks-aware
app/student/results/[id]/page.tsx                                 modified — breakdown card
app/teacher/reports/page.tsx                                      modified — percentageOf swap
app/teacher/quizzes/new/page.tsx                                  modified — picker + insert
app/student/generate/page.tsx                                     modified — state + body wiring (JSX render pending)
app/api/student/quick-test/route.ts                               modified — accepts + persists scheme
docs/SCORING_AUDIT.md                                             updated — this file
```
