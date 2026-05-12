/**
 * lib/email.ts
 *
 * Shared transactional-email helper. Single entry point for every
 * server-side route that needs to send mail (co-teacher invites,
 * primary-teacher transfer invites, weekly digests, password-reset
 * fallback, etc.).
 *
 * Why a shared helper:
 *   - The codebase previously had email logic only inside
 *     `app/api/digest/route.ts`. New surfaces (e.g., the co-teacher
 *     invite path Vipin flagged on 2026-05-12) silently skipped email
 *     because there was no obvious place to call. One helper kills
 *     that drift.
 *   - Routes shouldn't care which transport we use. Today it's Gmail
 *     via nodemailer; tomorrow Resend / SES / Mailgun. Swap once here.
 *
 * Config (set in .env / .env.local):
 *   EMAIL          — Gmail address (the sending account)
 *   PASS           — Gmail app password (NOT the account password)
 *   DIGEST_FROM    — optional friendly From header, e.g. "BloomIQ <noreply@bloomiq.com>"
 *
 * When EMAIL or PASS is missing, sendEmail() returns
 * `{ ok: true, sent: false, reason: "not_configured" }` so calling routes
 * can degrade gracefully — they typically still succeed at the DB write,
 * the user just doesn't get an email until the env is wired.
 */

import nodemailer from "nodemailer";

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text fallback for clients that don't render HTML. */
  text?: string;
  /** Optional Reply-To header (e.g. set to the inviter so the recipient
   *  can reply directly). */
  replyTo?: string;
};

export type SendEmailResult =
  | { ok: true; sent: true }
  | { ok: true; sent: false; reason: "not_configured" }
  | { ok: false; sent: false; error: string };

/**
 * Best-effort transactional send. Never throws — callers can safely
 * fire-and-forget; the caller's flow continues regardless of email
 * status. Returns a structured result so routes that want to surface
 * "we couldn't email you" can do so.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const { EMAIL, PASS, DIGEST_FROM } = process.env;
  if (!EMAIL || !PASS) {
    return { ok: true, sent: false, reason: "not_configured" };
  }
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL, pass: PASS },
    });
    await transporter.sendMail({
      from: DIGEST_FROM || EMAIL,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      replyTo: input.replyTo,
    });
    return { ok: true, sent: true };
  } catch (e) {
    return { ok: false, sent: false, error: e instanceof Error ? e.message : "send_failed" };
  }
}

// ─── Pre-built templates ────────────────────────────────────────────────

/** Generic dark-grey container used by all transactional templates so
 *  every email lands with consistent typography. Keep it self-contained
 *  inline-styled HTML — most email clients strip <style> tags. */
function wrap(bodyHtml: string): string {
  return `
    <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a;">
      ${bodyHtml}
      <hr style="border:none; border-top: 1px solid #e2e8f0; margin: 24px 0;"/>
      <p style="color:#64748b; font-size:12px;">Sent by BloomIQ. If this wasn't you, you can safely ignore this email.</p>
    </div>`;
}

/**
 * Co-teacher invitation. Sent when a school admin / primary teacher
 * adds someone as a co-teacher on a class. The recipient may or may
 * not have an existing BloomIQ account.
 */
export function coTeacherInviteTemplate(opts: {
  inviterName: string | null;
  className: string;
  schoolName: string | null;
  acceptUrl: string;
}): { subject: string; html: string; text: string } {
  const who = opts.inviterName || "A BloomIQ admin";
  const school = opts.schoolName ? ` at ${opts.schoolName}` : "";
  const subject = `You've been invited to co-teach ${opts.className} on BloomIQ`;
  const html = wrap(`
    <h2 style="color:#0f172a; margin-top:0;">You're invited to co-teach</h2>
    <p>${escapeHtml(who)}${escapeHtml(school)} has added you as a co-teacher on the
       class <strong>${escapeHtml(opts.className)}</strong>.</p>
    <p>Co-teachers can see student progress, assign quizzes, and review reports
       for this class — but only the primary teacher can change class settings.</p>
    <p style="margin: 28px 0;">
      <a href="${opts.acceptUrl}"
         style="background:#10b981; color:white; padding:10px 18px; border-radius:8px;
                text-decoration:none; font-weight:600; display:inline-block;">
        Open BloomIQ
      </a>
    </p>
    <p style="color:#475569; font-size:13px;">
      If you don't have an account yet, you'll be prompted to sign up with this email
      address — your co-teacher access will appear automatically.
    </p>`);
  const text =
    `You're invited to co-teach ${opts.className} on BloomIQ.\n\n` +
    `${who}${school} has added you as a co-teacher.\n\n` +
    `Open BloomIQ: ${opts.acceptUrl}\n\n` +
    `If you don't have an account yet, sign up with this email address and the access ` +
    `will appear automatically.`;
  return { subject, html, text };
}

/**
 * Primary-teacher transfer invitation. Sent when an admin transfers
 * the primary-teacher role of a class to someone new.
 */
export function primaryTeacherInviteTemplate(opts: {
  inviterName: string | null;
  className: string;
  schoolName: string | null;
  acceptUrl: string;
}): { subject: string; html: string; text: string } {
  const who = opts.inviterName || "A BloomIQ admin";
  const school = opts.schoolName ? ` at ${opts.schoolName}` : "";
  const subject = `You're now the primary teacher for ${opts.className} on BloomIQ`;
  const html = wrap(`
    <h2 style="color:#0f172a; margin-top:0;">You're the primary teacher</h2>
    <p>${escapeHtml(who)}${escapeHtml(school)} has set you as the primary teacher
       on the class <strong>${escapeHtml(opts.className)}</strong>.</p>
    <p>As primary teacher you can manage students, assign quizzes, review reports,
       and add or remove co-teachers.</p>
    <p style="margin: 28px 0;">
      <a href="${opts.acceptUrl}"
         style="background:#10b981; color:white; padding:10px 18px; border-radius:8px;
                text-decoration:none; font-weight:600; display:inline-block;">
        Open BloomIQ
      </a>
    </p>
    <p style="color:#475569; font-size:13px;">
      If you don't have an account yet, sign up with this email address and the class
      will appear on your dashboard automatically.
    </p>`);
  const text =
    `You're now the primary teacher for ${opts.className} on BloomIQ.\n\n` +
    `${who}${school} has set you as the primary teacher.\n\n` +
    `Open BloomIQ: ${opts.acceptUrl}\n\n` +
    `If you don't have an account yet, sign up with this email address.`;
  return { subject, html, text };
}

// ─── Internal: minimal HTML-escape for user-supplied names ──────────────

function escapeHtml(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
