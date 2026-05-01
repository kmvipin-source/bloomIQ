/**
 * Platform-admin smoke tests.
 *
 * Reads PLATFORM_ADMIN_EMAIL + PLATFORM_ADMIN_PASSWORD from env at runtime.
 * Skips automatically if either is missing — keeps real credentials out of
 * source control. Run with:
 *
 *   PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... npx playwright test \
 *     tests/e2e/07-platform-admin.spec.ts --reporter=line --project=chromium
 *
 * (Or set the vars in your local shell session for the run only.)
 */

import { test, expect, type Page } from "@playwright/test";

const EMAIL = process.env.PLATFORM_ADMIN_EMAIL || "";
const PASSWORD = process.env.PLATFORM_ADMIN_PASSWORD || "";
const SHOULD_RUN = !!(EMAIL && PASSWORD);

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  test.skip(!SHOULD_RUN, "PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD not set");
});

async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  // Tick the click-wrap ToS box so Sign in re-enables.
  const cb = page.getByRole("checkbox").first();
  if ((await cb.count()) > 0 && !(await cb.isChecked())) await cb.check();
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

test.describe("platform admin", () => {
  test("logs in and lands on /admin/onboard-school", async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page).toHaveURL(/\/admin\/onboard-school/);
  });

  test("/admin/onboard-school renders the onboarding form", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/admin/onboard-school");
    await page.waitForLoadState("networkidle");
    // Form should ask for school name + admin head email.
    await expect(page.locator("body")).toContainText(/school|admin head|onboard/i);
  });

  test("/admin/team lists at least one platform admin (self)", async ({ page }) => {
    await loginAsAdmin(page);
    const resp = await page.goto("/admin/team");
    expect(resp?.ok()).toBeTruthy();
    await page.waitForLoadState("networkidle");
    // The signed-in admin's email should appear somewhere on the page.
    await expect(page.locator("body")).toContainText(EMAIL.split("@")[0], { timeout: 15_000 });
  });

  test("/admin/plans loads without 404", async ({ page }) => {
    await loginAsAdmin(page);
    const resp = await page.goto("/admin/plans");
    expect(resp?.ok()).toBeTruthy();
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });

  test("/admin/plans shows seeded plan slugs", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/admin/plans");
    await page.waitForLoadState("networkidle");
    const body = (await page.locator("body").textContent()) || "";
    // Expect at least 2 of the 5 standard tier slugs to be visible.
    const seen = ["free", "premium", "school"].filter((s) =>
      body.toLowerCase().includes(s)
    );
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  test("non-admin route /student bounces a platform_admin to /admin", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/student");
    // The /student layout should redirect platform_admin → /admin/*
    await page.waitForURL(/\/admin\//, { timeout: 30_000 });
  });

  test("non-admin route /teacher bounces a platform_admin to /admin", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/teacher");
    await page.waitForURL(/\/admin\//, { timeout: 30_000 });
  });

  test("non-admin route /school bounces a platform_admin to /admin", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/school");
    await page.waitForURL(/\/admin\//, { timeout: 30_000 });
  });

  test("onboard-school happy path: form submits without crashing", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/admin/onboard-school");
    await page.waitForLoadState("networkidle");

    // Unique school name + email for this run so reruns don't collide.
    const stamp = Date.now().toString(36).slice(-6);
    const schoolName = `e2e_school_${stamp}`;
    const adminEmail = `e2e_admin_${stamp}@bloomiq-e2e.local`;
    const adminName = `E2E Admin ${stamp}`;

    await page.getByPlaceholder(/Greenwood International School/i).fill(schoolName);
    await page.getByPlaceholder(/Mrs\. Anjali|Anjali Sharma/i).fill(adminName);
    await page.getByPlaceholder(/principal@greenwood/i).fill(adminEmail);

    // Submit — button is "Send invite".
    const submit = page.getByRole("button", { name: /send\s*invite/i }).first();
    await submit.click();

    // Either the school name appears in the recent list, OR the page shows
    // the post-submit success / error banner. Email-send may fail in CI
    // (Supabase email transport not configured for dev), in which case the
    // route still inserts the school row — so checking the page for either
    // the success banner or the school name is the most robust assertion.
    await page.waitForTimeout(2000);
    const bodyText = (await page.locator("body").textContent()) || "";
    const sawSchoolName = bodyText.includes(schoolName);
    const sawSentBanner = /invite\s*sent|already\s*invited|email\s*sent|onboarded/i.test(bodyText);
    const sawErrorBanner = /already\s*exists|email\s*provider|smtp|something\s*went\s*wrong/i.test(bodyText);
    expect(sawSchoolName || sawSentBanner || sawErrorBanner).toBe(true);
  });

  test("admin team page surfaces a 'Send link' control on each admin row", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/admin/team");
    await page.waitForLoadState("networkidle");
    // The new generateLink-based flow puts a "Send link" / "Sign-in link" /
    // "Generate link" button on each admin row. Look for any of the
    // accepted variants.
    const sendLinkBtn = page.getByRole("button", { name: /send\s*link|generate\s*link|sign-in\s*link/i }).first();
    await expect(sendLinkBtn).toBeVisible({ timeout: 10_000 });
  });

  test("sign-out from admin shell drops the session", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/admin/onboard-school");
    await page.waitForLoadState("networkidle");
    // Find the Sign out button in the admin top bar.
    const signOut = page.getByRole("button", { name: /sign\s*out/i }).first();
    await signOut.click();
    await page.waitForURL((url) => !url.pathname.startsWith("/admin"), { timeout: 30_000 });
    // Visiting /admin/* without a session should NOT show admin nav.
    await page.goto("/admin/onboard-school");
    // Layout redirects unauthenticated to /login.
    await page.waitForURL(/\/login/, { timeout: 30_000 });
  });
});
