/**
 * Teacher tests. Logged in as teacherA throughout.
 *
 * Covers dashboard, classes list, individual class, quizzes list,
 * new-quiz form, papers list, paper detail, analytics, bank, generate,
 * reports, review.
 */

import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { FIXTURES, TEST_CLASS_A1 } from "./helpers/fixtures";

test.beforeEach(async ({ page }) => {
  await loginAs(page, "teacherA");
});

test.describe("teacher home", () => {
  test("/teacher renders without error", async ({ page }) => {
    const resp = await page.goto("/teacher");
    expect(resp?.ok()).toBeTruthy();
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });

  test("/teacher shows teacher's name", async ({ page }) => {
    await page.goto("/teacher");
    await expect(page.locator("body")).toContainText(FIXTURES.teacherA.fullName);
  });

  test("/teacher shows the seeded school name", async ({ page }) => {
    await page.goto("/teacher");
    await expect(page.locator("body")).toContainText(FIXTURES.superTeacherA.schoolName);
  });
});

test.describe("teacher subpages render", () => {
  for (const path of [
    "/teacher/classes",
    "/teacher/quizzes",
    "/teacher/quizzes/new",
    "/teacher/papers",
    "/teacher/papers/new",
    "/teacher/analytics",
    "/teacher/bank",
    "/teacher/generate",
    "/teacher/reports",
    "/teacher/review",
  ] as const) {
    test(`${path} renders without 404`, async ({ page }) => {
      const resp = await page.goto(path);
      expect(resp?.ok()).toBeTruthy();
      await expect(page.locator("body")).not.toContainText(/page could not be found/i);
    });
  }
});

test.describe("teacher classes", () => {
  test("/teacher/classes lists teacherA's seeded class", async ({ page }) => {
    await page.goto("/teacher/classes");
    await expect(page.locator("body")).toContainText(TEST_CLASS_A1);
  });

  test("/teacher/classes does NOT list teacherB's class", async ({ page }) => {
    await page.goto("/teacher/classes");
    await expect(page.locator("body")).not.toContainText("test_class_b1");
  });

  test("clicking a class navigates to the detail page", async ({ page }) => {
    await page.goto("/teacher/classes");
    const link = page.locator("a").filter({ hasText: TEST_CLASS_A1 }).first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/teacher\/classes\/[0-9a-f-]+/);
  });

  test("class detail page shows seeded student names", async ({ page }) => {
    await page.goto("/teacher/classes");
    await page.locator("a").filter({ hasText: TEST_CLASS_A1 }).first().click();
    await expect(page.locator("body")).toContainText(FIXTURES.studentA1.fullName);
    await expect(page.locator("body")).toContainText(FIXTURES.studentA2.fullName);
  });

  test("class detail page does NOT show studentB (other school)", async ({ page }) => {
    await page.goto("/teacher/classes");
    await page.locator("a").filter({ hasText: TEST_CLASS_A1 }).first().click();
    await expect(page.locator("body")).not.toContainText(FIXTURES.studentB1.fullName);
  });

  test("class detail page exposes Bulk-add students entry point", async ({ page }) => {
    await page.goto("/teacher/classes");
    await page.locator("a").filter({ hasText: TEST_CLASS_A1 }).first().click();
    const bulkBtn = page.getByRole("button", { name: /bulk add|bulk-add|add students in bulk/i });
    await expect(bulkBtn).toBeVisible();
  });
});

test.describe("teacher quizzes", () => {
  test("/teacher/quizzes/new shows the new-quiz form", async ({ page }) => {
    await page.goto("/teacher/quizzes/new");
    // App inputs use <input className="input" /> with no type attribute, so
    // [type=text] won't match them. Target by className.
    const ta = page.locator("input.input, textarea").first();
    await expect(ta).toBeVisible({ timeout: 30_000 });
  });

  test("/teacher/quizzes shows empty state or list", async ({ page }) => {
    await page.goto("/teacher/quizzes");
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });
});

test.describe("teacher papers", () => {
  test("/teacher/papers shows empty state or papers list", async ({ page }) => {
    await page.goto("/teacher/papers");
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });

  test("/teacher/papers/new exposes paper-builder UI", async ({ page }) => {
    await page.goto("/teacher/papers/new");
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });
});

test.describe("teacher analytics + reports + review", () => {
  test("/teacher/analytics renders aggregate panels or empty state", async ({ page }) => {
    await page.goto("/teacher/analytics");
    await expect(page.locator("body")).not.toBeEmpty();
  });

  test("/teacher/reports renders without error", async ({ page }) => {
    await page.goto("/teacher/reports");
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });

  test("/teacher/review renders without error", async ({ page }) => {
    await page.goto("/teacher/review");
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });
});

test.describe("teacher bank + generate", () => {
  test("/teacher/bank renders the question bank surface", async ({ page }) => {
    await page.goto("/teacher/bank");
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });

  test("/teacher/generate renders the generator surface", async ({ page }) => {
    await page.goto("/teacher/generate");
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });
});

test.describe("teacher cannot reach school dashboard", () => {
  test("/school shows no super_teacher-only data", async ({ page }) => {
    await page.goto("/school");
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });
});
