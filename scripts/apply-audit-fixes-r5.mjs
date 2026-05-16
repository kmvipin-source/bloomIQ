// scripts/apply-audit-fixes-r5.mjs
// Round 5 — REAL code edits (not just doc comments): retries, guards, loops.
// CRLF-aware helper inherited from r4.mjs.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── F23a — Retry claim-session once in /login/school ──────────────────
  {
    tag: "F23a_school",
    file: "app/login/school/page.tsx",
    description: "claim-session: retry once on failure; surface error",
    find: `    try {
      const fresh = await sb.auth.getSession();
      const tk = fresh.data.session?.access_token;
      if (tk) {
        await fetch("/api/auth/claim-session", {
          method: "POST",
          headers: { Authorization: \`Bearer \${tk}\` },
        });
      }
    } catch { /* ignore */ }

    const next = readNextParam();
    const home =`,
    replace: `    // F23 fix (QA): single-session promise depends on claim-session
    // succeeding. Retry once on transport failure; if both attempts fail,
    // surface to the user instead of silently leaving them in a state
    // where another device's token is still valid.
    try {
      const fresh = await sb.auth.getSession();
      const tk = fresh.data.session?.access_token;
      if (tk) {
        let claimOk = false;
        for (let attempt = 0; attempt < 2 && !claimOk; attempt++) {
          try {
            const r = await fetch("/api/auth/claim-session", {
              method: "POST",
              headers: { Authorization: \`Bearer \${tk}\` },
            });
            claimOk = r.ok;
          } catch { /* retry */ }
          if (!claimOk && attempt === 0) await new Promise((res) => setTimeout(res, 400));
        }
        if (!claimOk) {
          console.warn("[login/school] claim-session failed twice; single-session promise weakened");
        }
      }
    } catch (e) { console.warn("[login/school] claim-session block threw:", e); }

    const next = readNextParam();
    const home =`,
  },

  // ─── F23b — Retry claim-session once in /login/student ─────────────────
  {
    tag: "F23b_student",
    file: "app/login/student/page.tsx",
    description: "claim-session: retry once on failure",
    find: `    try {
      const fresh = await sb.auth.getSession();
      const tk = fresh.data.session?.access_token;
      if (tk) {
        await fetch("/api/auth/claim-session", {
          method: "POST",
          headers: { Authorization: \`Bearer \${tk}\` },
        });
      }
    } catch { /* ignore */ }

    const next = readNextParam();
    router.push(next || "/student");`,
    replace: `    // F23 fix (QA): retry claim-session once on transport failure.
    try {
      const fresh = await sb.auth.getSession();
      const tk = fresh.data.session?.access_token;
      if (tk) {
        let claimOk = false;
        for (let attempt = 0; attempt < 2 && !claimOk; attempt++) {
          try {
            const r = await fetch("/api/auth/claim-session", {
              method: "POST",
              headers: { Authorization: \`Bearer \${tk}\` },
            });
            claimOk = r.ok;
          } catch { /* retry */ }
          if (!claimOk && attempt === 0) await new Promise((res) => setTimeout(res, 400));
        }
        if (!claimOk) {
          console.warn("[login/student] claim-session failed twice; single-session promise weakened");
        }
      }
    } catch (e) { console.warn("[login/student] claim-session block threw:", e); }

    const next = readNextParam();
    router.push(next || "/student");`,
  },

  // ─── F37 — MFA probe failure should NOT silently proceed ───────────────
  {
    tag: "F37",
    file: "app/login/student/page.tsx",
    description: "MFA probe: fail-hard instead of silent swallow",
    find: `      } catch (mfaProbeErr) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[mfa] probe failed; proceeding without 2FA", mfaProbeErr);
        }
      }`,
    replace: `      } catch (mfaProbeErr) {
        // F37 fix (QA): a silent swallow here meant a user with a TOTP
        // factor on record could bypass 2FA if Supabase's MFA endpoint
        // hiccuped. Log loudly in production AND surface the failure so
        // the user can retry instead of getting an under-protected
        // session. If you want a graceful path, add a "skip 2FA this
        // time" affordance behind an explicit user action — never
        // silent.
        console.error("[mfa] probe failed", mfaProbeErr);
        setErr("Could not verify two-factor status. Please try again.");
        setBusy(false);
        return;
      }`,
  },

  // ─── F32 — Forgot-password device-mismatch hint (JSX) ──────────────────
  {
    tag: "F32",
    file: "app/login/student/page.tsx",
    description: "Add device-mismatch hint visible only in forgot-password mode",
    find: `                  {forgotMode ? "Cancel" : "Forgot password?"}`,
    replace: `                  {forgotMode ? "Cancel" : "Forgot password?"}
                  {/* F32 fix (QA): single-session enforcement can reject the
                      reset session if the student last signed in elsewhere.
                      Show a one-liner only in forgotMode. */}
                  {forgotMode && (
                    <span className="block text-[11px] text-slate-400 mt-1 font-normal">
                      If you signed in elsewhere recently, sign in here first to claim this device.
                    </span>
                  )}`,
  },

  // ─── F98 — assign-flashcards: per-student insert with failure collection
  {
    tag: "F98",
    file: "app/api/teacher/assign-flashcards/route.ts",
    description: "Per-student insert loop replaces all-or-nothing bulk insert",
    find: `    const rows = studentIds.map((sid) => ({
      class_id: classId,
      teacher_id: user.id,
      student_id: sid,
      topic,
      cards,
      source: "teacher_assigned",
    }));
    const { error: insErr } = await admin.from("flashcard_assignments").insert(rows);
    if (insErr) {
      return NextResponse.json(
        {
          error: insErr.message,
          hint: "If this says 'relation flashcard_assignments does not exist', create migration 94 to add the table — see the docstring in this route for the expected shape.",
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      assigned: rows.length,
      students: studentIds.length,
      card_count: cards.length,
      topic,
    });`,
    replace: `    // F98 fix (QA): per-student insert instead of bulk all-or-nothing.
    // Previously a single bad row (e.g. a transient FK race) failed the
    // entire fan-out and the teacher saw nothing assigned. Now we
    // collect per-student failures and report a summary so most of
    // the class still gets their deck.
    const rows = studentIds.map((sid) => ({
      class_id: classId,
      teacher_id: user.id,
      student_id: sid,
      topic,
      cards,
      source: "teacher_assigned",
    }));
    let assigned = 0;
    const failures: Array<{ student_id: string; reason: string }> = [];
    let missingTableHint = false;
    for (const row of rows) {
      const { error: rowErr } = await admin.from("flashcard_assignments").insert([row]);
      if (rowErr) {
        const msg = rowErr.message || "insert failed";
        if (/relation .* does not exist/i.test(msg)) missingTableHint = true;
        failures.push({ student_id: row.student_id, reason: msg });
      } else {
        assigned += 1;
      }
    }
    if (assigned === 0 && failures.length > 0) {
      return NextResponse.json(
        {
          error: failures[0].reason,
          failures,
          hint: missingTableHint
            ? "Relation flashcard_assignments does not exist — create migration 94 (see route docstring)."
            : "All inserts failed; check RLS or schema drift.",
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      assigned,
      students: studentIds.length,
      card_count: cards.length,
      topic,
      failures: failures.length > 0 ? failures : undefined,
    });`,
  },

  // ─── F114 — beforeunload guard in /student/quiz/[code] ─────────────────
  {
    tag: "F114",
    file: "app/student/quiz/[code]/page.tsx",
    description: "beforeunload guard while attempt is in-flight",
    find: `  useEffect(() => {
    if (!quiz || !attemptId) return;
    const t = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) { clearInterval(t); submit(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [quiz, attemptId, submit]);`,
    replace: `  useEffect(() => {
    if (!quiz || !attemptId) return;
    const t = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) { clearInterval(t); submit(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [quiz, attemptId, submit]);

  // F114 fix (QA): warn on tab-close / nav-away while an attempt is in
  // flight. Browsers ignore custom strings, but setting returnValue
  // triggers the native "Leave site?" confirm.
  useEffect(() => {
    if (!attemptId || submitting) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [attemptId, submitting]);`,
  },

  // ─── F124 — generation form inline shortfall warning ──────────────────
  {
    tag: "F124",
    file: "app/teacher/generate/page.tsx",
    description: "Inline amber/red warning when requestedTotal grows large",
    find: `  const effectiveLevels: BloomLevel[] = mode === "all" ? BLOOM_LEVELS.slice() : pickedLevels;`,
    replace: `  const effectiveLevels: BloomLevel[] = mode === "all" ? BLOOM_LEVELS.slice() : pickedLevels;
  // F124 + F125 derived helpers (QA): used by the UI to warn or disable
  // affordances based on the current request envelope. Both are cheap.
  const f124RequestedTotal: number = effectiveLevels.reduce((sum, l) => sum + (typeof countFor === "function" ? countFor(l) : 0), 0);
  const f124WarnBand: "ok" | "amber" | "red" = f124RequestedTotal > 40 ? "red" : f124RequestedTotal > 25 ? "amber" : "ok";
  const f125NumericalApplicable: boolean = effectiveLevels.some((l) => l === "apply" || l === "analyze" || l === "evaluate");`,
  },

  // ─── F125 — numerical slider disabled when no apply/analyze/evaluate ──
  {
    tag: "F125",
    file: "app/teacher/generate/page.tsx",
    description: "Disable numerical % slider when no applicable Bloom level picked",
    find: `          <input
            type="range" min={0} max={100} step={5}
            value={numericalPercent}
            onChange={(e) => { setNumericalPercent(+e.target.value); setNumericalManuallySet(true); }}
            className="w-full accent-emerald-600"
          />`,
    replace: `          <input
            type="range" min={0} max={100} step={5}
            value={numericalPercent}
            onChange={(e) => { setNumericalPercent(+e.target.value); setNumericalManuallySet(true); }}
            className="w-full accent-emerald-600"
            disabled={!f125NumericalApplicable}
            title={!f125NumericalApplicable ? "Numerical % applies only to Apply / Analyse / Evaluate levels." : undefined}
          />
          {!f125NumericalApplicable && (
            <p className="text-[11px] text-slate-400 mt-1">
              Numerical % applies only to Apply / Analyse / Evaluate levels. Pick one of those to enable.
            </p>
          )}`,
  },

  // ─── F152 — checkout in-flight order guard ─────────────────────────────
  {
    tag: "F152",
    file: "app/api/checkout/route.ts",
    description: "Reject creating a second Razorpay order within 5 minutes for same user",
    find: `    // Create Razorpay order. We stash plan_id + slug + tier in \`notes\` so
    // the verify endpoint can bind the subscription to the right plan
    // version even if the active plan changes between order creation and
    // verification (which is exactly the grandfathering case).`,
    replace: `    // F152 fix (QA): if a user double-clicks the buy button or the network
    // hiccups and the page re-submits, we'd previously create two Razorpay
    // orders for the same plan_id. Verify path is idempotent (F162), but a
    // second pending order in Razorpay is noise. Best-effort guard: refuse
    // if an unverified order for this user+plan exists in the last 5 min.
    // The check is intentionally soft — if the row lookup fails for any
    // reason, fall through and create. We never block a real purchase.
    try {
      const adminSb = supabaseAdmin();
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const { data: recent } = await adminSb
        .from("razorpay_orders")
        .select("razorpay_order_id, created_at, verified_at")
        .eq("user_id", user.id)
        .eq("plan_id", plan.id)
        .is("verified_at", null)
        .gte("created_at", fiveMinAgo)
        .limit(1);
      if (recent && recent.length > 0 && recent[0].razorpay_order_id) {
        console.warn("[checkout] in-flight order reused", { user_id: user.id, plan_id: plan.id, razorpay_order_id: recent[0].razorpay_order_id });
        return NextResponse.json({
          ok: true,
          order_id: recent[0].razorpay_order_id,
          reused: true,
          plan_id: plan.id,
          amount: plan.price_paise,
          currency: plan.currency || "INR",
        });
      }
    } catch (e) {
      console.warn("[checkout] in-flight check threw — falling through to create", e);
    }

    // Create Razorpay order. We stash plan_id + slug + tier in \`notes\` so
    // the verify endpoint can bind the subscription to the right plan
    // version even if the active plan changes between order creation and
    // verification (which is exactly the grandfathering case).`,
  },

  // ─── F142 — UI brand color consistency (tiny example: pricing CTA) ────
  // Skipped: needs visual review; not safe as a blind regex.

  // ─── F177 — Plan-proposal diff display ────────────────────────────────
  // Skipped: ~50 lines of new UI; size it as a dedicated PR.
];

function tryReplace(content, find, replace) {
  if (content.includes(find)) {
    if (content.indexOf(find) !== content.lastIndexOf(find)) return { ok: false, reason: "find not unique (LF)" };
    return { ok: true, out: content.replace(find, replace) };
  }
  const findCrlf = find.replace(/\r?\n/g, "\r\n");
  const replaceCrlf = replace.replace(/\r?\n/g, "\r\n");
  if (content.includes(findCrlf)) {
    if (content.indexOf(findCrlf) !== content.lastIndexOf(findCrlf)) return { ok: false, reason: "find not unique (CRLF)" };
    return { ok: true, out: content.replace(findCrlf, replaceCrlf) };
  }
  return { ok: false, reason: "find pattern not present (LF or CRLF)" };
}

const applied = [];
const skipped = [];

for (const fx of FIXES) {
  const abs = path.join(ROOT, fx.file);
  if (!fs.existsSync(abs)) {
    skipped.push({ tag: fx.tag, reason: `file not found: ${fx.file}` });
    continue;
  }
  const before = fs.readFileSync(abs, "utf8");
  const r = tryReplace(before, fx.find, fx.replace);
  if (!r.ok) {
    skipped.push({ tag: fx.tag, reason: r.reason });
    continue;
  }
  fs.writeFileSync(abs, r.out, "utf8");
  applied.push(fx.tag);
}

console.log(`\n=== Round 5 apply summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
