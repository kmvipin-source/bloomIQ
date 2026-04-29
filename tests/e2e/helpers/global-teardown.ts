/**
 * Playwright globalTeardown. Runs ONCE after every test finishes.
 *
 * Removes every `test_*` row from Supabase. Skipped if KEEP_TEST_DATA=1 is
 * set in the env so you can poke around in the dashboard after a failing
 * run.
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env.local") });

import { cleanup } from "./cleanup";

export default async function globalTeardown() {
  if (process.env.KEEP_TEST_DATA === "1") {
    console.log("[globalTeardown] KEEP_TEST_DATA=1 — skipping cleanup.");
    return;
  }
  try {
    await cleanup();
  } catch (e) {
    console.warn("[globalTeardown] cleanup failed:", (e as Error).message);
  }
}
