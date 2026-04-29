# End-to-end tests

Playwright suite covering BloomIQ's core flows. ~130 tests across six
files, organised by role:

| File | Focus | Tests |
|---|---|---|
| `01-public-and-auth.spec.ts` | Landing, signup, login form, role redirects, logout | ~20 |
| `02-super-teacher.spec.ts` | `/school/*` admin surface | ~19 |
| `03-teacher.spec.ts` | `/teacher/*` surface, classes, quizzes, papers | ~29 |
| `04-student.spec.ts` | `/student/*` surface across all 22 feature pages | ~35 |
| `05-parent.spec.ts` | `/parent/<token>` read-only dashboard | ~10 |
| `06-authorization.spec.ts` | Cross-role / cross-school isolation | ~17 |

## One-time setup

1. Install dev deps:

   ```bash
   npm install
   npx playwright install chromium
   ```

2. Create `.env.test` (or rely on the existing `.env.local`) with:

   ```
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   SUPABASE_SERVICE_ROLE_KEY=...
   ```

   See `.env.test.example`. **The service-role key is required** — the seed
   script needs it to create test users.

## Running

| Command | What it does |
|---|---|
| `npm run test:e2e` | Run the full suite headless. Auto-starts the dev server. |
| `npm run test:e2e:headed` | Same but you watch the browser. |
| `npm run test:e2e:ui` | Playwright UI — pick & step through tests interactively. |
| `npm run test:e2e:list` | Print every test name (good for verifying the count). |
| `npm run test:e2e:report` | Open the last HTML report. |
| `npm run test:e2e:cleanup` | Delete every `test_*` row manually. |

## How the test data is managed

Every fixture is namespaced with `test_` so cleanup is foolproof:

- emails: `test_*@bloomiq-e2e.local` (real-looking, non-deliverable domain)
- usernames: `test_student_a1`, etc. (synthetic email is `test_*@bloomiq.invalid`)
- school names: `test_school_a`, `test_school_b`
- class names: `test_class_a1`, `test_class_a2`, `test_class_b1`

`globalSetup` (in `helpers/global-setup.ts`) runs before every test run:
1. Wipes any leftover `test_*` rows from a previous failed run.
2. Re-seeds the canonical fixture set: 2 super-teachers, 3 teachers,
   3 school students, 1 independent student, 2 schools, 3 classes.

`globalTeardown` runs after the suite and deletes everything `test_*`. To
inspect data after a failure, set `KEEP_TEST_DATA=1` in your env and run
manually.

## What's intentionally NOT tested

These would require either an AI mock or are too flaky for an automated
suite:

- Generating real quiz questions via Groq/Gemini
- Real OCR via tesseract.js (X-Ray's OCR path)
- Razorpay subscription checkout (sandbox flow)
- Email delivery (parent invites, password resets)

The suite asserts that the surfaces these flows live on render and accept
input — not that the AI/payment provider returns a particular answer.

## Adding a new test

1. Pick the file matching your role/area.
2. Add a `test("...", async ({ page }) => { ... })` block.
3. If you need new seed data, add it to `helpers/fixtures.ts` AND
   `helpers/seed.ts`. Keep the `test_` prefix on every name/email.
4. Run `npm run test:e2e:list` to confirm your test shows up.
5. Run with `--headed` while iterating; switch to headless before pushing.

## Debugging a failing test

```bash
# Show me the failing test's last screenshot/video/trace:
npm run test:e2e:report

# Re-run a single file:
npx playwright test tests/e2e/03-teacher.spec.ts

# Re-run a single test by name:
npx playwright test -g "lists teacherA's seeded class"

# Step through with the inspector:
PWDEBUG=1 npx playwright test tests/e2e/03-teacher.spec.ts
```

## Known gotchas

- The dev server uses `next dev --webpack`, which is slow on first request.
  Playwright's `webServer.timeout` is 120s; if the first test still fails
  with a navigation timeout, prewarm with `npm run dev` in another shell.
- The `profiles read all auth` and `quizzes read by code` RLS policies
  (see `rls_audit.md` in the workspace root) currently let any authenticated
  user read every other profile and quiz. Some of the cross-role tests in
  `06-authorization.spec.ts` therefore assert that the **UI** does the
  filtering — they will keep passing after the RLS is tightened.
