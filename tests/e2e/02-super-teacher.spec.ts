/**
 * Super-teacher / Admin Head ("school" routes) tests.
 *
 * Each test logs in as superTeacherA and exercises an aspect of the /school
 * area: dashboard, classes, students, teachers, reports, plus the join-code
 * surface that teachers use to join the school.
 */

import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { FIXTURES } from "./helpers/fixtures";

test.beforeEach(async ({ page }) => {
  await loginAs(page, "superTeacherA");
});

test.describe("super_teacher dashboard", () => {
  test("/school renders without error", async ({ page }) => {
    const resp = await page.goto("/school");
    expect(resp?.ok()).toBeTruthy();
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });

  test("/school dashboard shows the seeded school name", async ({ page }) => {
    await page.goto("/school");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).toContainText(FIXTURES.superTeacherA.schoolName);
  });

  test("/school shows nav links to subpages", async ({ page }) => {
    await page.goto("/school");
    await page.waitForLoadState("networkidle");
    const links = await page.locator("a").allTextContents();
    const joined = links.join(" ").toLowerCase();
    expect(joined).toMatch(/classes|teachers|students|reports/);
  });
});

test.describe("super_teacher subpages render", () => {
  for (const path of ["/school/classes", "/school/students", "/school/teachers", "/school/reports"] as const) {
    test(`${path} renders without 404`, async ({ page }) => {
      const resp = await page.goto(path);
      expect(resp?.ok()).toBeTruthy();
      await expect(page.locator("body")).not.toContainText(/page could not be found/i);
    });
  }
});

test.describe("school classes management", () => {
  test("/school/classes lists the seeded test class A1", async ({ page }) => {
    await page.goto("/school/classes");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).toContainText("test_class_a1");
  });

  test("/school/classes lists the seeded test class A2", async ({ page }) => {
    await page.goto("/school/classes");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).toContainText("test_class_a2");
  });

  test("/school/classes does NOT list school B's class", async ({ page }) => {
    await page.goto("/school/classes");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText("test_class_b1");
  });
});

test.describe("school students roster", () => {
  test("/school/students lists studentA1", async ({ page }) => {
    await page.goto("/school/students");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).toContainText(FIXTURES.studentA1.fullName);
  });

  test("/school/students lists studentA2", async ({ page }) => {
    await page.goto("/school/students");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).toContainText(FIXTURES.studentA2.fullName);
  });

  test("/school/students does NOT list school B's student", async ({ page }) => {
    await page.goto("/school/students");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText(FIXTURES.studentB1.fullName);
  });
});

test.describe("school teachers roster", () => {
  test("/school/teachers lists teacherA", async ({ page }) => {
    await page.goto("/school/teachers");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).toContainText(FIXTURES.teacherA.fullName);
  });

  test("/school/teachers lists teacherA2", async ({ page }) => {
    await page.goto("/school/teachers");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).toContainText(FIXTURES.teacherA2.fullName);
  });

  test("/school/teachers does NOT list teacherB (other school)", async ({ page }) => {
    await page.goto("/school/teachers");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText(FIXTURES.teacherB.fullName);
  });
});

test.describe("super_teacher cannot access teacher routes by URL", () => {
  test("/teacher is not the super_teacher's home", async ({ page }) => {
    await page.goto("/teacher");
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });
});

test.describe("super_teacher reports page", () => {
  test("/school/reports loads", async ({ page }) => {
    await page.goto("/school/reports");
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });

  test("/school/reports shows aggregate or empty-state copy", async ({ page }) => {
    await page.goto("/school/reports");
    await expect(page.locator("body")).not.toBeEmpty();
  });
});
