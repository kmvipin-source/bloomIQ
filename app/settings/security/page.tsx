"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ShieldCheck, KeyRound, ArrowLeft, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";

/**
 * /settings/security
 *
 * Self-service 2FA enrollment for every role except school students.
 * School students log in with username + the password their teacher set;
 * we don't expect them to manage their own authenticator app.
 *
 * Flow:
 *   1. listFactors() — show enrolled or "no 2FA yet" state.
 *   2. Click "Enable 2FA" → mfa.enroll({ factorType: "totp" }) → render
 *      otpauth URI as text (and ideally a QR; we render the URI so the
 *      user can paste into their app or scan).
 *   3. User enters first 6-digit code → mfa.challenge → mfa.verify.
 *   4. On success the factor moves from 'unverified' to 'verified' and
 *      future sign-ins challenge it.
 *
 * Disable: mfa.unenroll({ factorId }).
 */

type FactorRow = {
  id: string;
  factor_type: string;
  status: "verified" | "unverified";
  friendly_name?: string;
};

export default function SecuritySettingsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [factors, setFactors] = useState<FactorRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Enrollment workflow state
  const [enrolling, setEnrolling] = useState(false);
  const [pendingFactor, setPendingFactor] = useState<{
    factorId: string;
    uri: string;
    secret: string;
    qrDataUrl: string;
  } | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [verifyBusy, setVerifyBusy] = useState(false);

  async function reload() {
    setError(null);
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { router.replace("/login?next=/settings/security"); return; }

    const { data: prof } = await sb
      .from("profiles")
      .select("is_school_student")
      .eq("id", user.id)
      .single();
    if (prof?.is_school_student) {
      setAllowed(false);
      setLoading(false);
      return;
    }
    setAllowed(true);

    try {
      const { data, error: lfErr } = await sb.auth.mfa.listFactors();
      if (lfErr) throw lfErr;
      const all: FactorRow[] = [
        ...((data?.totp || []) as FactorRow[]),
      ];
      setFactors(all);
    } catch (e) {
      setError(
        e instanceof Error
          ? `Couldn't load 2FA factors: ${e.message}. (If your Supabase project doesn't have MFA enabled, ask the platform admin to turn it on under Authentication → MFA.)`
          : "Couldn't load 2FA factors."
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  async function startEnroll() {
    setError(null); setInfo(null);
    setEnrolling(true);
    try {
      const sb = supabaseBrowser();

      // Cleanup pass: drop every UNVERIFIED TOTP factor. They linger when a
      // previous enrollment was abandoned without confirming.
      async function dropUnverified(): Promise<void> {
        try {
          const { data: existing } = await sb.auth.mfa.listFactors();
          for (const f of (existing?.totp || [])) {
            if (f.status !== "verified") {
              await sb.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
            }
          }
        } catch { /* best-effort */ }
      }

      function uniqName(): string {
        const t = Date.now().toString(36);
        const r = Math.random().toString(36).slice(2, 8);
        return `BloomIQ ${t}-${r}`;
      }

      await dropUnverified();

      let { data, error: enrErr } = await sb.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: uniqName(),
      });

      // If we still hit a duplicate-name error, the unverified factor is
      // probably hidden from listFactors. Drop ALL TOTP factors (yes,
      // including verified — but we're enrolling a fresh one anyway, so
      // there should be no verified factor at this point) and retry once.
      if (enrErr && /already exists/i.test(enrErr.message)) {
        try {
          const { data: all } = await sb.auth.mfa.listFactors();
          for (const f of (all?.totp || [])) {
            await sb.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
          }
        } catch { /* ignore */ }
        const retry = await sb.auth.mfa.enroll({
          factorType: "totp",
          friendlyName: uniqName(),
        });
        data = retry.data;
        enrErr = retry.error;
      }

      if (enrErr || !data) throw new Error(enrErr?.message || "Enrollment failed.");
      // Render QR locally — never send the TOTP secret to a third-party
      // image API. qrcode lib produces a data URL we can drop into <img>.
      const qrDataUrl = await QRCode.toDataURL(data.totp.uri, {
        margin: 1,
        width: 240,
        errorCorrectionLevel: "M",
      });
      setPendingFactor({
        factorId: data.id,
        uri: data.totp.uri,
        secret: data.totp.secret,
        qrDataUrl,
      });
      setVerifyCode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enrollment failed.");
    } finally {
      setEnrolling(false);
    }
  }

  async function confirmEnroll() {
    if (!pendingFactor) return;
    if (!/^\d{6}$/.test(verifyCode.trim())) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setVerifyBusy(true); setError(null);
    try {
      const sb = supabaseBrowser();
      const { data: ch, error: chErr } = await sb.auth.mfa.challenge({ factorId: pendingFactor.factorId });
      if (chErr || !ch) throw new Error(chErr?.message || "Couldn't start verification.");
      const { error: vErr } = await sb.auth.mfa.verify({
        factorId: pendingFactor.factorId,
        challengeId: ch.id,
        code: verifyCode.trim(),
      });
      if (vErr) throw new Error(vErr.message || "Code not accepted.");
      setInfo("2FA enabled. From now on you'll be asked for the 6-digit code on every sign-in.");
      setPendingFactor(null);
      setVerifyCode("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed.");
    } finally {
      setVerifyBusy(false);
    }
  }

  async function cancelPending() {
    if (!pendingFactor) return;
    try {
      const sb = supabaseBrowser();
      await sb.auth.mfa.unenroll({ factorId: pendingFactor.factorId });
    } catch { /* ignore — best-effort cleanup */ }
    setPendingFactor(null);
    setVerifyCode("");
  }

  async function unenroll(factorId: string) {
    if (!confirm("Disable 2FA on this device? You'll only need your password to sign in after this.")) return;
    setError(null); setInfo(null);
    try {
      const sb = supabaseBrowser();
      const { error: unErr } = await sb.auth.mfa.unenroll({ factorId });
      if (unErr) throw new Error(unErr.message);
      setInfo("2FA disabled.");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't disable 2FA.");
    }
  }

  if (loading) {
    return <div className="min-h-screen grid place-items-center"><Loader2 className="animate-spin" /></div>;
  }
  if (allowed === false) {
    return (
      <div className="min-h-screen grid place-items-center px-6">
        <div className="card max-w-md text-center">
          <ShieldCheck className="mx-auto mb-3" />
          <h1 className="text-lg font-bold mb-2">2FA isn't available for school students</h1>
          <p className="text-sm muted mb-4">
            Your teacher manages your sign-in. If you forget your password, ask them to reset it from their class roster page.
          </p>
          <Link href="/student" className="btn btn-primary">Back to dashboard</Link>
        </div>
      </div>
    );
  }

  const verified = factors.filter((f) => f.status === "verified");

  return (
    <main className="min-h-screen px-6 py-10 max-w-2xl mx-auto">
      <button
        type="button"
        onClick={() => router.back()}
        className="text-sm text-slate-600 hover:text-emerald-700 inline-flex items-center gap-1 mb-4"
      >
        <ArrowLeft size={14} /> Back
      </button>
      <h1 className="text-2xl font-bold flex items-center gap-2 mb-1">
        <ShieldCheck size={22} /> Account security
      </h1>
      <p className="text-sm muted mb-6">
        Add a second factor (authenticator app) so a stolen password alone can't get into your account.
      </p>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
      {info && (
        <div className="mb-4 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg flex gap-2">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> {info}
        </div>
      )}

      <div className="card">
        <h2 className="font-semibold flex items-center gap-2 mb-3">
          <KeyRound size={16} /> Authenticator app (TOTP)
        </h2>

        {pendingFactor ? (
          <>
            <p className="text-sm muted mb-3">
              Open your authenticator app (Google Authenticator, 1Password, Authy, Microsoft Authenticator, etc.) and add a new account by scanning this QR code. Then enter the 6-digit code shown by the app to confirm.
            </p>
            <div className="grid sm:grid-cols-[auto_1fr] gap-4 items-start mb-4">
              <div className="rounded-lg border border-slate-200 bg-white p-2 inline-block">
                {/* QR rendered locally via qrcode npm pkg — secret never leaves
                    the browser. Right-click → save if user wants to print it. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={pendingFactor.qrDataUrl}
                  alt="2FA QR code"
                  width={240}
                  height={240}
                />
              </div>
              <div>
                <div className="text-xs muted mb-1">Can&rsquo;t scan? Type this secret into the app manually:</div>
                <code className="block text-[12px] font-mono bg-slate-100 rounded px-2 py-2 break-all select-all">
                  {pendingFactor.secret}
                </code>
              </div>
            </div>
            <label className="label">6-digit code</label>
            <input
              className="input font-mono text-center tracking-widest"
              inputMode="numeric"
              maxLength={6}
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ""))}
              placeholder="123456"
              autoFocus
            />
            <div className="mt-3 flex gap-2 justify-end">
              <button type="button" className="btn btn-ghost" onClick={cancelPending} disabled={verifyBusy}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={confirmEnroll} disabled={verifyBusy || verifyCode.length !== 6}>
                {verifyBusy && <Loader2 size={14} className="animate-spin" />} Confirm and enable
              </button>
            </div>
          </>
        ) : verified.length > 0 ? (
          <>
            <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-3 inline-flex items-center gap-2">
              <CheckCircle2 size={14} /> 2FA is enabled
            </div>
            <ul className="text-sm divide-y divide-slate-100">
              {verified.map((f) => (
                <li key={f.id} className="py-2 flex items-center justify-between">
                  <div>
                    <div className="font-medium">{f.friendly_name || "TOTP authenticator"}</div>
                    <div className="text-xs muted">factor id: <code>{f.id.slice(0, 8)}…</code></div>
                  </div>
                  <button type="button" className="btn btn-ghost text-xs text-red-700" onClick={() => unenroll(f.id)}>
                    Disable
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p className="text-sm muted mb-3">
              No second factor on this account yet. Adding one means anyone trying to sign in needs both your password and a code from your phone.
            </p>
            <button type="button" className="btn btn-primary" onClick={startEnroll} disabled={enrolling}>
              {enrolling && <Loader2 size={14} className="animate-spin" />} Enable 2FA
            </button>
          </>
        )}
      </div>
    </main>
  );
}
