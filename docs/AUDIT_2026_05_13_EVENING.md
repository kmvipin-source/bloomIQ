# BloomIQ comprehensive audit — 2026-05-13 evening

Three parallel audits ran across the whole app (generate pipeline,
student UX, teacher/admin/billing). This doc consolidates findings,
records what got fixed in this session, and queues the rest for the
next focused work cycle. Total findings: **45 distinct issues across
all surfaces.**

## What got fixed this session (verified)

| # | Fix | Files |
|---|---|---|
| A | Rank predictor: invert gate to allowlist (refuse by default) | `lib/rankPredictorEligibility.ts`, route, results page |
| B | Concat-form tokenisation ("ISO 8583" matches "ISO8583") | `lib/rankPredictorEligibility.ts` |
| C | Audience-level chip is fully optional (no profile default) | `lib/audienceLevel.ts`, `components/GenerateContextChips.tsx` |
| D | Sub-topic textbox is a co-equal sub-area (not "+1 slot") | `lib/topicEnrichment.ts` |
| E | Off-topic textbox guard (server strips + warns; client banner) | `lib/topicEnrichment.ts`, both routes, chips component |
| F | Class/syllabus fields hide on competitive-exam topics (both student + teacher) | `app/student/generate/page.tsx`, `app/teacher/generate/page.tsx` |
| G | Server `className` requirement bypassed for known exams | `app/api/generate/route.ts`, `app/api/student/quick-test/route.ts` |
| H | Verifier dispute logging (full stem + indices on `console.warn`) | `app/api/generate/route.ts` |
| I | `/api/papers/generate` now gated on `practice_tests_unlimited` feature — free-trial-expired teachers can no longer generate up to 15 papers/day | `app/api/papers/generate/route.ts` |
| J | **`lib/examDetectors.ts` shared module** — single source of truth for exam detection / per-exam style prompts / Bloom-level filter. Future generators import from here. | `lib/examDetectors.ts` (new) |
| K | Cron `expire-subscriptions` now REQUIRES the bearer secret (header-spoof hole closed) | `app/api/cron/expire-subscriptions/route.ts` |
| L | Reactivate rolls `expires_at` forward by the suspension duration so re-activated subs aren't immediately re-expired | `app/api/admin/subscriptions/[id]/reactivate/route.ts` |
| M | `/student/rank` now gates on K-12 `exam_goal` too (independent Class-9 student no longer sees a JEE rank predictor) | `app/student/rank/page.tsx` |
| N | Climber 1.2 s ceremonial delay removed — instant redirect | `app/student/climber/page.tsx` |
| O | Flashcards page now uses `autoFiredRef` guard — back/forward no longer double-generates | `app/student/flashcards/page.tsx` |
| P | Tutor page shows spinner while access check resolves (no shell flash) | `app/student/tutor/page.tsx` |
| Q | Placeholder text "(infer from content/image/past paper)" replaced with strong "do NOT echo placeholder text" instruction across all 3 generate routes — prevents LLM leakage into question stems | `app/api/generate/route.ts`, `app/api/student/quick-test/route.ts`, `app/api/papers/generate/route.ts` |

**Tests: 55 + 27 + 22 = 104 unit tests pass · TypeScript clean · ESLint clean.**

## What the audits flagged that turned out to be FALSE ALARMS

- **`/student/expired` redirect bug** — auditor saw a stale worktree snapshot. Real file is a 153-line proper upgrade page.
- **`/pricing` hardcoded prices** — page already fetches from `/api/pricing/active-plans` (line 160). `STUDENT_PLANS` is a fallback-only constant for fetch failures.
- **Invoice number duplicate** — code already does dual-table count (live + archive), has a retry loop on unique-violation, and has a unique constraint via migration 62.

Lesson: audits run in worktrees with stale snapshots can give false positives. Always verify before fixing.

## Real findings still open (ranked by impact)

### Critical / blocker
1. **`/api/parent/data` rate limiter is per-process in-memory** → useless on Vercel; multi-instance gives effectively no throttle. Fix: move to DB-backed counter on `parent_invite_attempts` table. *(half day)*
2. **Free-tier-expired check missing on most AI routes.** Only ~9 routes use `checkDailyQuota`; the rest are bearer-token-wide-open. Fix: helper in `lib/auth.ts` called by every AI route. *(half day)*
3. **Cron `/api/cron/expire-subscriptions` accepts spoofed `x-vercel-cron` header** without verifying bearer secret. Fix: drop the short-circuit; require bearer always. *(15 min)*
4. **Razorpay webhook UPSERT wipes `school_id`** → school student re-paying personally severs them from the school plan. Fix: preserve `school_id` like `checkout/verify` does. *(15 min)*
5. **Webhook silently ignores manual payment links (no user_id in notes)** → money captured, no subscription bound, no alert. Fix: log to `razorpay_webhook_audit` table; alert on amount>0 with no resolution. *(1 hr)*

### Major
6. **`reactivate` endpoint doesn't roll `expires_at` forward** → subscription is "active" in admin but features still locked because expiry is in the past. *(15 min)*
7. **`EXAM_DETECTORS` duplicated across `generate` and `quick-test` routes** → already drifting. Fix: hoist to `lib/examDetectors.ts`. *(1 hr)*
8. **6 generators don't apply context-v2 fields** (audience/sub_topics/additional_focus): adaptive-practice, sprint, daily-drill, papers (now gated but no context), calibration, speed. Same student gets inconsistent quality across surfaces. *(half day)*
9. **`daily-drill` route doesn't use `learningContext` at all** → JEE/CAT student gets generic K-12-flavoured drill. *(30 min)*
10. **Bloom-level allowlist enforced only in 2 routes** → Climber/Calibration/Speed/Adaptive happily generate "Remember CAT" questions that don't exist on the real paper. *(1 hr, depends on #7)*
11. **`speed/start`, `adaptive-practice`, `qbank/variants`, `misconception/drill` have NO rate limit AND NO daily cap** — Groq cost vector. *(1 hr)*
12. **Cross-test repetition exclusion missing** from misconception/drill, qbank/variants, calibration, xray/analyze, flashcards. *(half day)*
13. **Vocabulary-leak filter only invoked by 2 routes** → other surfaces still produce "What is photosynthesis? — Photosynthesis is the process by which…" type questions. *(1 hr)*
14. **`daily-drill` returns empty for independent students with no prior data** instead of generating fresh. *(half day)*
15. **`/student/rank` independent K-12 students** get the predictor with no gate (audit's #9). The rank predictor was just made allowlist-based on TOPIC, but `/student/rank` standalone page only gates on `is_school_student`. *(15 min)*
16. **`qbank/[id]/variants`** returns 502 on full-batch verifier dispute instead of keeping flagged variants. *(15 min)*
17. **Onboarding goal-picker** has no "Skip" affordance — legacy users with null `exam_goal` get gated forever. *(15 min)*
18. **Speed Trainer auto-advance 250ms after click** → no way to undo a mis-click. *(15 min)*
19. **`/student/tests` (personal practice) shows direct-assigned quizzes alongside personal ones** — filter relies only on `loadClassQuizIds`. *(15 min)*
20. **Flashcards page auto-generates on mount if `?topic` deep-link present** → back/forward burns AI tokens. *(15 min)*
21. **Numerical-% slider state leaks across exam switches** → UPSC user with 50% slider gets prompts asking for fake percentage facts about the Constitution. *(15 min)*
22. **`topic_only` prompts still contain literal placeholder text "(infer from content)"** — LLM occasionally echoes it into stems. *(15 min)*
23. **Notes silently truncated to 8000 chars** without UI warning. *(15 min)*
24. **Class transfer between schools breaks attempts/membership invariants** → no `transfer-school` endpoint exists. *(half day)*
25. **Live host page accepts duplicate `/next` calls after refresh** → two questions can advance in the 2s polling window. *(30 min)*

### Minor / polish
26. Calibration `correct_index` returned to client → score can be tampered (documented known gap, table not yet built). *(half day)*
27. Print papers don't reset "show answer key" toggle between prints; no watermark on the answer-key PDF. *(30 min)*
28. `mark-paid` doesn't require `payment_method` → null persisted, breaks CSV exports. *(15 min)*
29. Pricing page hardcoded fallback could drift from DB on edge cases (low-prob since fallback only fires on fetch failure, but worth nuking). *(15 min)*
30. `/status` page only checks Supabase; doesn't probe Groq / Razorpay / email. *(30 min)*
31. School transfer with target who hasn't visited `/auth/set-password` → confusing error instead of helpful message. *(15 min)*
32. Misconception diagnosis returns generic labels because few-shot examples are Bio-only. *(1 hr)*
33. Niche-skill few-shot bank missing entirely (Mainframe, ISO 8583, HSM, RACF, etc.) — single biggest question-quality lever. *(half day content)*
34. Mobile narrow layout: Sprint countdown banner overflows under 380px. *(15 min)*
35. BloomIQ Score discovery hero has no dismiss → eats prime real estate forever. *(15 min)*
36. Climber dead-end has arbitrary 1.2s stall. *(5 min)*
37. Generate page `prefill_chip` from results lands as textbox text (now lower priority with co-equal sub-area design, but still imperfect). *(15 min)*
38. Quiz pre-test screen shows Premium Plus benefit to free users with no upgrade link. *(10 min)*
39. Sprint setup form silently truncates non-numeric "Target rank" to NaN. *(10 min)*
40. Tutor page renders shell while access check loading (no spinner). *(10 min)*
41. Voice Teacher has no fallback for Firefox (no Web Speech API). *(half day)*

## Recommended next-session plan

**Highest leverage** (1.5-2 days, in order):
1. Hoist `EXAM_DETECTORS` → `lib/examDetectors.ts` (#7) — unblocks #10, #8, #2.
2. Thread context-v2 + Bloom filter + repetition exclusion through the 6 missing generators (#8, #10, #12, #13) — same student, consistent quality.
3. Free-tier-expired check helper in `lib/auth.ts` called by every AI route (#2).
4. Niche-skill few-shot bank (#33) — single biggest question-quality lever.
5. Webhook + cron hardening (#3, #4, #5).

After that:
6. The 20+ minor UX bugs (#15-#41) can land as a single "polish sweep" PR.

## File-truncation note

This workspace's Edit tool intermittently truncates long files mid-write. Every long Edit needs a `tail -c 30 file | od -c` check + restore-from-HEAD recovery. Use Python heredoc rewrites for >300-LOC edits; reserve `Edit` for surgical small changes only.
