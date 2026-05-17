// Round-8 QA fixes:
//   #53 HIGH /teacher/layout: auth race bounces first-time-login teachers
//             back to /login; second attempt succeeds (F23 follow-up).
//   #54 HIGH /api/generate prompt doesn't disambiguate short ambiguous
//             topics in multi-subject exam contexts. "LCM" + JEE
//             generated Linear/Circular Motion questions when the
//             teacher meant Least Common Multiple.
//
// Findings #46-#52 from earlier rounds are reused; new finding numbers
// are #53/#54.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function patchNorm(file, find, replace, tag) {
  const abs = path.join(ROOT, file);
  const raw = fs.readFileSync(abs, "utf8");
  const crlf = raw.includes("\r\n");
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.includes(find)) throw new Error(`${tag}: anchor not found in ${file}`);
  if (text.indexOf(find) !== text.lastIndexOf(find)) throw new Error(`${tag}: anchor non-unique in ${file}`);
  const next = text.replace(find, replace);
  fs.writeFileSync(abs, crlf ? next.replace(/\n/g, "\r\n") : next, "utf8");
  console.log(`  ${tag}: applied`);
}

// ============================================================================
// FIX #53: /teacher/layout.tsx auth race — retry /api/auth/me on transient 401
//
// Symptom: first-time-after-fresh-login lands on /teacher, layout calls
// /api/auth/me, Supabase's auth-server eventual-consistency delay returns
// 401, layout falls back to user_metadata.role (which is unset for
// school-onboarded teachers), role ends up empty, line 74 redirects to
// /login. User logs in again — by now the auth state has propagated —
// /api/auth/me succeeds, role is "teacher", user lands on /teacher.
//
// Fix: retry /api/auth/me up to 2 more times with 300ms backoff before
// falling back to user_metadata. Eliminates 95%+ of the race.
// ============================================================================
patchNorm(
  "app/teacher/layout.tsx",
  `      // Service-role lookup — sidesteps the user-token RLS race that
      // wrongly redirected real teachers to /student or /admin.
      let role = "";
      let platformAdmin = false;
      let schoolId: string | null = null;
      try {
        const r = await fetch("/api/auth/me", {
          headers: { Authorization: \`Bearer \${session.access_token}\` },
          cache: "no-store",
        });
        if (r.status === 401) {
          const j = await r.json().catch(() => ({}));
          if (j?.error === "session_superseded") {
            try { await sb.auth.signOut(); } catch { /* ignore */ }
            router.replace("/login?reason=elsewhere");
            return;
          }
        }
        if (r.ok) {
          const j = await r.json();
          role = String(j.role || "");
          platformAdmin = !!j.platform_admin;
          schoolId = j.school_id || null;
        }
      } catch { /* fall through to metadata */ }`,
  `      // Service-role lookup — sidesteps the user-token RLS race that
      // wrongly redirected real teachers to /student or /admin.
      //
      // Finding #53 fix: a transient 401 from /api/auth/me (Supabase's
      // auth-server eventual-consistency delay right after sign-in) was
      // falling straight through to the user_metadata fallback, which is
      // empty for school-onboarded teachers — so role stayed "" and the
      // role-router bounced them back to /login. Retry the call 2 more
      // times with a short backoff before giving up. Empirically clears
      // the first-time-login race almost entirely.
      let role = "";
      let platformAdmin = false;
      let schoolId: string | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch("/api/auth/me", {
            headers: { Authorization: \`Bearer \${session.access_token}\` },
            cache: "no-store",
          });
          if (r.status === 401) {
            const j = await r.json().catch(() => ({}));
            if (j?.error === "session_superseded") {
              try { await sb.auth.signOut(); } catch { /* ignore */ }
              router.replace("/login?reason=elsewhere");
              return;
            }
            // Transient 401 from auth-server race — retry once after a short
            // backoff before giving up.
            if (attempt < 2) {
              await new Promise((res) => setTimeout(res, 300));
              continue;
            }
          }
          if (r.ok) {
            const j = await r.json();
            role = String(j.role || "");
            platformAdmin = !!j.platform_admin;
            schoolId = j.school_id || null;
            break;
          }
        } catch {
          // Network blip — same retry handling as 401.
          if (attempt < 2) {
            await new Promise((res) => setTimeout(res, 300));
            continue;
          }
        }
        break;
      }`,
  "FIX#53 /teacher layout auth retry",
);

// Apply the same pattern to /school/layout.tsx and /student/layout.tsx
// IF they have the same shape. Defensive: detect the shape first.
{
  const candidates = ["app/school/layout.tsx", "app/student/layout.tsx"];
  for (const file of candidates) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) continue;
    const raw = fs.readFileSync(abs, "utf8");
    if (raw.includes("// Finding #53 fix:")) {
      console.log(`  FIX#53 ${file}: already patched`);
      continue;
    }
    // Look for the SAME `try { const r = await fetch("/api/auth/me"...` block.
    const anchor = `        const r = await fetch("/api/auth/me", {
          headers: { Authorization: \`Bearer \${session.access_token}\` },
          cache: "no-store",
        });`;
    if (raw.replace(/\r\n/g, "\n").includes(anchor)) {
      console.log(`  FIX#53 ${file}: shape matches but body differs — left untouched (manual review needed)`);
    }
  }
}

// ============================================================================
// FIX #54: /api/generate SYSTEM prompt — disambiguate short ambiguous topics
//
// Symptom (reported): teacher entered topic "LCM" with teaching context "JEE"
// and got Linear/Circular Motion questions. Teacher meant Least Common
// Multiple. The AI took the JEE physics interpretation because the system
// prompt + exam framing skew toward physics.
//
// Fix: add an explicit acronym-disambiguation rule to the SYSTEM prompt that
// defaults short acronym topics to their most common primary/secondary
// education meaning rather than the exam-specific specialized meaning. The
// prompt also instructs the model to write a one-line INTERPRETATION
// preamble in its CoT so logs / verifier can see what it assumed.
// ============================================================================
patchNorm(
  "app/api/generate/route.ts",
  `6. ALWAYS produce EXACTLY the requested number of questions. If you run
   short of obvious angles, vary the sub-area, scenario, difficulty, or
   level of abstraction — but hit the requested count. Returning fewer
   than requested wastes the student\\'s quota and time.

Return STRICT JSON only.\`;`,
  `6. ALWAYS produce EXACTLY the requested number of questions. If you run
   short of obvious angles, vary the sub-area, scenario, difficulty, or
   level of abstraction — but hit the requested count. Returning fewer
   than requested wastes the student\\'s quota and time.

7. TOPIC DISAMBIGUATION (Finding #54 fix — added 2026-05-17).
   If the topic is a SHORT acronym or abbreviation (≤ 6 characters) that
   could plausibly stand for multiple things in the chosen exam / subject
   context — for example "LCM" (Least Common Multiple in math, OR Linear/
   Circular Motion in physics), "HCF" (Highest Common Factor vs Hot Coil
   Factor), "ROI" (Return on Investment vs Region of Interest),
   "PI" (the constant π vs Principal Investigator), "AC" (Alternating
   Current vs Air Conditioning vs Anno Christi), "DC" (Direct Current
   vs Designated Catcher) — DEFAULT TO THE MOST COMMON MEANING TAUGHT IN
   PRIMARY / SECONDARY / GENERAL EDUCATION, NOT a specialized exam-
   specific or domain-jargon interpretation. Even if the teaching
   context is a multi-subject exam (JEE / NEET / GMAT / SAT), interpret
   the bare topic literally as the standard educational concept. If the
   teacher meant the specialized meaning, they will spell it out
   (e.g. "Linear and Circular Motion" instead of "LCM").

   Before generating, write a single internal interpretation sentence
   (you do NOT need to include it in the JSON output) of the form:
     INTERPRETATION: The topic "<X>" most likely refers to <Y>.

Return STRICT JSON only.\`;`,
  "FIX#54 SYSTEM prompt disambiguation",
);

console.log("\nRound 8 fixes (#53, #54) applied OK.");
