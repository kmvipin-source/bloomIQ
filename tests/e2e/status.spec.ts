import { test, expect } from "@playwright/test";

// /status is the human-friendly view of /api/healthz. It is a client
// component that fetches the JSON heartbeat on mount and renders a
// green / red banner. Failure here means the client bundle can't reach
// the API or the API itself is down.
test("/status renders green banner when healthy", async ({ page }) => {
  await page.goto("/status");
  await expect(page.getByText(/all systems operational/i)).toBeVisible({ timeout: 15_000 });
});
