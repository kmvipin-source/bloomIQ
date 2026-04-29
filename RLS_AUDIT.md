# BloomIQ Supabase RLS Audit

## 1. Summary

BloomIQ's RLS layer is correctly enabled on every table I inspected, but several policies are too permissive for a multi-tenant, multi-school app. The most serious issues are concentrated in tables defined in `supabase/schema.sql`: `profiles`, `quizzes`, `quiz_questions`, and `question_bank` all have `to authenticated using (true)` SELECT policies that were never narrowed by later migrations. This lets any logged-in user read every other user's profile (including `parent_email`, `parent_name`, `username`, `school_id`), every quiz row in the database, every quiz->question link, and every approved question stem across all schools. `classes` and `schools` also have `to authenticated using (true)` "lookup by join code" SELECT policies that expose the full row, including the join code itself, to any authenticated user. Several feature tables (xrays, knowledge graphs, srs_reviews, etc.) are correctly scoped to `auth.uid()`. App routes do practice some defence in depth via the service-role client, but several student-facing reads (profiles, quizzes) go through the user-token client and rely entirely on RLS.

## 2. Source-of-truth question

`RESET_AND_REBUILD.sql` is **NOT** the current source of truth. It only inlines `schema.sql` plus migrations 01-11 (the file ends at line 1245 with migration 11; see `supabase/RESET_AND_REBUILD.sql:1199` for the last `==` header). Migrations 12-17, which add `teach_back_sessions`, `misconceptions`, `bloom_climber_*`, `past_paper_xrays`, `past_paper_xray_questions`, `speed_sessions`, `distractor_traps`, `mock_rank_predictions`, `exam_sprint_settings`, `concept_animations`, `srs_reviews`, `confidence_calibrations`, `parent_invites`, `knowledge_graphs`, plus the `xray_questions.answer/explanation` and `quizzes.recommended_minutes` additions, are missing from RESET_AND_REBUILD. **The live deployed schema is the cumulative effect of `schema.sql` + `migrations/01_*.sql` ... `17_*.sql`.** RESET_AND_REBUILD must be regenerated before it can be trusted as a rebuild target.

## 3. Per-table audit

| Table | RLS | SELECT summary | INS/UPD/DEL summary | Risk | Rationale |
|---|---|---|---|---|---|
| profiles | yes | self + ANY auth (`profiles read all auth`, schema.sql:24) + super-teacher of school | self insert/update only | HIGH | "read all auth" lets every logged-in user read PII (parent_email, parent_name, username) for every user. |
| schools | yes | super_teacher OR member-of-school OR ANY auth (`schools read by code`, 07_school_join_code.sql:14) | super inserts; super updates own school | MEDIUM | "read by code" is `to authenticated using (true)` — exposes every school row including `join_code`, letting any user enumerate schools and their join codes. |
| classes | yes | class teacher OR super OR ANY auth (`classes read by code`, 04_multi_teacher_classes.sql:50) | super insert/update/delete; primary update/delete | MEDIUM | Same shape: any auth user can read every class row + join_code. |
| class_members | yes | self student, class teacher, super | student self, primary manage | LOW | Primary teacher / super filters; cross-school blocked. |
| class_teachers | yes | self, class teacher, super | super manage, primary manage | LOW | School-scoped helpers used. |
| class_teacher_invites | yes | super, class teachers | super manage, primary manage | LOW | School-scoped via `is_super_for_school`. |
| quiz_assignments | yes | quiz owner, primary, super, target student | quiz owner all, but check requires teacher-of-target | LOW | INSERT check binds to `is_class_teacher` / `is_teacher_for_student`. |
| quizzes | yes | owner, super, ANY auth (`quizzes read by code`, schema.sql:68) | owner all | HIGH | Authenticated users in any school can list every teacher's quizzes (id, name, code, owner_id, subject, topic_family, time_limit_minutes). |
| quiz_questions | yes | ANY auth (`qq read auth`, schema.sql:78) | quiz owner | HIGH | Lets any authenticated user enumerate every quiz->question pairing across all schools. |
| question_bank | yes | owner; ANY auth where `status='approved'` (`qb read approved`, schema.sql:50) | owner all | HIGH | Approved questions are readable by every authenticated user across schools. Owner-controlled `status` column gates a global read. |
| quiz_attempts | yes | student self, quiz owner, primary teacher, super | student self only | LOW | Properly bound to relations. |
| attempt_answers | yes | student self (via attempt), quiz owner, primary teacher | student self | LOW | OK. |
| alerts | yes | quiz owner of `quiz_id` only | quiz owner only | MEDIUM | No policy grants the student themselves access to their own alerts. Also if alerts.quiz_id is null, no one can see them via RLS. |
| subscriptions | yes | self user OR school members (11_school_subscriptions.sql:36) | none (service-role only) | LOW | School members reads OK. |
| subscription_limits | yes | ANY auth | none | NONE | Public config table; no PII. |
| student_logins | yes | self, primary teacher of student | none (service-role inserts) | LOW | OK. |
| student_password_resets | yes | primary teacher only | none | LOW | OK. |
| exam_papers | yes | owner only (08_exam_papers.sql:18) | owner only | MEDIUM | School admin and co-primary cannot view a teacher's papers, but cross-school is blocked. No `school_id` so principal cannot see school papers. |
| exam_paper_questions | yes | via parent paper owner | via parent paper owner | MEDIUM | Same; school-admin visibility hole. |
| teach_back_sessions | yes | self only | self only | NONE | OK. |
| misconceptions | yes | self only | self only | NONE | OK. |
| bloom_climber_state | yes | self only | self only | NONE | OK. |
| bloom_climber_streaks | yes | self only | self only | NONE | OK. |
| past_paper_xrays | yes | self only | self only | NONE | OK. |
| past_paper_xray_questions | yes | via parent xray | via parent xray | NONE | OK. |
| speed_sessions | yes | self only | self only | NONE | OK. |
| distractor_traps | yes | self only | self only | NONE | OK. |
| mock_rank_predictions | yes | self only | self only | NONE | OK. |
| exam_sprint_settings | yes | self only | self only | NONE | OK. |
| concept_animations | yes | self only | self only | NONE | OK. |
| srs_reviews | yes | self only | self only | NONE | OK. |
| confidence_calibrations | yes | self only | self only | NONE | OK. |
| parent_invites | yes | self student only | self student only | LOW | API uses service-role to read by token (intentional). |
| knowledge_graphs | yes | self only | self only | NONE | OK. |

## 4. Critical and High findings

- **HIGH — `profiles` "read all auth" leaks PII** (`supabase/schema.sql:24-25`, mirrored in `RESET_AND_REBUILD.sql:36-37`). The policy `for select to authenticated using (true)` is never dropped by later migrations. After migration 02, profiles holds `username`, `parent_email`, `parent_name`, plus `school_id` (from migration 06), so every authenticated student can list every other user's parent contact info across all schools. Fix sketch:
  ```sql
  drop policy if exists "profiles read all auth" on public.profiles;
  create policy "profiles read same school" on public.profiles
    for select using (
      auth.uid() = id
      or public.is_super_for_user(id)
      or (school_id is not null and school_id in (
            select school_id from public.profiles where id = auth.uid()))
    );
  ```

- **HIGH — `quizzes` "read by code" is open to all auth** (`supabase/schema.sql:68-69`; never dropped — see grep on `drop policy.*quizzes` only finding `quizzes super read`). Combined with `qq read auth` it lets a teacher in school B list every quiz a teacher in school A has built, and (via `quiz_questions` join) which approved questions are in them. Fix sketch:
  ```sql
  drop policy if exists "quizzes read by code" on public.quizzes;
  create policy "quizzes read for assigned" on public.quizzes
    for select using (
      owner_id = auth.uid()
      or public.is_super_for_user(owner_id)
      or exists (
        select 1 from public.quiz_assignments qa
        left join public.class_members m on m.class_id = qa.class_id
        where qa.quiz_id = quizzes.id
          and (qa.student_id = auth.uid() or m.student_id = auth.uid())
      )
    );
  ```

- **HIGH — `quiz_questions` "qq read auth" is open** (`supabase/schema.sql:78-79`). Same shape as above. Fix sketch:
  ```sql
  drop policy if exists "qq read auth" on public.quiz_questions;
  create policy "qq read by quiz reader" on public.quiz_questions
    for select using (
      exists (select 1 from public.quizzes q where q.id = quiz_id)
      -- the quizzes RLS will further constrain to the teacher/student/super
    );
  ```
  (After tightening `quizzes`, the `exists` check inherits the same scope.)

- **HIGH — `question_bank` "qb read approved" is open** (`supabase/schema.sql:50-51`). Any teacher who marks their question `approved` makes it world-readable to every authenticated user. Fix sketch: scope by quiz reachability, e.g.
  ```sql
  drop policy if exists "qb read approved" on public.question_bank;
  create policy "qb read approved via quiz" on public.question_bank
    for select using (
      status = 'approved' and exists (
        select 1 from public.quiz_questions qq
        join public.quizzes q on q.id = qq.quiz_id
        where qq.question_id = question_bank.id
        -- quizzes RLS already restricts q
      )
    );
  ```

## 5. Medium findings

- **MEDIUM — `schools` "read by code" exposes every school + its `join_code`** (`supabase/migrations/07_school_join_code.sql:13-14`). Fix sketch — keep it but project less by switching the policy to a security-definer function `lookup_school_by_code(text)`, or accept it as-needed-for-join and rotate join codes routinely.
- **MEDIUM — `classes` "read by code" exposes every class + join_code** (`supabase/migrations/04_multi_teacher_classes.sql:50-51`). Same shape and fix as schools.
- **MEDIUM — `alerts` has no student-self read** (`supabase/schema.sql:145-149`). Students cannot read their own alerts via RLS. Fix sketch:
  ```sql
  create policy "alerts student own" on public.alerts
    for select using (auth.uid() = student_id);
  ```
- **MEDIUM — `exam_papers` and `exam_paper_questions` are owner-only** (`supabase/migrations/08_exam_papers.sql:18-19, 40-46`). A school admin cannot see papers for accountability, and there is no `school_id` column on the row. Cross-school is correctly blocked, but the school principal also has no visibility. Fix sketch (additive, school-admin read):
  ```sql
  create policy "papers super read" on public.exam_papers
    for select using (public.is_super_for_user(owner_id));
  create policy "epq super read" on public.exam_paper_questions
    for select using (
      exists (select 1 from public.exam_papers p
              where p.id = paper_id and public.is_super_for_user(p.owner_id))
    );
  ```

## 6. Low findings / nits

- `classes.owner_id` was made nullable in migration 06, but the original `classes owner all` policy is dropped (`migrations/04_multi_teacher_classes.sql:43`). No INSERT/DELETE policy exists for the `authenticated` role on `classes` — only super-teacher inserts. A regular teacher cannot create a class even if intended; confirm with product.
- `quiz_assignments` — `assign student read` (schema.sql via migration 01:33-37) lets a student read assignments where `student_id = auth.uid()` — fine. But no policy lets the assigning teacher see assignments by other teachers in the same class besides quiz-owner; likely OK by design.
- `RESET_AND_REBUILD.sql` is stale (see Section 2). Not a vulnerability per se, but if a fresh staging environment is ever rebuilt from it, migrations 12-17 (xrays, parent_invites, knowledge_graphs, srs, etc.) will silently be missing.
- `subscription_limits` is world-readable; intentional (config table).
- `is_super_for_user` (`migrations/06_class_naming_and_school.sql:60-67`) reads `profiles me where me.school_id = them.school_id` — relies on `me.school_id` not being NULL; OK.

## 7. App-layer compensations observed

Several routes use the service-role client (`supabaseAdmin()` in `lib/supabase/server.ts:26-38`) and re-check `school_id` / `owner_id` in JS:

- `app/api/admin/students/route.ts:77-80` re-verifies `cls.owner_id === user.id` after a service-role read.
- `app/api/admin/classes/route.ts:53-67` enforces `role === 'super_teacher'` and `school_id` before any service-role DB write.
- `app/api/teacher/classes/route.ts:46-77` uses service-role to read `class_teachers` joined to `classes` after authenticating the bearer token, intentionally to bypass RLS gaps in the teacher-roster surface.
- `app/api/parent/data/route.ts:35-55` uses service-role and explicitly notes "We're careful to filter EVERY query by the student_id we resolved from the token" — good.
- `app/api/school/join/route.ts:31-40` uses service-role to look up `schools` by `join_code` then patches `profiles.school_id` for the caller.

These compensate for the missing RLS in the admin paths, but **student-facing reads of `profiles`, `quizzes`, `quiz_questions`, and `question_bank` are NOT funnelled through API routes** in the codebase I scanned — students hit Supabase directly with their bearer token, so the HIGH findings in section 4 are not mitigated by app code.

## 8. Recommended manual verification

Run as a teacher logged into school A (token-scoped Supabase JS or psql with a JWT for that user):

```sql
-- 1. Should return only same-school + self after fix; today returns ALL
select id, full_name, parent_email, school_id from public.profiles limit 50;

-- 2. Today returns every quiz in DB; should be only own + assigned
select id, owner_id, name, code from public.quizzes where owner_id <> auth.uid() limit 20;

-- 3. Today returns every quiz_question across the platform
select quiz_id, question_id, position from public.quiz_questions limit 20;

-- 4. Today returns every approved question stem across schools
select id, owner_id, stem, status from public.question_bank where status = 'approved' and owner_id <> auth.uid() limit 20;

-- 5. Today returns every school row including join_code
select id, name, join_code, super_teacher_id from public.schools limit 20;

-- 6. Today returns every class row including join_code
select id, name, school_id, join_code from public.classes where school_id <> (select school_id from public.profiles where id = auth.uid()) limit 20;

-- 7. Should return zero rows for both school A and school B (good control)
select id, owner_id, name from public.exam_papers where owner_id <> auth.uid() limit 20;

-- 8. Should return zero rows from another student's data (good control)
select * from public.past_paper_xrays where user_id <> auth.uid() limit 5;
select * from public.knowledge_graphs where user_id <> auth.uid() limit 5;
select * from public.srs_reviews where user_id <> auth.uid() limit 5;
```

After applying the fix sketches in Section 4, queries 1-6 should return zero rows for cross-tenant data. Queries 7-8 are controls and should already return zero rows today.
