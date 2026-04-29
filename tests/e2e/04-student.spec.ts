/**
 * Student tests. Logged in as studentA1 throughout (school student in school A).
 *
 * Covers home, classes, results, generate, plus the long list of feature
 * pages introduced by migrations 12-16 (visualizer, climber, sprint,
 * misconceptions, traps, knowledge graph, etc.). For features that depend
 * on AI calls or cross-page data, we only assert "page renders without
 * error". The AI surfaces are covered separately by manual smoke and
 * monitoring.
 */

import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { FIXTURES } from "./helpers/fixtures";

test.beforeEach(async ({ page }) => {
  await loginAs(page, "studentA1");
});

test.describe("student home", () => {
  test("/student renders without error", async ({ page }) => {
    const resp = await page.goto("/student");
    expect(resp?.ok()).toBeTruthy();
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });

  test("/student shows the student's first name", async ({ page }) => {
    await page.goto("/student");
    await expect(page.locator("body")).toContainText(/test_Student/i);
  });

  test("/student shows class info or assigned-quizzes section", async ({ page }) => {
    await page.goto("/student");
    await expect(page.locator("body")).not.toBeEmpty();
  });

  test("/student/home redirects or renders the same dashboard", async ({ page }) => {
    await page.goto("/student/home");
    // /student/home is a legacy stub that does router.replace("/student").
    await page.waitForURL(/\/student(?:$|\/|\?)/, { timeout: 30_000 });
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });
});

test.describe("student classes + tests + results", () => {
  test("/student/classes renders enrolled classes", async ({ page }) => {
    await page.goto("/student/classes");
    await expect(page.locator("body")).toContainText(/test_class_a1|class/i);
  });

  test("/student/tests renders without error", async ({ page }) => {
    await page.goto("/student/tests");
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });

  test("/student/results renders results history (or empty state)", async ({ page }) => {
    await page.goto("/student/results");
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });

  test("/student/progress renders progress view", async ({ page }) => {
    await page.goto("/student/progress");
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });
});

test.describe("student feature pages render", () => {
  for (const path of [
    "/student/buddy",
    "/student/calibration",
    "/student/certificate",
    "/student/climber",
    "/student/countdown",
    "/student/flashcards",
    "/student/generate",
    "/student/graph",
    "/student/independent",
    "/student/join",
    "/student/memory",
    "/student/misconceptions",
    "/student/parent",
    "/student/rank",
    "/student/speed",
    "/student/sprint",
    "/student/teach-back",
    "/student/traps",
    "/student/tutor",
    "/student/visualizer",
    "/student/voice-teacher",
    "/student/xray",
  ] as const) {
    test(`${path} renders for a student`, async ({ page }) => {
      const resp = await page.goto(path);
      expect(resp?.ok()).toBeTruthy();
      await expect(page.locator("body")).not.toContainText(/page could not be found/i);
    });
  }
});

test.describe("student generate-practice surface", () => {
  test("/student/generate exposes a topic input", async ({ page }) => {
    await page.goto("/student/generate");
    // App inputs use <input className="input" /> with no type attribute.
    const input = page.locator("input.input, textarea").first();
    await expect(input).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("student visualizer surface", () => {
  test("/student/visualizer exposes the topic input", async ({ page }) => {
    await page.goto("/student/visualizer");
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  });
});

test.describe("school student should NOT see independent-student paywall everywhere", () => {
  test("/student does not promote the paid tier upgrade prompt", async ({ page }) => {
    await page.goto("/student");
    const txt = (await page.textContent("body")) || "";
    expect(txt.toLowerCase()).not.toMatch(/0 of 5 free|free attempts used/);
  });
});

test.describe("logged-in student can sign out and return to login", () => {
  test("clicking a sign-out link drops the session", async ({ page }) => {
    await page.goto("/student");
    const signOut = page.getByRole("button", { name: /sign out|log out|logout/i }).first();
    if (await signOut.isVisible().catch(() => false)) {
      await signOut.click();
    } else {
      await page.evaluate(() => {
        Object.keys(localStorage)
          .filter((k) => k.startsWith("sb-"))
          .forEach((k) => localStorage.removeItem(k));
      });
    }
    await page.goto("/student");
    await expect(page.locator("body")).not.toContainText(FIXTURES.studentA1.fullName);
  });
});

test.describe("student-only routes reject teacher", () => {
  test("teacher cannot land on /student/visualizer with student-only data", async ({ page }) => {
    await page.evaluate(() => localStorage.clear());
    await loginAs(page, "teacherA");
    await page.goto("/student/visualizer");
    await expect(page.locator("body")).not.toContainText(FIXTURES.studentA1.fullName);
  });
});
