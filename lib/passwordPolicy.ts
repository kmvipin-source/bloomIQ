// lib/passwordPolicy.ts
// =============================================================================
// F26 fix (QA): the password strength rule used to be duplicated in three
// places — app/signup/page.tsx, app/auth/set-password/page.tsx, and
// app/api/auth/set-password/route.ts. Hardening the rule meant remembering
// to update all three, and forgetting any one let the weaker password
// through that surface. This module is the single source of truth.
//
// Current policy: ≥8 chars, at least one lowercase, one uppercase, one digit.
// Bumping the policy: edit `validatePassword` here, every surface picks it up.
// =============================================================================

export const MIN_LENGTH = 8;

export type PasswordValidation =
  | { ok: true }
  | { ok: false; reason: string };

export function validatePassword(password: string): PasswordValidation {
  if (typeof password !== "string") {
    return { ok: false, reason: "Password is required." };
  }
  if (password.length < MIN_LENGTH) {
    return { ok: false, reason: `Use a password with at least ${MIN_LENGTH} characters.` };
  }
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  if (!hasLower || !hasUpper || !hasDigit) {
    return {
      ok: false,
      reason:
        "Password needs at least one lowercase letter, one uppercase letter, and one number.",
    };
  }
  return { ok: true };
}

/** Lightweight strength score 0-3 for UI strength meters. */
export function scorePassword(p: string): number {
  if (p.length < MIN_LENGTH) return 0;
  let s = 1;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p) || /[^A-Za-z0-9]/.test(p)) s++;
  if (p.length >= 12) s++;
  return Math.min(s, 3);
}
