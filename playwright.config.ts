import { defineConfig, devices } from "@playwright/test";
import * as dotenv from "dotenv";
import * as path from "path";

// Load .env.test if it exists, then fall back to .env.local. Tests need
// NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and
// SUPABASE_SERVICE_ROLE_KEY. They will run against the same Supabase project
// the dev server uses, but every row is prefixed with `test_` so cleanup is
// trivial.
dotenv.config({ path: path.resolve(__dirname, ".env.test") });
dotenv.config({ path: path.resolve(__dirname, ".env.local") });

const PORT = Number(process.env.PLAYWRIGHT_PORT || 3000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // Each test file runs serially within itself; files run in parallel up to 2.
  // Webpack dev compile is slow on first hit per route — high parallelism
  // makes it worse because compile is single-threaded but every worker
  // wants a different route at the same time. Two workers strikes the best
  // wall-clock vs. flakiness balance on this codebase.
  fullyParallel: false,
  workers: process.env.CI ? 1 : 2,
  retries: process.env.CI ? 2 : 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  timeout: 90_000,
  expect: { timeout: 25_000 },
  globalSetup: "./tests/e2e/helpers/global-setup.ts",
  globalTeardown: "./tests/e2e/helpers/global-teardown.ts",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 25_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
