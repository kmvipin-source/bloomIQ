/**
 * loginAs(page, fixtureKey) — drives the public /login form so the resulting
 * session is real and persistent in localStorage. We use the form (not
 * direct token injection) because Supabase JS uses a versioned storage key
 * that can change between releases; the form path is robust to that.
 */

import { expect, type Page } from "@playwright/test";
import { FIXTURES, type FixtureKey, usernameToEmail } from "./fixtures";

/**
 * The login form (app/login/page.tsx) has <label> elements that are NOT
 * associated to their inputs via for/htmlFor. We therefore target inputs by
 * attribute. autoComplete="username" is on the identifier input;
 * type="password" is on the password input.
 */
function identifierInput(page: Page) {
  return page.locator('input[autocomplete="username"]').first();
}
function passwordInput(page: Page) {
  return page.locator('input[type="password"]').first();
}
function signInButton(page: Page) {
  return page.getByRole("button", { name: /sign in/i });
}
/**
 * The /login form gates Sign in on a "I agree to ToS + Privacy" click-wrap
 * checkbox. Tick it before clicking Sign in or the button stays disabled.
 */
async function acceptToS(page: Page) {
  const cb = page.getByRole("checkbox").first();
  if (await cb.count() > 0 && !(await cb.isChecked())) {
    await cb.check();
  }
}

export async function loginAs(page: Page, key: FixtureKey, opts: { expectRedirect?: boolean } = {}) {
  const f = FIXTURES[key];
  await page.goto("/login");

  // teacher / super_teacher / independent student → email
  // school student → username
  let identifier: string;
  if ("email" in f) {
    identifier = f.email;
  } else {
    identifier = f.username; // form converts to username@bloomiq.invalid
  }

  await identifierInput(page).fill(identifier);
  await passwordInput(page).fill(f.password);
  await acceptToS(page);
  await signInButton(page).click();

  if (opts.expectRedirect !== false) {
    // Wait for navigation away from /login to one of the role homes. Webpack
    // dev compiles each role home on first hit (slow), so we give it a
    // generous window.
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
  }
}

/**
 * Like loginAs but expects an error and does NOT navigate away.
 */
export async function loginExpectError(page: Page, identifier: string, password: string) {
  await page.goto("/login");
  await identifierInput(page).fill(identifier);
  await passwordInput(page).fill(password);
  await acceptToS(page);
  await signInButton(page).click();
  await expect(page.getByText(/incorrect|failed|please try again/i)).toBeVisible({ timeout: 10_000 });
}

/**
 * Sign out via the Supabase client. Faster than clicking a UI button when
 * we just want to test redirects.
 */
export async function logout(page: Page) {
  await page.evaluate(async () => {
    const keys = Object.keys(window.localStorage);
    for (const k of keys) {
      if (k.startsWith("sb-")) window.localStorage.removeItem(k);
    }
  });
}

export function emailFor(key: FixtureKey): string {
  const f = FIXTURES[key];
  if ("email" in f) return f.email;
  return usernameToEmail(f.username);
}
