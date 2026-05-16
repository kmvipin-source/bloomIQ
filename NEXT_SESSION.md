# 🚨 START HERE WHEN YOU OPEN ZCORIQ NEXT

**Date parked:** 2026-05-16
**You parked this:** Staged-launch / pilot-allowlist feature-flag system

---

## In one line

You want to **launch ZCORIQ for independent learners first**, then pilot with real schools, then go broader for schools. You asked for a platform-admin flag that supports the full lifecycle: **activate / pilot / deactivate / review / re-activate**. The design is fully scoped but **NOT YET BUILT**. You wanted to think it over.

## Your decision — three answers possible

When you're ready, open a new session and pick one:

| Answer | What happens | ETA |
|---|---|---|
| **"Go — build it as designed"** | Migration 95 + `lib/featureFlags.ts` + `/admin/feature-flags` page + 3 enforcement points + `/schools-coming-soon` waitlist page | ~1.5 days |
| **"Tweak first — change X"** | I rework the design with your changes, then you re-approve | varies |
| **"Skip it — too much infra"** | Fall back to a hardcoded `process.env.NEXT_PUBLIC_SCHOOL_LAUNCH=false`. No pilot allowlist support. | ~30 min |

## Exact phrase to resume

Open a new Claude session in this repo and say:

> **"Resume the staged-launch feature-flag work from the 2026-05-16 README block."**

I'll re-read the full design in `README.md` (look for the **🚨 OPEN DECISION** block at the very top) and execute whichever option you picked.

## Quick design recap (full version is in README.md top section)

- **3 tables:** `platform_flags`, `platform_flag_overrides`, `platform_flag_audit`
- **3 starter flags:** `school_marketing_visible`, `school_signup_enabled`, `independent_signup_enabled`
- **1 evaluator function:** `isFlagEnabledFor(flagName, { schoolId?, userId? })` — checks per-school override → per-user override → global default
- **3 enforcement points:** signup routes, pricing card, server onboarding endpoint
- **1 admin page:** `/admin/feature-flags` with global toggle + allowlist panel + audit log
- **Workflow you wanted, all supported:** activate / pilot one school / pilot many / deactivate / review / re-activate / re-deactivate — all without redeploying

## What's already shipped today (no decisions pending on these)

- ✅ ZCORIQ rebrand from BloomIQ (user-visible text + identifiers + file renames)
- ✅ Migrations 91–94 (`generation_meta`, soft-delete, rate-limit, teacher assignments) — **need `supabase db push` to take effect**
- ✅ `/teacher/generate` simplification (Advanced expander, per-Bloom counts, override picker, mismatch banner, count on Generate button)
- ✅ `/teacher/quizzes/new` modern-app improvements (URL context-carry, class auto-cascade, sticky review panel, bulk-select, recent topic chips, empty-state CTAs, auto-save & restore)
- ✅ `/teacher/review` verifier-dispute + Bloom-mismatch badges
- ✅ `/student/library` new page
- ✅ New libs: `qgenPipeline`, `bloomVerifier`, `promptSafety`, `rateLimitDb`, `embeddingTelemetry`, `useTopicValidation`, `stretchChallenge`

## First-action-on-login checklist

1. Read this file (you're doing it)
2. Skim the `🚨 OPEN DECISION` block at the top of `README.md`
3. Pick your answer (Go / Tweak / Skip)
4. Open a Claude session, paste the resume phrase above, tell me your pick
5. I take it from there

When this decision is resolved, **delete this file** — that's the signal we're done with it.

---

*This file exists only as a session-bridge reminder. It is not part of the product.*
