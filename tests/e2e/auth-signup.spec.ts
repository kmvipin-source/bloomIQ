import { test, expect } from "@playwright/test";

// We deliberately do NOT submit the signup form against prod from CI —
// every run would create a real Supabase user, even with a `+ci` alias,
// and pollute auth.users. Instead, smoke the form's surface: route
// renders, role tiles show, and clicking through to ?role=student
// surfaces the actual email/password form.
test("signup page renders role picker + student form", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByRole("link", { name: /independent student/i })).toBeVisible();
  await page.goto("/signup?role=student");
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
});
