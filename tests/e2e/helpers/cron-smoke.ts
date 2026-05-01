/**
 * Smoke-tests POST /api/cron/expire-subscriptions.
 *
 * Reads CRON_SECRET + (optionally) CRON_BASE_URL from env. Defaults base to
 * http://localhost:3000 so it works against the local dev server. Hits the
 * route with the Bearer secret and asserts a 2xx response. Run with:
 *
 *   CRON_SECRET=<secret> npm run cron:smoke
 *   # or against prod:
 *   CRON_BASE_URL=https://your-domain.app CRON_SECRET=<secret> npm run cron:smoke
 *
 * NOT a test fixture — it's a one-shot ops health-check. Exit code 0 = pass,
 * non-zero = fail. Prints body on failure for triage.
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const SECRET = process.env.CRON_SECRET || "";
const BASE = (process.env.CRON_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

(async () => {
  if (!SECRET) {
    console.error("[cron:smoke] CRON_SECRET not set. Add it to .env.local or pass inline.");
    process.exit(2);
  }
  const url = `${BASE}/api/cron/expire-subscriptions`;
  console.log(`[cron:smoke] POST ${url}`);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    });
  } catch (e) {
    console.error("[cron:smoke] network failure:", e instanceof Error ? e.message : e);
    process.exit(3);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    console.error(`[cron:smoke] non-2xx response: ${res.status}\n${text}`);
    process.exit(1);
  }
  console.log(`[cron:smoke] ok (${res.status}). body=${text.slice(0, 400)}`);
  process.exit(0);
})();
