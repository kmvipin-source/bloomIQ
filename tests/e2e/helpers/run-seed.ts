/**
 * Standalone seed runner. Invoked by `npm run test:e2e:seed`.
 *
 * Use this when you want the test fixtures available in your dev DB so you
 * can manually log in and explore — without firing off the full Playwright
 * suite. Pair with `npm run test:e2e:cleanup` when you're done.
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env.local") });

import { seed } from "./seed";

seed()
  .then((r) => {
    console.log("\n[seed] complete.");
    console.log(`  schools: ${Object.keys(r.schoolIds).length}`);
    console.log(`  classes: ${Object.keys(r.classIds).length}`);
    console.log(`  users:   ${Object.keys(r.userIds).length}`);
    console.log("\nCredentials are documented in tests/e2e/CREDENTIALS.md.");
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
