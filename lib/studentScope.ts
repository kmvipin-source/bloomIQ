import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * lib/studentScope.ts
 *
 * Helpers for keeping a school student's "official" stats — class
 * quizzes assigned by their teacher — strictly separated from any
 * personal practice they might do on their own. Class quizzes tie back
 * to the class, the teacher, and the school as an academic record;
 * personal practice is informal self-study and shouldn't influence
 * the headline numbers a teacher or parent would care about.
 *
 * The contract is simple: callers pass a Supabase client + the
 * student's user_id, and get back the set of quiz_ids that count as
 * "class quizzes" for this student. Anything else is by definition
 * personal practice.
 *
 * RLS does the heavy lifting: a school student's `quiz_assignments`
 * read policy returns rows assigned either to a class they belong to
 * or to them directly. So we can query without explicit filters and
 * trust the database to restrict the result.
 */

/**
 * Load the set of quiz_ids that have been formally assigned to a
 * student — either at the class level (because they're a member of
 * the class) or directly to them.
 *
 * Returns a Set for O(1) membership tests when filtering attempt
 * lists down to "class-only" view.
 *
 * Empty set on miss is intentional: a brand-new student with no
 * assignments yet should see zero class quizzes, not all of them.
 */
export async function loadClassQuizIds(
  sb: SupabaseClient,
): Promise<Set<string>> {
  const { data, error } = await sb
    .from("quiz_assignments")
    .select("quiz_id");
  if (error) return new Set();
  type Row = { quiz_id: string };
  return new Set(((data as Row[] | null) || []).map((r) => r.quiz_id).filter(Boolean));
}

/**
 * Filter a list of attempts (with a quiz_id field) down to those
 * whose quiz is in the class-quiz set. Caller decides what to do
 * with the discarded rows — usually they're personal practice and
 * shouldn't appear in school-flow aggregates at all.
 */
export function filterToClassAttempts<T extends { quiz_id: string }>(
  attempts: T[],
  classQuizIds: Set<string>,
): T[] {
  return attempts.filter((a) => classQuizIds.has(a.quiz_id));
}

/**
 * For a school admin / super-teacher view: load the set of quiz_ids
 * that have been assigned to any class belonging to the given list
 * of classIds. Use this to scope every roll-up of student attempts
 * down to "class-assigned only" — never include the student's
 * personal practice in school-level dashboards or reports.
 *
 * Pass an empty list and you get an empty set (caller should treat
 * empty-set as "no class data" and short-circuit accordingly).
 */
export async function loadClassQuizIdsForClasses(
  sb: SupabaseClient,
  classIds: string[],
): Promise<Set<string>> {
  if (classIds.length === 0) return new Set();
  const { data, error } = await sb
    .from("quiz_assignments")
    .select("quiz_id")
    .in("class_id", classIds);
  if (error) return new Set();
  type Row = { quiz_id: string };
  return new Set(((data as Row[] | null) || []).map((r) => r.quiz_id).filter(Boolean));
}
