import { test, expect } from "@playwright/test";

// /login is the unified front door — it picks an audience (school vs
// independent learner) before routing to the appropriate sign-in form.
// Smoke test verifies both audience cards render without runtime errors.
test("login front door renders audience picker", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
  await expect(page.getByText(/for schools/i)).toBeVisible();
  await expect(page.getByText(/for.*independent|personal learner/i).first()).toBeVisible();
});
