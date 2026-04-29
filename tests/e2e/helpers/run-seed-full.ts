/**
 * Standalone "full seed" runner: basic seed + quiz content.
 *
 * Use this for manual dashboard exploration — it produces enough data for
 * the Principal-level reports (at-risk watchlist, class comparison heatmap,
 * engagement sparklines) to render with real numbers.
 *
 * Run: `npm run test:e2e:seed:full`
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env.local") });

import { seed } from "./seed";
import { seedQuizData } from "./seed-quiz-data";

(async () => {
  try {
    const r = await seed();
    await seedQuizData();
    console.log("\n[seed:full] complete.");
    console.log(`  schools: ${Object.keys(r.schoolIds).length}`);
    console.log(`  classes: ${Object.keys(r.classIds).length}`);
    console.log(`  users:   ${Object.keys(r.userIds).length}`);
    console.log("\n  Now log in as test_super_a@bloomiq-e2e.local and visit");
    console.log("  /school/reports — try the At-risk, Compare, and Engagement tabs.");
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
