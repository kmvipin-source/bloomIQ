/**
 * Playwright globalSetup. Runs ONCE before any test starts.
 *
 *   1. Loads env from .env.test (preferred) or .env.local.
 *   2. Cleans any leftover `test_*` rows from a previous failed run.
 *   3. Re-seeds the canonical fixture set so every test can rely on it.
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env.local") });

import { cleanup } from "./cleanup";
import { seed } from "./seed";

export default async function globalSetup() {
  console.log("[playwright globalSetup] env-check & seed");
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL is not set. Add .env.test (or use .env.local)."
    );
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Tests need it to create/destroy users."
    );
  }
  // Best-effort cleanup before seeding. If a previous run died mid-way the
  // seed step is otherwise idempotent so this is just hygiene.
  try {
    await cleanup();
  } catch (e) {
    console.warn("[globalSetup] pre-cleanup failed (continuing):", (e as Error).message);
  }
  await seed();
}
