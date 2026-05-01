-- =============================================================================
-- Migration 36 — close 'schools read by code' + 'classes read by code'
-- -----------------------------------------------------------------------------
-- Both policies were `for select to authenticated using (true)`, which let
-- every authenticated user enumerate every school + every class along with
-- the join codes. Drop them.
--
-- Code prerequisite (already merged in this PR):
--   - POST /api/student/join-class is a new admin-mediated endpoint that
--     replaces the direct from('classes').eq('join_code', code) read on
--     /student/classes.
--   - /api/school/join was already admin-mediated for the school join_code
--     lookup.
--   - The two collision-check loops on /school home that scanned schools
--     by join_code are effectively dead now (super_teacher can't see other
--     schools' rows). Probability of code collision in 32^6 space is
--     vanishingly small with single-digit school count, and the unique
--     constraint on schools.join_code catches any actual collision at
--     INSERT time. Leaving the loops in for now.
-- =============================================================================

drop policy if exists "schools read by code" on public.schools;
drop policy if exists "classes read by code" on public.classes;

notify pgrst, 'reload schema';
