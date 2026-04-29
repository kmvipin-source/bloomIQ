/**
 * Public pages + authentication flows.
 *
 * Covers landing, pricing, signup role-picker, login form validation, login
 * happy paths for every role, role-based home redirects, logout, and the
 * "logged-out user hits a protected page" redirect path.
 */

import { test, expect } from "@playwright/test";
import { loginAs, loginExpectError, logout } from "./helpers/auth";
import { FIXTURES, usernameToEmail } from "./helpers/fixtures";

test.describe("public pages render", () => {
  test("landing page shows hero + signup CTA", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/bloomiq/i);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: /create account/i }).first()).toBeVisible();
  });

  test("landing page links to /pricing", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /pricing/i }).first().click();
    await expect(page).toHaveURL(/\/pricing/);
  });

  test("landing page links to /login", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /sign in/i }).first().click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("pricing page renders without error", async ({ page }) => {
    const resp = await page.goto("/pricing");
    expect(resp?.ok()).toBeTruthy();
    await expect(page.locator("body")).not.toContainText(/this page could not be found/i);
  });

  test("signup page shows role picker initially", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByText(/teacher/i).first()).toBeVisible();
    await expect(page.getByText(/independent student/i).first()).toBeVisible();
    await expect(page.getByText(/admin head/i).first()).toBeVisible();
  });

  test("signup with ?role=teacher shows teacher form", async ({ page }) => {
    await page.goto("/signup?role=teacher");
    await expect(page.getByText(/creating account as/i)).toBeVisible();
    await expect(page.locator("text=/teacher/i").first()).toBeVisible();
  });

  test("signup with ?role=student shows student form", async ({ page }) => {
    await page.goto("/signup?role=student");
    await expect(page.getByText(/creating account as/i)).toBeVisible();
  });

  test("signup with ?role=super_teacher shows admin head form", async ({ page }) => {
    await page.goto("/signup?role=super_teacher");
    await expect(page.getByText(/creating account as/i)).toBeVisible();
  });
});

test.describe("login form validation", () => {
  test("login rejects wrong password", async ({ page }) => {
    await loginExpectError(page, FIXTURES.teacherA.email, "WrongPassword!");
  });

  test("login rejects unknown email", async ({ page }) => {
    await loginExpectError(page, "test_no_such_user@bloomiq-e2e.local", "anything");
  });

  test("login rejects unknown student username", async ({ page }) => {
    await loginExpectError(page, "test_no_such_student", "anything");
  });

  test("login form requires identifier", async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[type="password"]').first().fill("anything");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("login redirects per role", () => {
  test("teacher logs in and lands on /teacher", async ({ page }) => {
    await loginAs(page, "teacherA");
    await expect(page).toHaveURL(/\/teacher(?:$|\/|\?)/);
  });

  test("super_teacher logs in and lands on /school", async ({ page }) => {
    await loginAs(page, "superTeacherA");
    await expect(page).toHaveURL(/\/school(?:$|\/|\?)/);
  });

  test("school student logs in via username and lands on /student", async ({ page }) => {
    await loginAs(page, "studentA1");
    await expect(page).toHaveURL(/\/student(?:$|\/|\?)/);
  });

  test("independent student logs in via email and lands on /student", async ({ page }) => {
    await loginAs(page, "independentStudent");
    await expect(page).toHaveURL(/\/student(?:$|\/|\?)/);
  });
});

test.describe("logout + post-logout protection", () => {
  test("after logout, /teacher does not show teacher-only content", async ({ page }) => {
    await loginAs(page, "teacherA");
    await logout(page);
    await page.goto("/teacher");
    await expect(page.locator("body")).not.toContainText(FIXTURES.teacherA.fullName);
  });

  test("after logout, /student does not show student-only content", async ({ page }) => {
    await loginAs(page, "studentA1");
    await logout(page);
    await page.goto("/student");
    await expect(page.locator("body")).not.toContainText(FIXTURES.studentA1.fullName);
  });
});

test.describe("login form transforms username to synthetic email", () => {
  test("username-style identifier is accepted", async ({ page }) => {
    await loginAs(page, "studentA1");
    await expect(page).toHaveURL(/\/student/);
  });

  test("synthetic email derived from username matches expectation", async () => {
    expect(usernameToEmail(FIXTURES.studentA1.username)).toBe(
      "test_student_a1@bloomiq.invalid"
    );
  });
});
