/**
 * Diagnostic: tries to sign in as every seeded test user using the browser
 * (anon-key) client, and prints the actual error from Supabase. Run with:
 *
 *   npm run test:e2e:verify
 *
 * Use this when /login says "incorrect" but you're not sure whether it's
 * really a wrong password or something else (email not confirmed, user
 * banned, etc.) — the login form swallows the underlying error.
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env.local") });

import { createClient } from "@supabase/supabase-js";
import { admin } from "./supabase-admin";
import { FIXTURES, usernameToEmail } from "./fixtures";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  if (!url || !anon) {
    console.error("Need NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in env.");
    process.exit(1);
  }

  // 1. Show admin's view of every test user so we can spot unconfirmed emails.
  console.log("\n=== Admin view of test users ===");
  const a = admin();
  const { data: list } = await a.auth.admin.listUsers({ page: 1, perPage: 200 });
  const test = (list?.users || []).filter(
    (u) =>
      u.email?.toLowerCase().startsWith("test_") &&
      (u.email?.endsWith("@bloomiq-e2e.local") || u.email?.endsWith("@bloomiq.invalid"))
  );
  for (const u of test) {
    console.log(
      `  ${u.email}  confirmed=${!!u.email_confirmed_at}  banned=${!!(u as { banned_until?: string }).banned_until}`
    );
  }

  // 2. Attempt browser-style login for each canonical fixture.
  console.log("\n=== Sign-in attempts (using anon key, just like the browser) ===");
  const fixtureKeys = [
    "superTeacherA",
    "superTeacherB",
    "teacherA",
    "teacherA2",
    "teacherB",
    "studentA1",
    "studentA2",
    "studentB1",
    "independentStudent",
  ] as const;

  for (const key of fixtureKeys) {
    const f = FIXTURES[key];
    const email = "email" in f ? f.email : usernameToEmail(f.username);
    const sb = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sb.auth.signInWithPassword({
      email,
      password: f.password,
    });
    if (error) {
      console.log(`  FAIL ${key} (${email}): ${error.message}`);
    } else {
      console.log(`  OK   ${key} (${email}) → user.id=${data.user?.id}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
