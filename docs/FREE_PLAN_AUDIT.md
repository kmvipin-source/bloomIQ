# Free plan — holistic audit & recommendation

**Date**: 2026-05-11
**Scope**: What does the Free plan actually deliver today, where are the gaps, what should it look like at launch.

---

## TL;DR — the one paragraph you need

The Free plan today is **schizophrenic**. The pricing page promises Free users a generous starter experience (AI tutor, BloomIQ Score, practice tests, weekly active path). The database says Free unlocks exactly one feature: `single_device`. The dashboard locks ~14 features behind paywall tiles. The API layer enforces feature gates on exactly **2 routes** out of ~40 student-facing routes — meaning a Free user who navigates directly to most premium features will get them for free, burning your Groq/Gemini bill. The one hard cap that does work — 3 distinct quiz attempts per 24h — is enforced via a DB trigger and applies only to one route (`/api/student/attempt-start`).

You have to pick one of two strategies before launch — there is no "compromise". Recommendation in §6.

---

## 1. What the database says Free includes

From `supabase/migrations/26_seed_initial_plans.sql`:

```
plans.slug          = 'free'
plans.tier          = 'free'
plans.price_paise   = 0
plans.period_days   = 0   (never expires)
plans.features      = ["single_device"]
plans.feature_summary = [
  "3 practice tests per day",
  "Basic Bloom report",
  "Single device only"
]
```

From `supabase/migrations/10_subscription_limits.sql`:

```
subscription_limits.free_daily_attempts = 3
```

That's it. Database-defined Free entitlements = "3 distinct quiz attempts per 24h, can use one device at a time".

For comparison, **Premium grants 14 feature keys** (`practice_tests_unlimited`, `bloom_report_full`, `report_pdf_export`, `teach_back`, `misconceptions`, `calibration`, `exam_sprint`, `speed_trainer`, `trap_detector`, `rank_predictor`, `past_paper_xray`, `ai_tutor_text`, `memory_srs`, `knowledge_graph`).

---

## 2. What the dashboard *renders* for Free

The dashboard at `/student` uses `useFeatureAccess()` to drive tile state. Behavior matches the 2026-04-30 strategy memo embedded in `lib/featureAccess.ts`:

> Free users SEE Premium + Premium Plus features but cannot USE them. Locked features render dimmed with a tier badge; clicking opens a paywall modal. This is value-disclosure: makes upgrades feel like unlocking rather than discovering.

So a Free user opening the dashboard today sees ~14 locked tiles with a "Premium" badge. Clicking any of them → paywall modal → `/pricing`.

What is **not locked** on the tile grid (and therefore actually usable on Free):

- Take a test (`/student/generate`)
- Adaptive practice (`/student/practice`) — runs against the 3/day quota
- My Tests / My Progress (`/student/tests`, `/student/progress`)
- Daily Drill (`/student/drill`) — runs against the 3/day quota
- BloomIQ Score calibration (`/student/bloom-score`) and Future-You reveal — one-time, no feature key gate
- Student Coach (`/student/coach`) — no quota, no gate

Everything else (Speed Trainer, Memory Tune-Up/SRS, Trap Detector, Misconception Detective, Past-Paper X-Ray, Mock Rank Predictor, Knowledge Graph, Teach-Back, Voice AI Teacher, Concept Visualizer, Confidence Calibration, Exam Sprint) is **dashboard-locked** for Free.

---

## 3. What the API layer actually enforces

This is where it falls apart. Server-side enforcement was audited across ~40 student-facing routes:

| Route | Server-side gate? | What it costs you per call |
|---|---|---|
| `/api/student/attempt-start` | YES — DB trigger caps at 3/day | DB only |
| `/api/visualizer/create` | YES — `requireFeature("concept_visualizer")` | Gemini |
| `/api/student/question-benchmarks` | YES — `requireFeature("cohort_benchmarks")` | DB only |
| `/api/speed/start` | **NO** | Groq |
| `/api/speed/submit` | **NO** | Groq |
| `/api/srs/due` | **NO** | DB only |
| `/api/srs/review` | **NO** | DB only |
| `/api/srs/enqueue` | **NO** | DB only |
| `/api/sprint/today` | **NO** | DB only |
| `/api/sprint/save` | **NO** | DB only |
| `/api/student/daily-drill` | **NO** (drill is not "attempt") | Groq |
| `/api/tutor/chat` | **NO** | Groq, per turn |
| `/api/teach-back/grade` | **NO** | Groq |
| `/api/teach-back/follow-up` | **NO** | Groq |
| `/api/misconception/diagnose` | **NO** | Groq |
| `/api/misconception/drill` | **NO** | Groq |
| `/api/xray/analyze` | **NO** | Groq (text or image) |
| `/api/rank/predict` | **NO** | Groq |
| `/api/flashcards` | **NO** | Groq |
| `/api/student/coach` | **NO** | Groq, per turn |

**Translation**: a Free user (or anyone reading the JS bundle and finding the URLs) can call every AI-burning route directly. The locked tile on the dashboard is the **only** thing stopping them. That is a UX defence, not a security defence.

A 30-second test from the browser console with `fetch('/api/visualizer/create', ...)` would have been caught (it is gated). The same test against `/api/speed/start` would succeed.

---

## 4. What the pricing page promises Free

From `app/pricing/page.tsx` + `app/student/expired/page.tsx`, the marketing copy says Free includes:

- 3 daily drills
- Unlimited practice tests
- Full Bloom-level mastery report
- AI-generated flashcards on focus areas
- Past-paper retention drills
- BloomIQ Score + weekly active path
- AI tutor + Performance Coach
- Adaptive practice

Cross-referenced against the DB:

| Pricing copy claim | Actually unlocked for Free? |
|---|---|
| 3 daily drills | **Wrong noun** — DB caps "quiz attempts", not "drills". They are different counters. |
| Unlimited practice tests | **No** — capped at 3/day distinct quizzes. The pricing page contradicts itself. |
| Full Bloom-level mastery report | **No DB gate either way** — works because no API enforces it. Accidental yes. |
| AI-generated flashcards | **Accidental yes** — `/api/flashcards` has no gate. Free users get unlimited Groq calls. |
| Past-paper retention drills | Ambiguous (SRS) — `/api/srs/*` has no gate, so yes by accident. |
| BloomIQ Score + weekly active path | Calibration runs; "weekly active path" is unclear. Probably partial. |
| AI tutor | **Accidental yes** — `/api/tutor/chat` has no gate. Free users get unlimited tutor turns. |
| Performance Coach | **Accidental yes** — `/api/student/coach` has no gate. |
| Adaptive practice | Yes — runs against the 3/day quota. |

**Net effect**: Free users today get *more* than the pricing page promises (because the gates aren't enforced) and *less* than the dashboard implies (because tiles are locked). Both surfaces are lying, in opposite directions.

---

## 5. The gaps that matter, ranked

**G1. Cost-of-goods bleed (P0 blocker for launch)**
Every Groq/Gemini call from a Free user costs you real money. Today, `/api/tutor/chat`, `/api/teach-back/grade`, `/api/speed/start`, `/api/misconception/diagnose`, `/api/xray/analyze`, `/api/rank/predict`, `/api/flashcards`, `/api/student/daily-drill`, `/api/student/coach`, `/api/visualizer/create` (partially gated), and `/api/student/adaptive-practice` are all ungated or weakly gated. A motivated Free user — or a competitor scraping — can drain your AI budget in hours.

**G2. Pricing page lies (P0 trust issue)**
Marketing copy ≠ database entitlement ≠ dashboard render. Anyone who upgrades expecting "Unlimited practice tests" will be confused when the DB caps them at 3/day on Free, and anyone shown a locked Speed Trainer tile will wonder why the pricing page said it was included. This becomes a refund risk in week one.

**G3. The "3 attempts/day" cap is on the wrong noun (P1)**
The DB trigger counts `distinct quiz_ids opened in 24h`. The pricing page calls it "drills". The dashboard says "tests". For a student, those are three different rituals. Cap and copy must agree.

**G4. School Pilot Coach is gated but not Student Coach (P2)**
`/api/teacher/coach` and `/api/school/coach` correctly return 402 with `checkCoachQuota`. `/api/student/coach` has no quota at all. If you intended student coach to be a feature, it should appear in `plans.features`. If you intended it to be free for everyone, the pricing page should say so.

**G5. Subscription expiry handling is half-checked (P2)**
`requireFeature` checks `expires_at` but not always `status='active'`. A subscription that's been marked inactive (refund, fraud) but not past expiry can still consume Premium features. Add explicit `status='active'` check to both server gates.

**G6. No client-side rate limit on Groq routes (P2)**
Even after gating, expect bots. Add per-user-per-minute caps on `/api/tutor/chat`, `/api/teach-back/grade`, `/api/speed/start`, `/api/xray/analyze`. Cheaper than IP blocking.

---

## 6. Recommendation — pick a Free strategy and ship it

You have two coherent options. Both work. The third option (status quo) does not.

### Option A — "Showcase Free" (recommended for Indian K-12/JEE/NEET market)

Free is a **demo trial**, not a product. Give the student enough to *taste* every feature once, then gate. Target: convert in 7 days, not retain on Free forever.

Concretely:

- **3 quiz attempts per 24h** (keep the existing DB trigger, just rename "drills" → "tests" everywhere)
- **BloomIQ Score: one-time only.** Once calibrated, locks. Recalibration is Premium.
- **AI Tutor: 5 turns/day.** New per-day counter, hard cap.
- **Teach-Back: 1 submission/day.**
- **Speed Trainer: 1 session/day** (5 questions, the smallest count).
- **Memory Tune-Up: review-only.** Enqueueing wrong answers to SRS = Premium. Doing already-queued reviews = free.
- **Past-Paper X-Ray, Trap Detector, Misconception Detective, Rank Predictor, Visualizer, Voice Teacher, Knowledge Graph, Confidence Calibration profile = locked**, render dimmed on dashboard with paywall.
- **Flashcards: 5/day.**

Why this works for the Indian market: parents are paying ₹500-₹5000/month to Allen/Aakash/Physics Wallah. ₹99/month for an AI-native alternative is a no-brainer *once they've tasted the tools*. The "Free forever" model that works for B2C SaaS in the US (Notion, Figma) doesn't fit a 6-month exam-prep timeline. Free's job is to convert, not retain.

### Option B — "Generous Free, narrow paid wedges"

Free is a **functional product**. Paid users buy depth and removal of friction.

Concretely:

- **Unlimited practice tests** (drop the 3/day cap entirely)
- **AI Tutor: 20 turns/day**, then "Premium for unlimited"
- **Speed Trainer, Teach-Back, Memory Tune-Up, BloomIQ Score: unlimited**
- **Premium = Past-Paper X-Ray, Trap Detector, Misconception Detective, Rank Predictor, Knowledge Graph, Concept Visualizer, Voice Teacher, Confidence Calibration Profile** (the diagnosis/competitive-exam suite)

Why this could work: differentiates on diagnostic insight, which is what Indian competitive aspirants pay 10× more for at coaching centres. Aakash doesn't sell more practice; they sell ranking/analysis. You mirror their wedge.

Why it might not: AI inference costs at Groq pricing are ~₹0.02-0.05/call. 1000 Free users × 50 calls/day = ₹1000-2500/day burn. At ₹99/mo conversion, you need >25 paying users per 1000 Free to break even on inference alone — before storage, salaries, marketing.

### Option C (NOT recommended) — Ship status quo

The current Free plan is internally contradictory. It will produce angry "you promised X" support tickets *and* drain your AI bill in week one. Not viable.

---

## 7. Concrete fix list (whichever option you pick)

These must ship regardless of A vs B:

**P0 — before any public launch**

1. **Add `requireFeature()` to every AI-burning route.** Specifically: `/api/speed/start`, `/api/speed/submit`, `/api/tutor/chat`, `/api/teach-back/grade`, `/api/teach-back/follow-up`, `/api/misconception/diagnose`, `/api/misconception/drill`, `/api/xray/analyze`, `/api/rank/predict`, `/api/visualizer/create`, `/api/student/coach`, `/api/student/daily-drill`, `/api/flashcards`. Use the existing pattern from `/api/visualizer/create`.

2. **Align `plans.features` with whichever strategy you pick.** If Option A: add `bloom_score_once`, `tutor_5_per_day`, etc. as new feature keys with custom check logic. If Option B: add `tutor_unlimited`, `srs_unlimited` etc. to the Free plan array.

3. **Rewrite `/pricing` and `/student/expired` copy** to *exactly* match `plans.feature_summary`. Add a database constraint or unit test that fails if they drift.

4. **Add per-day counters** for tutor turns, teach-back submissions, speed sessions, flashcard generations — separate from the existing 3/day quiz cap. Schema migration: `daily_ai_usage(user_id, surface, day, count)` with upsert.

**P1 — within 2 weeks of launch**

5. **Add `status='active'` check** to `requireFeature` in `lib/featureAccess.server.ts`.

6. **Add per-minute rate limiter** (Upstash Redis or DB-based) on all Groq/Gemini routes. 10 req/min/user is enough for normal use, blocks bots.

7. **Reconcile "drill" vs "test" vs "attempt" terminology** across pricing, dashboard copy, and DB column names. Right now the same number means different things in different places.

**P2 — when revenue is stable**

8. **Refactor the dashboard tile system** so the lock-state source-of-truth is one place (today it reads `plans.features` + a hardcoded `BLOOMIQ_FEATURE_KEYS` constant + tile metadata).

9. **Decide on Student Coach gating** — either add it to `plans.features` or document it as universally free.

---

## 8. Verification plan

After implementing fixes:

1. Sign up as a Free user. Try to call every API route from browser console. Every AI-burning route must return 403 / 402 / 429. Document any that succeed.
2. Run `node scripts/test-rls.js` — RLS shouldn't regress.
3. Write a new `scripts/test-free-plan.js` — programmatically logs in as a Free user, exercises every feature in `plans.features`, asserts each one succeeds; exercises every feature NOT in `plans.features`, asserts each one returns the right error code.
4. Manually walk through `/pricing` → upgrade to Premium → verify every promised feature now works.

---

## 9. Decision needed from you

To unblock the P0 work, decide:

**(a) Option A or Option B for Free plan shape?**
**(b) For Option A — do you want the per-day counters to reset at midnight IST or 24h rolling?** (IST is friendlier UX, rolling is harder to game.)
**(c) Is Student Coach intended to be Free-forever or Premium?**

Once you answer, I can implement P0 items 1-4 in one session and we'll have a launch-ready Free plan.
