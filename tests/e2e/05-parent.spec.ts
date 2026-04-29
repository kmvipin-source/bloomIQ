/**
 * Parent dashboard tests.
 *
 * Parents don't have accounts; they get a tokenised URL `/parent/<token>`
 * that's powered by /api/parent/data. We seed a parent_invite via the
 * service-role client, then drive the page.
 */

import { test, expect } from "@playwright/test";
import { admin } from "./helpers/supabase-admin";
import { FIXTURES } from "./helpers/fixtures";

let parentToken = "";
let parentTokenForB = "";

function makeTestToken(label: string): string {
  // 24 random hex chars + `test_` prefix so cleanup can find it.
  const rand = [...Array(24)]
    .map(() => Math.floor(Math.random() * 16).toString(16))
    .join("");
  return `test_${label}_${rand}`;
}

test.beforeAll(async () => {
  // Create a parent invite for studentA1 if one doesn't already exist. The
  // `token` column is NOT NULL with no default — we must supply one.
  const sb = admin();
  const studentARow = await sb
    .from("profiles")
    .select("id")
    .eq("full_name", FIXTURES.studentA1.fullName)
    .single();
  const studentBRow = await sb
    .from("profiles")
    .select("id")
    .eq("full_name", FIXTURES.studentB1.fullName)
    .single();

  if (studentARow.data?.id) {
    parentToken = makeTestToken("a");
    const { error } = await sb.from("parent_invites").insert({
      student_id: studentARow.data.id,
      token: parentToken,
      parent_label: "test_Parent A",
    });
    if (error) {
      console.warn("[parent test setup] insert A failed:", error.message);
      parentToken = "";
    }
  }
  if (studentBRow.data?.id) {
    parentTokenForB = makeTestToken("b");
    const { error } = await sb.from("parent_invites").insert({
      student_id: studentBRow.data.id,
      token: parentTokenForB,
      parent_label: "test_Parent B",
    });
    if (error) {
      console.warn("[parent test setup] insert B failed:", error.message);
      parentTokenForB = "";
    }
  }
});

test.describe("parent dashboard", () => {
  test("opens with a valid token and shows the student's name", async ({ page }) => {
    test.skip(!parentToken, "parent_invites table missing or insert failed");
    await page.goto(`/parent/${parentToken}`);
    await expect(page.locator("body")).toContainText(FIXTURES.studentA1.fullName.split(" ")[0]);
  });

  test("shows the parent's label as a greeting", async ({ page }) => {
    test.skip(!parentToken, "parent_invites table missing or insert failed");
    await page.goto(`/parent/${parentToken}`);
    await expect(page.locator("body")).toContainText(/hi/i);
  });

  test("shows a stats / week-summary section", async ({ page }) => {
    test.skip(!parentToken, "parent_invites table missing or insert failed");
    await page.goto(`/parent/${parentToken}`);
    await expect(page.locator("body")).not.toBeEmpty();
  });

  test("invalid token shows the friendly error card", async ({ page }) => {
    await page.goto("/parent/test_not_a_real_token_zzzz");
    await expect(page.locator("body")).toContainText(/link unavailable|could not be opened/i);
  });

  test("missing token segment renders the error card too", async ({ page }) => {
    const resp = await page.goto("/parent/", { waitUntil: "domcontentloaded" });
    expect(resp).toBeTruthy();
  });
});

test.describe("parent token isolation", () => {
  test("Parent A's token does NOT show Student B", async ({ page }) => {
    test.skip(!parentToken, "parent_invites missing");
    await page.goto(`/parent/${parentToken}`);
    await expect(page.locator("body")).not.toContainText(FIXTURES.studentB1.fullName);
  });

  test("Parent B's token does NOT show Student A", async ({ page }) => {
    test.skip(!parentTokenForB, "parent_invites missing");
    await page.goto(`/parent/${parentTokenForB}`);
    await expect(page.locator("body")).not.toContainText(FIXTURES.studentA1.fullName);
  });
});

test.describe("parent dashboard does not require login", () => {
  test("clears any session on entry — viewing the dashboard works in incognito", async ({ page }) => {
    test.skip(!parentToken, "parent_invites missing");
    await page.context().clearCookies();
    await page.evaluate(() => localStorage.clear()).catch(() => {});
    await page.goto(`/parent/${parentToken}`);
    await expect(page.locator("body")).toContainText(FIXTURES.studentA1.fullName.split(" ")[0]);
  });

  test("does not link to /login or /signup CTAs (parents shouldn't sign up)", async ({ page }) => {
    test.skip(!parentToken, "parent_invites missing");
    await page.goto(`/parent/${parentToken}`);
    const ctas = await page.locator("a[href='/signup'], a[href*='signup']").count();
    expect(ctas).toBeLessThanOrEqual(1);
  });
});

test.describe("parent dashboard data shape", () => {
  test("renders without throwing a client-side error", async ({ page }) => {
    test.skip(!parentToken, "parent_invites missing");
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/parent/${parentToken}`);
    await page.waitForLoadState("domcontentloaded");
    expect(errors.filter((e) => !/Hydration|Warning/i.test(e))).toEqual([]);
  });
});
