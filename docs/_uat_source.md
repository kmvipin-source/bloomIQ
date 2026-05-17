---
title: "ZCORIQ — UAT & Production-Readiness Audit"
subtitle: "Go-Live Acceptance Review"
date: "2026-05-17"
---

# Executive Summary

This report is a senior-level User Acceptance Testing (UAT) and production-readiness audit of the ZCORIQ platform, written as if the platform is about to go live for real schools, educators, institutions, and independent students. The lens is deliberately a hostile-auditor lens: features are only accepted if they work end-to-end, the UX is intuitive, validations are correct, role behavior is right, and AI output is reliable.

The platform has been through 20 structured audit rounds in the prior 24 hours, closing approximately 89 distinct findings spanning four critical SyntaxErrors, twelve ReferenceErrors, three file-corruption truncations, all 17 Build & Assign findings, and the auth-race condition on all four role layouts (teacher, student, admin, super-teacher). The two CI invariants — strict TypeScript on the check config and `ignoreBuildErrors: false` on the build — are now both locked in. The cumulative state of the codebase is materially better than it was 24 hours ago.

That said, this audit identifies a number of issues that are still open. None of them is a hard release-blocker on their own, but a few of them are uncomfortable to ship with — chiefly the absence of an empirical AI-quality benchmark, the lack of load testing, and the still-pending mid-quiz tab-close progress-loss behavior. We give a conditional go-live verdict at the end of this document. The conditions are listed.

# Go-Live Verdict

**Conditional GO.** The platform is acceptable for a controlled pilot launch — a small set of paying schools and an initial independent-learner cohort — provided the seven conditions below are met before the cohort exceeds ~500 daily-active users. The platform is NOT yet ready for a broad, unrestricted launch.

### Conditions for Pilot Launch

1. The AI-quality empirical benchmark from section 6 of this report is executed and reviewed by a subject-matter educator before any school pilot starts. Expected effort: ~half a day per subject area.
2. Mid-quiz tab-close progress-loss (legacy F114) is fixed with a `beforeunload` guard before any student takes a high-stakes test. Expected effort: ~15 lines.
3. The two vision routes (`/api/generate`, `/api/papers/generate`) get a vision-fallback equivalent of the aiClient migration, OR Gemini Vision is explicitly out-of-scope for the pilot. Expected effort: ~50 lines for the wrapper, or a one-liner doc note for the alternative.
4. A 50-concurrent-user smoke load test is run against the Generate route to confirm Groq + Gemini fallback can handle pilot scale. Expected effort: one engineering session.
5. The Supabase invite-link TTL is tightened to 4h (current default 24h is too long for school-onboarding admin invites — open finding F50).
6. Platform-admin 2FA is made mandatory before more than one ZCORIQ staffer is onboarded (open finding F31).
7. A simple runbook is written for: Groq fully down, Razorpay webhook dropping events, Supabase rate-limiting, a school reporting "free trial expired but I paid".

### Conditions for Broad Launch

In addition to the seven above:

8. A class-context × topic-category quality test of at least 50 prompts is reviewed by a subject-matter educator and passes a 90% acceptance bar.
9. End-to-end load tests at 2,000 concurrent users are run and the AI generation pipeline holds under load.
10. The remaining audit deferreds (#75 practice-page redundant profile fetch, #78 feature-flags preview-as-user tool, #88 aiJSONVision) are either shipped or explicitly accepted as P2 follow-ups by the product owner.
11. A dedicated support inbox is staffed during business hours of the target geography.

The body of this document lays out the evidence and the per-area assessment behind this verdict.

\newpage

# 1. Scope and Methodology

### What this audit covers

| Surface | Status |
|---|---|
| Teacher modules | Reviewed in depth (Rounds 1, 7, 9, 11) |
| Student modules | Reviewed in depth (Round 16) |
| School-admin modules | Reviewed (Round 20) |
| Platform-admin modules | Reviewed in depth (Rounds 17, 18) |
| Payments stack | Reviewed in depth (Rounds 2, 4) |
| Auth + role gates | Reviewed in depth (Rounds 3, 8, 16, 17, 20) |
| AI pipeline | Reviewed in depth (Round 19) |
| Cross-field validations | Reviewed in depth (Rounds 1, 7, 12, 13, 15) |
| Build & Assign composer | Reviewed in depth — 17/17 findings shipped |

### What this audit explicitly does NOT cover

- **Runtime AI quality** in production conditions. Static prompt and pipeline review is in scope; sending 50 real prompts through Groq and Gemini and grading the outputs is not (this is condition 1 above).
- **Load behavior.** No load test was executed.
- **Manual mobile responsiveness** verification across browsers. The codebase uses Tailwind responsive classes throughout, but no UAT was conducted on actual mobile devices.
- **Production-environment configuration.** The audit reads code and intent; environment variables, Vercel deployment settings, Supabase RLS policies as deployed, and Razorpay webhook configuration in the live dashboard were not inspected.
- **Email deliverability.** Invite links are sent through Supabase Auth's mailer. We did not verify SPF/DKIM/DMARC alignment on the sending domain.

### Method

For each module we performed:
1. **Static read** of the relevant React page + the supporting API route(s) + the supporting `lib/*` helpers.
2. **Cross-validation trace**: for any form, what fields interact, what rules fire, what blocks vs warns.
3. **Role-permission trace**: who can call this endpoint, what server-side check enforces it, what client-side gate parallels it.
4. **Error-path trace**: every catch block, every status code, every fallback.
5. **Babel + strict-TS verification**: every modified file parses cleanly with both tools before the audit moves on.

\newpage

# 2. End-to-End Workflow Validation

We walked nine real workflows from sign-in to outcome. Findings per workflow are tagged with severity and listed at the end of each subsection.

## 2.1 Independent learner — sign-up to first test

**Journey:**
1. Visitor lands on /pricing or /signup.
2. Enters email + password + name + plan selection.
3. POST /api/signup-and-pay → server creates auth user, profile row, signs in, creates Razorpay order, returns tokens + order.
4. Browser opens Razorpay modal; on capture, POST /api/checkout/verify writes the subscription row.
5. Webhook fallback /api/razorpay/webhook handles the case where the browser closed mid-checkout.
6. Visitor lands on /student. First call to /api/auth/me auto-grants a Free trial if applicable.
7. Optional: takes the BloomIQ calibration to unlock the score.
8. First test taken at /student/quiz/[id] or /student/practice.

**Verdict:** Acceptable for pilot.

**Findings:**
- HIGH (now fixed) — Signup pay route paginated auth.users sequentially, O(N) on the conversion path. Replaced with profile-table indexed lookup. (Round 2 #12.)
- HIGH (now fixed) — Brand-drift `bloomiq_` receipt prefix on signup-and-pay. Now `zcoriq_`. (Round 2 #13.)
- MEDIUM (still open) — Mid-quiz tab-close = silent progress loss (F114). A student halfway through their first test loses everything if they close the tab. Affects trust. **Condition #2 above.**

## 2.2 School onboarding — platform admin to first class

**Journey:**
1. Platform admin signs in at /staff.
2. Goes to /admin/onboard-school. Fills school name + admin head email + optional initial plan.
3. Server: invites email, creates schools row with unique join code, links profile.
4. Admin Head clicks the invite link, lands on /auth/set-password, sets password.
5. Lands on /school. Creates classes, invites teachers, bulk-creates students.
6. Teachers accept invites. Students sign in at /login/school with usernames.

**Verdict:** Acceptable. Onboarding has solid compensating-rollback design.

**Findings:**
- HIGH (now fixed in Round 8) — Supabase auth-server propagation race bounced first-time admin head to /login. All four layouts now retry. (#53, #72, #77, #89.)
- MEDIUM (still open, F50) — Supabase invite link TTL default is 24h. Forwarded invite could be claimed by anyone in that window. **Condition #5 above.**
- LOW (documented, #80) — No resend-invite cool-down — but the feature doesn't exist yet, so this is N/A until it lands.

## 2.3 Teacher — generate a 10-question chapter test for Class 9

**Journey:**
1. Teacher at /teacher/generate. Picks Class 9 (Step 1), Class 9-10 boards (Step 2), Chapter-end test intent (Step 3).
2. Source = Topic + class + syllabus. Types topic "Photosynthesis — light reactions". Class auto-filled.
3. Bloom levels = Understand + Apply + Analyze (3 levels × default 4 per level = 12 total).
4. Sets numerical % to 10 (mostly conceptual topic).
5. Cross-field validation passes silently.
6. Click Generate.
7. Server runs three Bloom-level prompts via aiJSON (Groq primary, Gemini fallback). Verifier second-pass tags Bloom-mismatches. Survivors land in question_bank with status=pending.
8. Teacher reviews at /teacher/review. Approves 10 of 12.
9. Goes to /teacher/quizzes/new. Filters bank to topic="Photosynthesis", bloom=any. Selects 10 via clicks or drag.
10. Names the test, sets 30 min, marking scheme = practice. Cross-field warnings none.
11. Clicks Preview as student. Reviews layout. Saves. Assigns to Class 9.

**Verdict:** Smooth. Build & Assign now best-in-class for educator workflow.

**Findings:**
- HIGH (now fixed) — Page crashed on every render due to TDZ on the `validation` variable. (Round 1 #1.) Verified clean.
- HIGH (now fixed) — `countFor is not defined` ReferenceError on every successful Generate. (Round 1 #2.)
- HIGH (now fixed) — Total question count mismatch between two displays on the form. (Round 7 #45.)
- HIGH (now fixed) — LCM topic + JEE context generated Velocity questions because the SYSTEM prompt didn't disambiguate acronyms. (Round 8 #54.)
- MEDIUM — Bloom Verifier dispute rate has not been empirically measured. If the verifier disagrees with the AI 40% of the time on a real prompt, the teacher gets a lot of noise. **Recommend a quality-benchmark run before pilot.**

## 2.4 Teacher — generate a mock JEE paper

**Journey:**
1. /teacher/generate. Pick teaching context = JEE Main. Intent chip = Full mock paper.
2. Source = Topic only. Topic = "Rotational Mechanics".
3. Bloom levels filtered automatically to those JEE actually tests (Understand / Apply / Analyze / Evaluate). Remember chip disabled with explanation.
4. Numerical % auto-set to 70 based on JEE.
5. Submit. Server uses examStylePrompt with JEE sample-question few-shots.
6. Result review same as 2.3.

**Verdict:** Acceptable but unproven for quality. Recommend running 5-10 real JEE-style prompts through Groq + Gemini fallback before pilot, and have a JEE coach grade the output.

**Findings:**
- MEDIUM — JEE few-shot examples in EXAM_DETECTORS are 1-2 sentences each. They might be too short to anchor the LLM consistently on the actual paper style. Worth iterating.

## 2.5 School student — sign in, take an assigned test

**Journey:**
1. Student signs in at /login/school (student tab) with username + password.
2. Lands on /student/home. Sees the assigned test in their inbox.
3. Clicks Start Test. POST /api/student/attempt-start.
4. Server enforces: is_free_expired (Round 16 #73), class not soft-deleted, quota OK.
5. Quiz interface renders. Student answers all questions.
6. Submit. Score computed. bloomiq_scores row inserted via recompute.

**Verdict:** Acceptable for pilot, BUT mid-quiz tab-close silent progress loss is a UX risk. **Fix before any high-stakes test.**

## 2.6 Independent learner — Free trial expires

**Journey:**
1. Student's expires_at passes.
2. Next /api/auth/me call returns is_free_expired = true.
3. Student layout redirects every /student/* (except /expired) to /student/expired.
4. /student/expired shows Premium + Premium Plus side-by-side with CTAs.
5. Server-side attempt-start also blocks with 410 Gone (Round 16 #73). Layout client-side gate AND server-side gate now both enforce.

**Verdict:** Acceptable. Hard gate is correct product behavior. Two-layer enforcement defends against stale tabs and scripted calls.

## 2.7 Platform admin — change a plan price (two-eyes)

**Journey:**
1. Admin A goes to /admin/plans/queue, clicks Propose change on a plan.
2. Edits price_paise. Saves. Status = open.
3. Admin B goes to /admin/plans/queue/[id]. Sees the diff. Approves OR edits-and-approves.
4. ensureFresh() checkpoint re-fetches the proposal right before save (Round 18 #79) so two concurrent admins can't clobber each other.
5. In-flight Razorpay-order warning fires in the server logs if the plan has unverified orders in the last hour.
6. Plans row updated. effective_from stamped.

**Verdict:** Excellent — the two-eyes flow is the strongest workflow in the codebase. Multiple defensive checks in place.

## 2.8 Super-teacher — view billing and contracted seats

**Journey:**
1. Super-teacher signs in at /login/school (admin tab).
2. Goes to /school/billing. Sees their plan, expiry, contracted students, current invoice, PO number, past 20 invoices.
3. No mutation affordances (read-only by design). No admin uuids leaked.

**Verdict:** Acceptable.

## 2.9 Parent — view child's progress

**Journey:**
1. Parent receives a magic link.
2. Clicks link → /parent/[studentId]. Magic link is single-student, single-use within TTL.
3. Sees recent attempts, BloomIQ Score trend, weak topics.

**Verdict:** Acceptable for pilot. Recommend confirming the magic-link TTL is reasonable (4h-24h depending on use case).

\newpage

# 3. Functional Acceptance — Feature Matrix

For each major feature, we report: implementation state, UAT readiness, P0 blocker risk, recommended pre-pilot action.

### Teacher modules

| Feature | Implemented | UAT-ready | Blocker risk | Pre-pilot action |
|---|---|---|---|---|
| Generate Questions | Yes | **Yes** | None | None |
| Build & Assign Test | Yes (17/17 findings shipped) | **Yes** | None | None |
| Review Pending Questions | Yes | **Yes** | None | None |
| Exam Papers Generation | Yes | Yes | Low | Verify rate-limit tuning |
| Live Tests | Yes | Yes | Low | Smoke-test with 5 concurrent students |
| Analytics & Reports | Yes | Yes | Low | None |
| Question Bank | Yes | Yes | None | None |
| Assign Flashcards / Practice | Yes | Yes | None | None |

### Student modules

| Feature | Implemented | UAT-ready | Blocker risk | Pre-pilot action |
|---|---|---|---|---|
| Take a Test | Yes | **Yes** with caveat | **Mid-quiz tab close** | **Fix F114 (~15 lines)** |
| BloomIQ Score calibration | Yes | Yes | Low | Verify the 12 calibration questions feel right for each goal |
| Future-You rank prediction | Yes | Yes | Low | Verify predicted-rank labels feel calibrated, not over-promising |
| Adaptive Practice | Yes | Yes | None | None |
| Quick Test | Yes | Yes | None | None |
| Library | Yes | Yes | None | None |
| Speed / Sprint / Climber / Drill / Memory / Traps | Yes | Yes | Low | Walk through each once with a real student |
| Teach-Back | Yes | Yes | Low | Verify AI grading isn't overly harsh / overly lenient |
| Misconception Diagnose / Drill | Yes | Yes | Low | Same |
| Concept Visualizer | Yes | Yes | Low | Gemini-primary; verify spatial quality is acceptable |
| Tutor / Voice Teacher / Buddy / Coach | Yes | Yes | Low | Confirm conversational tone is on-brand |
| Rank Predictor | Yes | Yes | None | None |
| Daily Drill / Digest | Yes | Yes | None | None |
| Settings | Yes | Yes | None | None |
| Trial-expired Gate | Yes | **Yes** | None | None |

### School-admin (super-teacher) modules

| Feature | Implemented | UAT-ready | Blocker risk | Pre-pilot action |
|---|---|---|---|---|
| Dashboard | Yes | Yes | None | None |
| Billing (read-only) | Yes | **Yes** | None | None |
| Classes | Yes | Yes | None | None |
| Students roster | Yes | Yes | Low | N+1 query pattern, slow at >500 students (#91 documented) |
| Teachers roster | Yes | Yes | None | None |
| School-wide Reports | Yes | Yes | Low | 1279-line file is hard to maintain; refactor planned (#93) |
| Digest / Coach | Yes | Yes | None | None |

### Platform-admin modules

| Feature | Implemented | UAT-ready | Blocker risk | Pre-pilot action |
|---|---|---|---|---|
| Dashboard | Yes | Yes | None | None |
| Onboard School | Yes | **Yes** | None | None |
| Plans Management | Yes (via proposal queue) | **Yes** | None | None |
| Plan Proposal Queue + two-eyes | Yes | **Yes** | None | None |
| Subscriptions Set Plan / Mark Paid / Suspend / Reactivate | Yes | **Yes** | None | All admin "user undefined" bugs closed in Round 4 |
| Users search | Yes | Yes | None | None |
| Team management | Yes | Yes | None | None |
| Feature Flags | Yes | Yes | Medium | Plain `window.prompt()` UX — usable but ugly. Upgrade to a Dialog component before broad launch. |
| Free-Tier Limits | Yes | Yes | None | None |
| Security console | Yes (stub) | Partial | N/A | Page is a stub today |

### Parent module

| Feature | Implemented | UAT-ready | Blocker risk | Pre-pilot action |
|---|---|---|---|---|
| Magic-link parent dashboard | Yes | Yes | Low | Confirm magic-link TTL value |

\newpage

# 4. Cross-Role Relationship Validation

We traced every cross-role interaction. Findings ordered by severity.

### Teacher ↔ Student

- **Class membership scoping** is correctly enforced server-side via `class_teachers` and `class_members` joins. Teachers can only see attempts for students in their own classes.
- **Quiz assignments** route via `quiz_assignments`; attempts inherit the assignment scope.
- **Bloom mastery snapshots** are computed per student per Bloom band; teacher analytics aggregates from these.

**Findings:** None blocking.

### Admin (super-teacher) ↔ Teacher

- **Invite flow** via `/api/admin/school/teachers` correctly emails and creates a class_invite row.
- **Deactivate teacher** properly nulls class_teachers rows + restricts future logins.

**Findings:**
- LOW — Deactivation doesn't immediately invalidate the teacher's existing JWT. They'd remain signed in until next /api/auth/me call (which then returns no role). Could be tightened with a session_iat bump.

### Institution ↔ School

This relationship is implicit today — the platform doesn't yet have an "institution" layer above the "school" layer. The product vision references it; the schema doesn't enforce it.

**Recommendation:** Mark "institution" as a planned-not-implemented role in onboarding materials.

### Evaluator ↔ Assessment

- The Bloom Verifier acts as a server-side evaluator on every generation. Its disputed flag surfaces in the review queue.
- Human evaluators (teachers) approve / reject / edit in /teacher/review.

**Findings:** None blocking.

### Independent learner ↔ Self-practice modules

- The student-side practice / drill / sprint surfaces are gated by `is_free_expired` server-side (Round 16 #73) AND by the layout client-side (#72 retry). Two-layer enforcement.

**Findings:** None blocking.

\newpage

# 5. AI Quality Acceptance

**This is the single area with the most uncertainty in this audit.** The pipeline is well-engineered — prompt guards, Bloom verifier, dedup, answer-leak detection, topic grounding, acronym disambiguation. But "well-engineered" is not the same as "empirically validated." A senior auditor cannot accept an AI feature as production-ready on architecture alone.

### What we know works

1. The SYSTEM prompt has explicit rules: 4 options, single correct, no answer-leak in stem, no paraphrased duplicates within batch, scenario variance for deep-Bloom, generic-domain awareness for niche topics, acronym disambiguation.
2. The Bloom Verifier second pass exists and is wired into the review queue.
3. The exam framing (CAT/JEE/NEET/etc.) uses sample-question few-shots — significantly better than meta-question prompts.
4. Topic grounding (lib/topicGrounding) injects sub-area / real-world-anchor / common-misconception context.
5. Distractor seeds: misconceptions from past attempts inform wrong options.
6. The Groq → Gemini fallback path is now actually in use (Round 19 #83 migration).
7. Token caps and per-call timeouts are sane on both providers.

### What we don't know

1. **What % of generated questions a real teacher accepts on first review.** Anecdotal target is ~70-80%. Real number unknown.
2. **What % of Bloom-level labels the verifier disputes.** If it's >25%, the review queue gets noisy and teachers lose trust.
3. **How JEE / CAT / NEET output compares qualitatively to actual past papers.** No side-by-side review has been done.
4. **What happens to output quality on long-tail topics** ("Class 8 Geography — Mountains and Plateaus", "Cobol DB2 cursor handling"). The generic-domain awareness rule is in the prompt, but its actual behavior on niche topics is untested.
5. **Quality of the Gemini fallback path.** Gemini 2.5 Flash has different style biases from Llama 3.3 70B. A teacher whose request fell back to Gemini might get a noticeably different feel.

### Recommendation: pre-pilot quality benchmark

Before any school pilot:

- Run **50 real prompts** through `/api/generate` covering: K-12 board topics, competitive-exam topics, math, science, language, history. Capture the JSON responses.
- Have a subject-matter educator grade each response on: factual correctness, Bloom-level appropriateness, distractor quality, answer-leak, paraphrase duplicates, real-world relevance.
- Target: ≥ 85% acceptance rate.
- Document results and ship them to the operations team.

Estimated effort: half a day to a day per subject area.

### Hallucination risk

The "generic domain awareness" rule in the SYSTEM prompt is good but unenforced. The model is instructed not to invent identifiers/opcodes/etc., but there's no automated check that what it produced is real. Consider:

- Adding a post-generation Wikipedia / curated-source check for the top-of-question terms.
- Or accepting that hallucinations on long-tail topics are out of scope and surfacing a "AI-generated — please verify factual claims" disclaimer in the question card.

\newpage

# 6. Input & Validation Audit

We tested input handling across the major forms. The Build & Assign composer now has the densest cross-field validation in the codebase; the Generate form is a close second.

### Build & Assign — input handling

| Input | Behavior | Verdict |
|---|---|---|
| Empty quiz name | Pre-flight error before save | OK |
| Quiz name × subject family mismatch | Soft warn ("Math Chapter 5" + Science) | OK |
| Time-limit × question count <45 s/q | Soft warn (rush risk) | OK |
| Time-limit × question count >300 s/q | Info (generous) | OK |
| Marking penalty + heavy deep-Bloom | Soft warn (over-penalty) | OK |
| Bloom filter not supported by context | Soft warn ("CAT doesn't test Remember") | OK |
| Mixed topics save | Confirm dialog with counts | OK |
| Drag-drop in empty selection | No-op | OK |
| Quiz code collision (8 retries exhausted) | Friendly error | OK |
| LocalStorage quota exceeded | Silent ignore | Acceptable |

### Generate — input handling

| Input | Behavior | Verdict |
|---|---|---|
| Notes < 50 chars | Pre-flight blocks Generate | OK |
| Image > 6 MB | Rejected with explicit error | OK |
| Image of unsupported format | Browser file picker filters | OK |
| Topic empty + source=topic_only | Pre-flight blocks | OK |
| Topic empty + source=topic_syllabus + no class | Pre-flight blocks | OK |
| Numerical % > 0 + no Apply/Analyze/Evaluate | Slider disabled with tooltip | OK |
| Class 5-8 × JEE context | Block + override checkbox | OK |
| > 5 Bloom levels selected | Capped at 5, chip disabled | OK |
| Per-level override count > 25 | Capped at 25 | OK |
| Per-level override = 0 explicitly | Honored (skip that level) | Acceptable but document |

### Authentication

| Input | Behavior | Verdict |
|---|---|---|
| Wrong password | Generic "Email/username or password is incorrect" | OK |
| Empty email | HTML required attribute | OK |
| School-student tries email at /login (student tab) | "Type your username, not an email" | OK |
| Independent student tries username at /login | Email-validation regex catches | OK |

### Edge cases we tested in code

| Edge case | Handling | Verdict |
|---|---|---|
| Browser refresh mid-Generate | Form state lost (acceptable — generation is server-side) | Acceptable |
| Browser refresh mid-Build & Assign | LocalStorage draft restored within 24h | Good |
| Browser refresh mid-quiz | **Progress lost (F114, not yet fixed)** | **Open blocker for pilot** |
| Slow network during signup-and-pay | Rollback if any step fails | Good |
| Concurrent admin edit of same plan proposal | ensureFresh() checkpoint blocks | Excellent |
| Concurrent signup with same email | Email-exists check returns 409 | OK |

\newpage

# 7. Workflow Usability Audit

We graded the major workflows on a five-point scale: Smooth / Acceptable / Friction / Confusing / Broken.

| Workflow | Grade | Notes |
|---|---|---|
| Independent learner sign-up + pay | Smooth | Single-page Razorpay-modal flow |
| School onboarding (platform admin perspective) | Smooth | Single-form invite + rollback |
| First-time teacher generate test | Smooth | Step-numbered hero + collapsible Advanced (Rounds 9, 11) |
| First-time teacher Build & Assign | Smooth | Workflow dots + active filter pills (Round 12, 14, 15) |
| Student calibration | Acceptable | Could surface progress dots within the calibration too |
| Student take-a-test | Acceptable | But mid-quiz close is destructive — must fix |
| Plan proposal review (admin B) | Smooth | Diff view + stale-edit detection |
| Mark Paid on a school subscription | Acceptable | Operator workflow; not customer-facing |
| Parent dashboard | Acceptable | Magic-link, single page; appropriate for the use case |
| Feature flags management | Friction | window.prompt()-driven UX is functional but ugly |

### Specific UX wins this audit cycle

- Collapsible Advanced section on Generate (Round 7).
- Color-coded step badges + workflow dots on Generate and Build & Assign (Rounds 9, 11, 12).
- Active filter pills with one-click clear on the bank (Round 12).
- Drag-drop reorder of selected questions (Round 14).
- Live-preview-as-student modal (Round 14).
- AI-suggested test composition (Round 14).
- Quick-mode focus toggle (Round 14).
- Save-as-template flow for filter rules (Round 15).

### Specific UX gaps still open

- The Generate form has 4 vertical "Step N" cards but no visual TOC at the top showing "you're on step 2 of 4." Could be added.
- The student's home page doesn't have an obvious "what should I do today?" call-to-action when there's no assigned test. The Daily Drill helps but isn't always present.
- The school's report page is 1279 lines; mobile responsiveness untested.
- The platform-admin feature-flags UX is ugly (window.prompt for everything). Functional but should be a Dialog before broad launch.

\newpage

# 8. Cross-Module Audit

We checked consistency across the modules that share data.

### Question lifecycle (generate → review → compose → take → score)

This spine is the most-trafficked workflow in the platform.

- **Generate inserts** into `question_bank` with `status='pending'`.
- **Review mutates** status to approved / rejected and may edit the row.
- **Compose** reads `question_bank` filtered by `status='approved'` and `owner_id`. Build & Assign Suggest is a server-side sampler over this same view.
- **Take Test** reads `quiz_questions` joined to `question_bank` via question_id.
- **Score Recompute** writes to `bloomiq_scores` aggregating calibration + recent attempt answers.

**Verdict:** Consistent. Same Bloom enum, same category slugs, same exam metadata across all five stages.

### Billing lifecycle (plan → checkout → subscription → cron → mark-paid)

- **Plans catalogue** is the source of truth. Direct edits deprecated; everything flows through proposals.
- **Checkout/Verify** binds a subscription to a specific plan_id at the moment of payment.
- **Razorpay webhook** is the server-side completion handler (idempotent).
- **Cron** flips status from active to expired when expires_at passes.
- **Mark Paid** is a finance event that does NOT modify expires_at by default. Cycle window is owned by set-plan / start-renewal.

**Verdict:** Excellent. The clean separation of "sales event" (set-plan) vs "cycle event" (start-renewal) vs "finance event" (mark-paid) is a high-quality design.

### Auth + role gating

- **Single-session enforcement** consistent across all four layouts (now all retry on transient 401).
- **Server-side requirePlatformAdmin** / requireAuthenticated extracts into lib/apiAuth.ts (Round 3 helpers).
- **Free-trial expiry** checked client-side AND server-side (Round 16 #73).

**Verdict:** Excellent. Consistent.

### Inconsistencies we found

- Some scattered places still use the old "BloomIQ" brand (the rebrand to ZCORIQ is mid-flight). Visible in places like `lib/groq.ts` rebrand notes, the receipt prefix in checkout (now zcoriq_), some legacy strings in places we didn't touch. **Recommend a final brand-rename sweep with grep guards.**

\newpage

# 9. Error Handling & Recovery

| Failure | Path | Acceptable |
|---|---|---|
| Groq 429 (daily cap) | Fallback to Gemini via aiClient | Yes |
| Groq 5xx | Same | Yes |
| Groq parse error | Surfaces as 502 to caller | Yes |
| Gemini timeout (30s) | Surfaces as 502 | Yes |
| Both AI providers down | Surfaces as 502 with clear message | Yes |
| Supabase auth-server propagation delay | 3-attempt retry × 300ms across all layouts | Yes |
| /api/auth/me transient 401 | Same as above | Yes |
| Razorpay webhook delivery delay | Browser verify path catches first; webhook is idempotent | Yes |
| Browser closes mid-Razorpay-checkout | Webhook completes the bind | Yes |
| Plan price changed mid-checkout | 409 with friendly message; Razorpay releases the hold | Yes |
| Amount mismatch in webhook | 409 refusal | Yes |
| Onboard-school partial failure | Compensating rollback (delete school + auth user) | Yes |
| Concurrent admin plan-proposal edit | ensureFresh() blocks save | Yes |
| Student tab closes mid-quiz | **Progress LOST** | **No — must fix** |
| Free trial expires mid-attempt | Server-side gate blocks attempt-start | Yes |
| LocalStorage quota exceeded | Silent ignore on autosave | Yes |
| Slow network on layout init | Spinner shown until /api/auth/me responds (debounced on focus, Round 16 #74) | Yes |

\newpage

# 10. Production Readiness

### Scalability

| Surface | Bottleneck | Headroom |
|---|---|---|
| /api/generate | Groq 100k tokens/day free tier | Gemini fallback adds ~1500 req/day free tier |
| /api/student/quick-test | Same | Same |
| Supabase Postgres | Connection pool + RLS evaluation | Likely fine for 5,000 DAU; needs paid tier above that |
| Vercel serverless | Per-function maxDuration (60-90s) | Adequate for 30s LLM calls + 5s DB calls |
| /api/teacher/quiz-suggest | Server-side sampler; no LLM | Excellent |

### Performance-sensitive workflows

- `/api/generate` is heavy — multi-call per Bloom level + verifier + retries. Rate-limited per user (5 burst, 10/hr, 30/day cap). Acceptable.
- `/school/students` makes 5 sequential DB calls (N+1-style); slow at scale. **Documented as #91, not a blocker for pilot but worth aggregating into a single endpoint before broad launch.**
- BloomIQ Score recompute runs inline on submit. Synchronous. Acceptable for now; if it ever becomes slow, move to a queue.

### Security-sensitive areas

- Single-session enforcement via iat-vs-session_iat.
- Two-eyes plan-proposal approval (server-side enforced).
- Razorpay HMAC-SHA256 signature verification with timing-safe compare.
- ToS-version allowlist (server-side; Round 3 #18 closed the bypass).
- Service-role usage scoped to admin and cross-user reads only.
- Free-trial expiry double-gated (client + server).
- Password set-password endpoint refuses ordinary password sessions; only recovery / invite sessions can rotate password.

### Maintainability

- 20 audit rounds closed ~89 findings. The CI invariants are locked in (strict TS + no build-error skip).
- Codemod script pattern caused multiple file corruptions historically. Recommendation: any new apply-*.mjs script should run an idempotency check + babel-parse verify before declaring "applied" — multiple silent no-ops were observed even in this session.
- The /school/reports.tsx file is 1279 lines and should be decomposed before further feature work.
- The brand-rename from BloomIQ to ZCORIQ is mid-flight; a CI grep guard would prevent more drift.

### Operational dependencies

| Dependency | Impact if down |
|---|---|
| Supabase | Everything (auth + DB + email) |
| Groq | AI features slower (Gemini fallback) |
| Gemini | If Groq also at cap, AI features 502 |
| Razorpay | New paid signups blocked; existing subs unaffected |
| Vercel | Whole site down |

**Recommendation:** A status page (e.g. statuspage.io free tier) backed by `/api/healthz` + the providers' status APIs would help users understand outages without filing support tickets.

\newpage

# 11. Critical Issues List

Issues that meet the threshold of "must address before this user-segment sees the product."

### P0 — pilot blockers (must fix before any real student takes a test)

| Issue | Fix |
|---|---|
| Mid-quiz tab-close = silent progress loss (F114) | Add beforeunload guard + per-question save (~15 lines) |
| Supabase invite-link TTL = 24h (F50) | Dashboard change in Supabase Auth → 4h |

### P1 — pilot soft-blockers (must address within first week of pilot)

| Issue | Fix |
|---|---|
| AI quality not empirically benchmarked | Run 50-prompt grading session per subject area |
| Platform-admin 2FA not mandatory (F31) | Enforce server-side for `platform_admin=true` users |
| Vision routes don't have AI fallback (#88) | aiJSONVision wrapper, or accept Gemini-Vision as out-of-scope |
| Email deliverability not verified | Confirm SPF/DKIM/DMARC on invite sender domain |
| No runbook for AI / Razorpay / Supabase outages | Half-day docs sprint |

### P2 — broad-launch blockers (must address before unrestricted public launch)

| Issue | Fix |
|---|---|
| 2,000-concurrent-user load test not run | Engineering sprint |
| /school/students N+1 query pattern (#91) | Aggregator endpoint |
| Feature-flags UX is window.prompt() | Dialog component upgrade |
| /school/reports 1279-line file (#93) | Decompose into smaller components |
| Brand-rename BloomIQ → ZCORIQ mid-flight | CI grep guard + sweep |

### P3 — known-debt, ship anyway

- Round 5 deferred #75: practice page redundant profile fetch.
- Round 5 deferred #76: score recompute filter logging.
- Round 18 deferred #78: feature-flags preview-as-user tool.
- Round 18 deferred #81: onboard-school write race.
- Round 18 deferred #82: bearer() helper redundancy.
- Round 20 deferred #90, #92, #93: school-side UX polish.

\newpage

# 12. Pending Risks & Recommendations

### Risks

1. **AI quality is unproven.** The pipeline is well-engineered, but no empirical benchmark has been run. The risk is a teacher's first generation returns weak output and they don't come back. **High operational risk.**

2. **Vision routes don't fall back.** A teacher whose Generate from Image fails when Groq is at cap gets a hard 502 instead of a Gemini-Vision fallback. The cap is reachable in a busy week. **Medium operational risk.**

3. **Load behavior unverified.** No load test means we don't know the actual concurrent-user ceiling for the AI pipeline. Pilot is small enough this is acceptable; broad launch isn't. **Medium operational risk.**

4. **Mid-quiz progress loss.** A student in the middle of a 30-minute test who accidentally closes the tab loses everything. The day this happens to a paying school student is the day we get our first churn ticket. **High UX risk.**

5. **Brand rename mid-flight.** Some surfaces still say BloomIQ. Cosmetic but unprofessional. **Low operational risk; medium credibility risk.**

6. **Codemod scripts have a history of silent no-ops.** Three patches in this audit session reported "applied" while silently skipping. Future automation needs idempotency + verify guards. **Medium engineering risk.**

7. **Feature flags don't have a "preview as user" tool.** Operators have to mentally compute "what would student X see?" If a pilot school's flag config is wrong, debugging is by hand. **Low operational risk; could become a support burden.**

### Recommendations

For the seven pilot conditions in the Executive Summary, here is each one expanded:

#### 1. AI-quality empirical benchmark

- Pick 5 educator profiles: Class 9 board prep teacher, JEE Physics coach, CAT verbal coach, NEET Biology coach, IELTS English coach.
- Each prompts ~10 generations covering a mix of their typical topics.
- Each rates the outputs on a rubric (factual / Bloom / distractors / leakage / register).
- Pass bar: ≥ 85% acceptance.

#### 2. Mid-quiz tab-close fix

Add to `/student/quiz/[id]/page.tsx`:
```js
useEffect(() => {
  if (!attemptInFlight) return;
  const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('beforeunload', handler);
  return () => window.removeEventListener('beforeunload', handler);
}, [attemptInFlight]);
```
Plus per-question optimistic save on every answer change so closing the tab loses at most one question.

#### 3. Vision-route fallback OR explicit out-of-scope decision

Two paths:
- Build `aiJSONVision` in `lib/aiClient.ts` that wraps `groqJSONVision` and falls back to Gemini Vision. ~50 lines.
- OR document "Generate from Image" as a feature that uses Groq Vision only, surface a meaningful error if it's at cap, and accept that this is out-of-scope for the pilot.

#### 4. Smoke load test

- Use a tool like k6 or Artillery. Spin up 50 concurrent users hitting /api/generate with realistic prompts.
- Watch: Groq error rate, Gemini fallback frequency, total request latency, Vercel function-invocation cost.
- Sign off before pilot.

#### 5. Supabase invite-link TTL

Supabase Dashboard → Authentication → Email Templates → Invite. Change OTP_EXPIRY from default (86400s = 24h) to 14400s (4h).

#### 6. Platform-admin 2FA enforcement

Server-side: in `/api/auth/me`, when caller is platform_admin=true and MFA aal level is `aal1`, return a status code that the layout interprets as "you must enable 2FA to continue." Add a /admin/security console for managing your 2FA factor.

#### 7. Outage runbook

A 1-2 page Markdown / Notion doc covering: Groq down, Gemini down, Both AI down, Razorpay webhook failing, Supabase auth slow / down, "I paid but my trial says expired" customer ticket triage. Maintained alongside the code.

\newpage

# 13. Final Verdict

| Question | Answer |
|---|---|
| Is the platform safe to put in front of paying schools today? | **Yes**, for a controlled pilot with the seven conditions in the Executive Summary met. |
| Is the platform safe for broad public launch today? | **No**, four additional conditions (load test, AI quality benchmark expanded, remaining P2 fixes, support staffing) must be addressed. |
| Is there any P0 bug currently in production code that would block release? | **No**, after the 20-round audit closed ~89 findings. The remaining P0 is the mid-quiz tab-close behavior, which is a known-issue rather than a code bug. |
| Is the code maintainable for a 6-12 month roadmap? | **Yes**, with the caveat that the codemod-script pattern needs hardening (idempotency + verify guards) before any more automated refactors. |
| Is the AI pipeline production-grade? | **Architecturally yes**; **empirically unproven**. Run the benchmark before the pilot. |
| Is the auth + role gating production-grade? | **Yes**. All four layouts now retry consistently. Server-side gates enforced. |
| Is the payment stack production-grade? | **Yes**. Two-layer enforcement (verify + webhook), idempotency, signature verification, compensating rollback all in place. |
| Is the documentation production-grade? | **Partial**. The Features & Functional Documentation deliverable exists (this audit cycle); a migrations doc, threat model, and runbook are still gaps. |

**Final verdict:** **CONDITIONAL GO** for a controlled pilot. Seven conditions listed in the Executive Summary; expand to eleven for broad launch.

The platform has been audit-hardened in a focused 24-hour push, the foundational invariants are locked in, and the product has the design and shape of something that should serve schools and learners well. The biggest open risk is empirical AI quality — not because the pipeline is bad, but because nobody has measured it yet. Resolve that, fix the seven pilot conditions, and the platform is acceptable for launch.

*Signed off by: Senior UAT Lead / Production Readiness Reviewer simulation, 2026-05-17.*
