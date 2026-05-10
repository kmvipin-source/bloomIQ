import { test, expect } from "@playwright/test";

// Landing page is the most-trafficked surface and depends on the
// PublicNav, Sentry client init, and the hero CSS variables. If this
// renders, the client bundle is healthy.
test("landing page loads with pricing CTA", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/BloomIQ/i);
  await expect(page.getByRole("link", { name: /pricing/i }).first()).toBeVisible();
});
