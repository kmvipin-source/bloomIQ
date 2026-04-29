/**
 * Cross-role authorisation tests. These are the most important checks
 * before deployment because they catch the leaks that RLS or app-layer
 * filters are supposed to prevent.
 *
 * Strategy: log in as one role, navigate to a route owned by another role,
 * assert that NO cross-tenant data appears in the rendered HTML. We do not
 * assert the exact response status because the app uses client-side
 * filtering — a 200 with an empty list is correct behaviour.
 */

import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { FIXTURES, TEST_CLASS_A1, TEST_CLASS_B1 } from "./helpers/fixtures";

test.describe("logged-out access", () => {
  test("/teacher renders without leaking any teacher's name when logged out", async ({ page }) => {
    await page.goto("/teacher");
    await expect(page.locator("body")).not.toContainText(FIXTURES.teacherA.fullName);
    await expect(page.locator("body")).not.toContainText(FIXTURES.teacherB.fullName);
  });

  test("/student renders without leaking any student's name when logged out", async ({ page }) => {
    await page.goto("/student");
    await expect(page.locator("body")).not.toContainText(FIXTURES.studentA1.fullName);
    await expect(page.locator("body")).not.toContainText(FIXTURES.studentB1.fullName);
  });

  test("/school renders without leaking school data when logged out", async ({ page }) => {
    await page.goto("/school");
    await expect(page.locator("body")).not.toContainText(TEST_CLASS_A1);
    await expect(page.locator("body")).not.toContainText(TEST_CLASS_B1);
  });

  test("/teacher/classes renders no classes when logged out", async ({ page }) => {
    await page.goto("/teacher/classes");
    await expect(page.locator("body")).not.toContainText(TEST_CLASS_A1);
  });

  test("/school/students renders no roster when logged out", async ({ page }) => {
    await page.goto("/school/students");
    await expect(page.locator("body")).not.toContainText(FIXTURES.studentA1.fullName);
  });
});

test.describe("teacherA cannot see teacherB's data", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "teacherA");
  });

  test("/teacher/classes hides teacherB's class", async ({ page }) => {
    await page.goto("/teacher/classes");
    await expect(page.locator("body")).not.toContainText(TEST_CLASS_B1);
  });

  test("/teacher hides teacherB's name in any 'colleagues' surface", async ({ page }) => {
    await page.goto("/teacher");
    await expect(page.locator("body")).not.toContainText(FIXTURES.teacherB.fullName);
  });

  test("/teacher/quizzes does not list any quiz from school B", async ({ page }) => {
    await page.goto("/teacher/quizzes");
    await expect(page.locator("body")).not.toContainText("test_quiz_b");
  });
});

test.describe("studentA1 cannot see studentB1's data", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "studentA1");
  });

  test("/student/classes hides school B's class", async ({ page }) => {
    await page.goto("/student/classes");
    await expect(page.locator("body")).not.toContainText(TEST_CLASS_B1);
  });

  test("/student/results does not show studentB1's name", async ({ page }) => {
    await page.goto("/student/results");
    await expect(page.locator("body")).not.toContainText(FIXTURES.studentB1.fullName);
  });

  test("/student/graph does not leak teacherB or other-school data", async ({ page }) => {
    await page.goto("/student/graph");
    await expect(page.locator("body")).not.toContainText(FIXTURES.teacherB.fullName);
  });
});

test.describe("student cannot reach teacher routes meaningfully", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "studentA1");
  });

  test("/teacher does not render teacher dashboard data", async ({ page }) => {
    await page.goto("/teacher");
    // No teacher-only stats panel for a student.
    await expect(page.locator("body")).not.toContainText(FIXTURES.teacherA.fullName);
  });

  test("/teacher/classes does not list classes for the student", async ({ page }) => {
    await page.goto("/teacher/classes");
    await expect(page.locator("body")).not.toContainText(TEST_CLASS_A1);
  });

  test("/teacher/quizzes/new does not let a student create a quiz", async ({ page }) => {
    // Even if the form renders, submission should fail. We just navigate
    // and assert no obvious "Quiz created" success state.
    await page.goto("/teacher/quizzes/new");
    await expect(page.locator("body")).not.toContainText(/quiz created|saved successfully/i);
  });
});

test.describe("teacher cannot reach school admin routes", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "teacherA");
  });

  test("/school/teachers does not show the full school teacher roster", async ({ page }) => {
    await page.goto("/school/teachers");
    // teacherA is not the super_teacher, so this page should not list every
    // teacher. We assert that in particular it does NOT list teacherB.
    await expect(page.locator("body")).not.toContainText(FIXTURES.teacherB.fullName);
  });

  test("/school/students does not list students teacherA does not own", async ({ page }) => {
    await page.goto("/school/students");
    await expect(page.locator("body")).not.toContainText(FIXTURES.studentB1.fullName);
  });
});

test.describe("super_teacher cannot reach teacher-specific routes meaningfully", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "superTeacherA");
  });

  test("/teacher/quizzes does not show another teacher's quizzes", async ({ page }) => {
    await page.goto("/teacher/quizzes");
    // No leakage of test_quiz_b specifically.
    await expect(page.locator("body")).not.toContainText("test_quiz_b");
  });
});
