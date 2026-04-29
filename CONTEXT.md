# BloomIQ — session context (last updated 2026-04-28, well past midnight at this point)

> Working notes for the next session. README has been updated this round.
> User: Vipin (kmvipin@gmail.com).

## Where we stopped

Built **four killer features** for independent students. All four are
unique-to-BloomIQ because they sit on top of Bloom-level data nothing else
in the ed-tech space has.

1. **Teach-Back** at `/student/teach-back` — Feynman-style explain-it-back.
   The student types a topic + their explanation; AI grades on Bloom's rubric
   (0–5 per level), shows strengths/gaps, and asks one Socratic follow-up.
2. **Misconception Detective** at `/student/misconceptions` — every wrong MCQ
   gets diagnosed into a *specific* mental error ("you confused photosynthesis
   with respiration"), logged with strike counts, and a one-click "Drill this"
   generates a 3-question micro-quiz built to break it. Wired into
   `/student/results/[id]` via a "Diagnose my mistakes" panel.
3. **Bloom Climber** at `/student/climber` — daily 5-min streak. 3 questions
   all at one Bloom level on one topic. Nail 2/3 to master the rung; next
   level unlocks. Skip a day, streak resets.
4. **Past-Paper X-Ray** at `/student/xray` — upload last year's paper (text
   or image). AI tags every question by Bloom level + topic, shows a heatmap
   and 5 directive study targets ("Drill applying X to Y problems").

All features are gated behind one new migration: `12_killer_features.sql`.
Every API route uses the same auth pattern as the rest of the app
(`getBearer` → `supabaseServer(token)` → `auth.getUser()`).

## Second pass: four competitive-exam features

Pivoted late in the session after realizing Teach-Back is foundation-level
(school students, conceptual subjects) but not the right fit for MCQ-heavy
competitive prep (JEE/NEET/CAT). Built four more, all unique-to-BloomIQ
because they sit on top of Bloom-level data:

1. **Speed-Accuracy Trainer** at `/student/speed` — each question gets a
   target time based on its Bloom level (Remember 30s, Understand 45s, Apply
   75s, Analyze/Evaluate 90s, Create 120s). End-of-session 4-quadrant verdict
   (Fast+Right / Slow+Right / Fast+Wrong / Slow+Wrong) is the diagnostic JEE
   coaches drill for years.
2. **Distractor Trap Detector** at `/student/traps` — classifies wrong picks
   into 9 examiner-trap types (`unit_confusion`, `sign_error`, `not_misread`,
   `off_by_one`, `plausible_formula`, `partial_application`,
   `mismatched_units`, `distractor_close_value`, `definition_swap`). Wired
   into the results page next to Misconception Detective. Misconception says
   "your understanding is wrong"; trap says "your understanding is fine but
   the examiner's wording got you."
3. **Mock Rank Predictor** at `/student/rank` — converts any score to an AIR
   estimate using Normal-CDF approximation with per-exam baselines. Persists
   prediction history. Independent-only; school students see a friendly notice.
4. **Doubt-Clearing AI Tutor** at `/student/tutor` — stateless Socratic chat,
   no DB persistence in v1. Optionally anchored to a specific question via
   `?question_id=`. System prompt enforces "ask before answering."

All four gated behind `13_competitive_exam_features.sql`.

Three of the four (Speed-Accuracy, Trap Detector, Tutor) also surface for
school students on `/student` (school view) — Mock Rank Predictor is skipped
because school students are graded by their teacher, not a national rank.

### Files added this round

- `supabase/migrations/13_competitive_exam_features.sql`
- `app/api/speed/start/route.ts`, `app/api/speed/submit/route.ts`
- `app/api/traps/diagnose/route.ts`
- `app/api/rank/predict/route.ts`
- `app/api/tutor/chat/route.ts`
- `app/student/speed/page.tsx`
- `app/student/traps/page.tsx`
- `app/student/rank/page.tsx`
- `app/student/tutor/page.tsx`

### Surgical edits this round

- `app/student/page.tsx` — added "Ace competitive exams" 4-tile grid for
  independent students; "Boost your test-taking" 3-tile strip for school
  students.
- `app/student/results/[id]/page.tsx` — added two more panels next to
  Misconception Detective: "Find my traps" (calls `/api/traps/diagnose`) and
  "Predict my rank" (calls `/api/rank/predict` with selectable exam type).
- README — top banner, migrations row, file map, and a new "competitive-exam
  features" section.

### Sidebar — intentionally NOT touched this round

User flagged earlier that I'd been creating login-side issues. I committed to
not touching `Sidebar.tsx`, `app/layout.tsx`, signup/login, or
`lib/supabase/`. Honored that this round. The four new pages are reachable
through dashboard tiles only. If we want sidebar entries too, that's a small
follow-up — the user just needs to ask.

## Third pass: Exam Sprint Mode

Added countdown + adaptive daily mission. Student picks an exam (JEE Main /
NEET / CAT / Custom) and a date; dashboard then shows a color-tiered
countdown banner. The `/student/sprint` page is the hub — setup form OR
countdown + 3-task mission tuned to phase (Foundation / Practice / Sprint /
Final week). Each task carries a `done` flag computed from real activity in
existing feature tables today, so no per-day completion table is needed.

### Sidebar cleanup also done this round

User asked me to clean up the sidebar — moved all 8 "Boost your learning" +
"Ace competitive exams" features off the sidebar (they're dashboard tiles
now). Sidebar for independent students is back to its original 4 items:
Home · New Test · My Tests · My Progress. Done via a single full-file Write
(not Edit chains) per the lesson learned earlier.

### Files added this round

- `supabase/migrations/14_exam_sprint.sql`
- `app/api/sprint/save/route.ts`
- `app/api/sprint/today/route.ts`
- `app/student/sprint/page.tsx`

### Surgical edits this round

- `app/student/page.tsx` — added sprint state + a try/catch direct-fetch of
  `exam_sprint_settings` so missing migration 14 silently degrades. Inserted
  countdown banner (color tiers: emerald > 30d, orange 30–7d, red < 7d) and
  a quiet "Got an exam coming up?" invite when not configured. Added a
  full-width Exam Sprint tile at the top of the "Ace competitive exams" tile
  grid.
- `components/Sidebar.tsx` — full-file Write to drop the 4 killer-feature
  entries from STUDENT_INDEPENDENT. Independent sidebar is now 4 items.
- README — migrations row, file map, and a new Exam Sprint section.

## Fourth pass: three retention features (the score-improvement levers)

Built three more on top of the existing eleven. These specifically target
the levers that move the needle on actual scores: visual concept learning,
spaced repetition, and metacognitive confidence calibration.

1. **Concept Visualizer** at `/student/visualizer` — animated SVG-frame
   slideshow. The student types a concept, the AI returns 3–5 simple
   labeled SVG frames + per-frame captions, and the page cross-fades
   between them with auto-advance + manual prev/play/next/restart controls.
   The "animation" comes from the sequence + transitions, not from
   AI-generated SMIL/CSS animations (which are fragile). SVGs are
   server-sanitised (script/foreignObject/iframe/on* handlers/javascript:
   URLs stripped) before persisting, then rendered via
   `dangerouslySetInnerHTML`.

2. **Memory Tune-Up** at `/student/memory` — SM-2 spaced repetition keyed by
   `question_id`. Anki-style 4-button rating UI (Again / Hard / Good /
   Easy). Idempotent enqueue. "Add my mistakes to memory" button on the
   results page bulk-enqueues every wrong answer from a just-completed
   attempt; clicking it twice doesn't dupe.

3. **Confidence Calibration** at `/student/calibration` — pre-answer
   confidence picker integrated into the Speed-Accuracy Trainer (one tap:
   Guess / Probably not / Probably / Sure). Profile page shows a
   stated-vs-actual chart per band, an overall calibration gap, and a
   negative-marking strategy ("attempt only Sure picks on JEE Main -1/+4
   papers — your accuracy at Probably is below break-even"). Speed Trainer
   logs events at end-of-session via `/api/calibration/log`.

All three gated behind `15_visualizer_srs_calibration.sql`. The dashboard
tile group is "Learn deeper, retain longer" (third group, after "Boost your
learning" and "Ace competitive exams").

### Files added this round

- `supabase/migrations/15_visualizer_srs_calibration.sql`
- `app/api/visualizer/create/route.ts`
- `app/api/srs/enqueue/route.ts`, `app/api/srs/due/route.ts`, `app/api/srs/review/route.ts`
- `app/api/calibration/log/route.ts`
- `app/student/visualizer/page.tsx`
- `app/student/memory/page.tsx`
- `app/student/calibration/page.tsx`

### Surgical edits this round

- `app/student/page.tsx` — added a third tile group "Learn deeper, retain
  longer" with three tiles (Visualizer, Memory, Calibration). Imported
  `Film`, `Brain`, `Gauge` icons.
- `app/student/results/[id]/page.tsx` — added "Add my mistakes to memory"
  button + result panel. State + handler `enqueueMistakes()` calls the SRS
  enqueue API. Imported `Brain` icon.
- `app/student/speed/page.tsx` — added a 4-button confidence picker shown
  ABOVE the answer options (locks once an answer is picked, so the rating
  reflects pre-answer gut). New `confidences` state array, new
  `rateConfidence` function, and best-effort `/api/calibration/log` call
  appended to the existing submit flow.
- README — migrations row, file map, latest-session banner, full feature
  section.

## Fifth pass: commercial-unlock features + Climber consolidation

Three more features built and one merged out:

1. **Parent Dashboard** (`/parent/[token]`) — magic-link parent view. Student
   creates a link from `/student/parent`, shares via WhatsApp, parent opens
   read-only dashboard with no signup. Token IS the credential, validated
   server-side. Designed deliberately to NOT touch the auth surface.

2. **Voice AI Teacher** (`/student/voice-teacher`) — Web Speech API voice
   in/out. Hands-free study. Reuses `/api/tutor/chat`. Has an animation
   panel that lazy-loads Concept Visualizer for the last user message.
   Browser support: Chrome/Edge/Safari. Falls back gracefully where
   unsupported.

3. **Concept Knowledge Graph** (`/student/graph`) — hand-rolled SVG layout
   (no graph library deps). Nodes are arranged in concentric mastery rings;
   most-uncertain topics get prime radial real estate. Edges are AI-inferred
   prerequisite/related arrows. 24h cache on the build.

4. **Bloom Climber merged into Memory Tune-Up.** Climber's streak counter
   now lives on the Memory page (re-uses the existing
   `bloom_climber_streaks` row, no schema change needed). `/student/climber`
   is now a friendly redirect stub. Tile removed from dashboard.

All three new features gated behind `16_parent_links_and_graph.sql`.

### Files added this round

- `supabase/migrations/16_parent_links_and_graph.sql`
- `app/api/parent/invite/route.ts`, `app/api/parent/data/route.ts`
- `app/api/graph/build/route.ts`
- `app/parent/[token]/page.tsx`
- `app/student/parent/page.tsx`
- `app/student/voice-teacher/page.tsx`
- `app/student/graph/page.tsx`

### Surgical edits this round

- `app/student/page.tsx` — dropped Bloom Climber tile; added Voice Teacher,
  Knowledge Graph, and "Share with a parent" tiles to the "Learn deeper,
  retain longer" group. Imported `Users`, `Mic`, `Network` icons.
- `app/student/climber/page.tsx` — replaced with a tiny redirect stub that
  pushes to `/student/memory` after a brief notice.
- `app/student/memory/page.tsx` — added a "Streak" stat card sourced from
  `bloom_climber_streaks` (the same table Climber wrote to). 4-column stats
  grid now: Streak / Due today / In queue / Reviewing now.

### Sidebar — still untouched

Per the standing commitment, `Sidebar.tsx` was not modified this round. All
three new features are reached via dashboard tiles only.

## What we fixed this session

Earlier in the session the user thought the cold-visitor pay-and-go flow had
disappeared. Investigation: the flow IS in the code (pricing → signup with
`?intent=pro&plan=...` → back to `/pricing?autostart=...` → Razorpay opens).
We did not change anything there. If it ever *seems* missing again, the most
likely culprit is Supabase email confirmation being on — that breaks the
session-establish step and the autostart useEffect bails at `if (!me) return;`.

## Files added or changed today

### Migration
- `supabase/migrations/12_killer_features.sql` — `teach_back_sessions`,
  `misconceptions` (partial unique on `(user_id, label)`),
  `bloom_climber_state`, `bloom_climber_streaks`, `past_paper_xrays`,
  `past_paper_xray_questions`. RLS on every table, scoped to `auth.uid()`.

### API routes
- `app/api/teach-back/grade/route.ts`
- `app/api/teach-back/follow-up/route.ts`
- `app/api/misconception/diagnose/route.ts`
- `app/api/misconception/drill/route.ts`
- `app/api/misconception/resolve/route.ts`
- `app/api/climber/today/route.ts`
- `app/api/climber/complete/route.ts`
- `app/api/xray/analyze/route.ts`

### Pages
- `app/student/teach-back/page.tsx`
- `app/student/misconceptions/page.tsx`
- `app/student/climber/page.tsx`
- `app/student/xray/page.tsx` + `app/student/xray/[id]/page.tsx`

### Surgical edits
- `app/student/page.tsx` — added "Boost your learning" tile grid for
  independent students between the past-paper hook and the stats row.
- `app/student/results/[id]/page.tsx` — added "Diagnose my mistakes" panel
  that calls `/api/misconception/diagnose` and shows the diagnosed list with
  a link into the Misconception Ledger.
- `components/Sidebar.tsx` — extended `STUDENT_INDEPENDENT` with four new nav
  items (Teach-Back, Misconceptions, Daily Climb, Past-Paper X-Ray).

### Docs
- `README.md` — new "Latest session" banner, migrations row for 12, full
  Independent-student killer-features section, file map updates.
- `CONTEXT.md` — this file.

## Open before next session: deployment checklist

1. **Run all five new migrations** in Supabase SQL Editor:
   - `supabase/migrations/12_killer_features.sql`
   - `supabase/migrations/13_competitive_exam_features.sql`
   - `supabase/migrations/14_exam_sprint.sql`
   - `supabase/migrations/15_visualizer_srs_calibration.sql`
   - `supabase/migrations/16_parent_links_and_graph.sql`
   After running each: `notify pgrst, 'reload schema';`
2. **Test one flow end-to-end** as an independent student:
   - `/student/teach-back` → explain a topic → see Bloom scorecard.
   - Take a quiz with at least one wrong answer → on `/student/results/[id]`
     hit "Diagnose my mistakes" → see misconception flow into
     `/student/misconceptions`.
   - `/student/climber` → start today's climb on a known topic → finish 2/3
     correct → see streak go to 1.
   - `/student/xray` → paste a few past-paper questions → see heatmap.
3. **Verify Groq API key** still has quota — all four features call Groq.

## Pre-existing TS warnings worth a future cleanup

`tsc --noEmit -p tsconfig.check.json` reports four JSX errors in
`components/Sidebar.tsx` (lines around the `<aside>`/`<nav>` block). They
predate this session and the project still compiles + runs through Next's
SWC pipeline (the dev/prod paths are fine). Worth a quick fix one day so the
strict typecheck script is green again.

## Backlog ideas worth picking up next

- **Voice mode for Teach-Back** — record audio → Whisper-style transcribe →
  same grading endpoint. Bumps the "wow factor" significantly.
- **Auto-diagnose on quiz submit** — instead of requiring the student to tap
  "Diagnose my mistakes", run it in the background after `/student/quiz/[code]`
  submits. Gate by tier so it doesn't burn AI tokens for free users.
- **Climber: weekly leaderboard** for siblings/study buddies (cohort-scoped).
- **X-Ray: multi-page PDF upload** — current image path is one-image-at-a-time;
  add a real PDF parser path so users can drop the whole paper.
- **Subscription cancel / manage UI** — still on the pre-existing backlog from
  the payment session.
- **Razorpay live-mode cutover** — only env-var swap; code is mode-agnostic.
- **`/api/checkout/webhook`** for payment resilience — same partial-index
  rule applies (use SELECT → UPDATE/INSERT, not `onConflict`).

## How to resume tomorrow

When the user says "continue bloomiq" or similar:

1. Read this file first.
2. Confirm the migration is applied — if any of the four pages 500 or show
   "schema cache" errors, run `12_killer_features.sql` and reload PostgREST.
3. Ask which thread to pick up from the backlog above (or something new).
4. Don't blow away the README — durable changes go there, working notes
   here.
