/**
 * Cleanup script — deletes every row this test suite created.
 *
 * Strategy:
 *   1. Delete schools whose name starts with `test_school_` (cascades to
 *      classes via classes.school_id → cascades to class_members,
 *      quiz_assignments).
 *   2. Find every auth user whose email is `test_*@bloomiq-e2e.local` or
 *      `test_*@bloomiq.invalid` and delete them. Profile rows reference
 *      auth.users with `on delete cascade`, and profile rows are referenced
 *      by quizzes, exam_papers, class_members, attempts etc. with the same
 *      cascade — so deleting auth users cleans up the whole tree.
 *   3. Belt & braces: delete any orphan rows in quizzes / exam_papers whose
 *      name still starts with `test_`.
 *
 * The script is safe to run multiple times. It only touches rows whose
 * identifier starts with `test_` — anything else is left alone.
 *
 * Run: npm run test:e2e:cleanup
 */

import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(__dirname, "../../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env.local") });

import { admin } from "./supabase-admin";
import { TEST_PREFIX, TEST_DOMAIN } from "./fixtures";

async function deleteTestSchools() {
  const sb = admin();
  const { data: schools, error } = await sb
    .from("schools")
    .select("id, name")
    .like("name", `${TEST_PREFIX}%`);
  if (error) {
    console.warn("[cleanup] schools query failed:", error.message);
    return 0;
  }
  if (!schools || schools.length === 0) return 0;
  const ids = schools.map((s) => s.id);
  const { error: delErr } = await sb.from("schools").delete().in("id", ids);
  if (delErr) {
    console.warn("[cleanup] school delete failed:", delErr.message);
    return 0;
  }
  return schools.length;
}

async function deleteTestAuthUsers() {
  const sb = admin();
  let page = 1;
  const perPage = 200;
  const matched: { id: string; email: string }[] = [];
  // listUsers is paginated; we walk every page because the project may have
  // thousands of real users. We only mark rows whose email matches our
  // prefixes.
  // Hard cap of 50 pages (10_000 users) defends against an infinite loop if
  // the API ever changes shape.
  for (let i = 0; i < 50; i++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage });
    if (error) {
      console.warn("[cleanup] listUsers failed:", error.message);
      break;
    }
    if (!data || !data.users || data.users.length === 0) break;
    for (const u of data.users) {
      const email = (u.email || "").toLowerCase();
      const isTest =
        email.startsWith(TEST_PREFIX) &&
        (email.endsWith(`@${TEST_DOMAIN}`) || email.endsWith("@bloomiq.invalid"));
      if (isTest) matched.push({ id: u.id, email });
    }
    if (data.users.length < perPage) break;
    page++;
  }
  let deleted = 0;
  for (const u of matched) {
    const { error } = await sb.auth.admin.deleteUser(u.id);
    if (error) {
      console.warn(`[cleanup] deleteUser ${u.email} failed:`, error.message);
    } else {
      deleted++;
    }
  }
  return deleted;
}

async function deleteOrphanRows() {
  const sb = admin();
  let total = 0;
  // Quizzes / papers may have been created with `test_` names but escaped the
  // cascade if the owner was deleted manually outside the test run.
  for (const table of ["quizzes", "exam_papers"]) {
    const { data, error } = await sb
      .from(table)
      .delete()
      .like("name", `${TEST_PREFIX}%`)
      .select("id");
    if (error) {
      console.warn(`[cleanup] orphan ${table} delete failed:`, error.message);
      continue;
    }
    if (data) total += data.length;
  }
  // class_teacher_invites and parent_invites may carry test_ tokens.
  for (const table of ["parent_invites", "class_teacher_invites"]) {
    const { data, error } = await sb
      .from(table)
      .delete()
      .like("token", `${TEST_PREFIX}%`)
      .select("id");
    if (error) {
      // table may not have a token column — ignore silently
      continue;
    }
    if (data) total += data.length;
  }
  return total;
}

export async function cleanup() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "[cleanup] env vars missing. Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local or .env.test"
    );
  }
  console.log("[cleanup] starting...");
  const schools = await deleteTestSchools();
  const users = await deleteTestAuthUsers();
  const orphans = await deleteOrphanRows();
  console.log(
    `[cleanup] done. schools=${schools}, auth_users=${users}, orphan_rows=${orphans}`
  );
  return { schools, users, orphans };
}

// To run directly use the standalone wrapper: `npm run test:e2e:cleanup`.
// (which executes `tsx tests/e2e/helpers/run-cleanup.ts`).
