"use client";

import { useEffect, useState } from "react";

/**
 * Lightweight client-side bot deterrent.
 *
 * Triggered on /login after the user has failed to sign in N times in a
 * window. Shows a one-shot arithmetic puzzle. Must be solved before the
 * Sign in button re-enables.
 *
 * This is NOT real anti-fraud — a determined bot can solve this trivially.
 * It just stops casual credential stuffing from hammering the form. For
 * server-side bot defence, swap to hCaptcha or Cloudflare Turnstile and
 * pass the token to supabase auth via `options.captchaToken`.
 *
 * Persistence: failure count + first-failure timestamp stored in
 * localStorage keyed by the lowercased identifier so a bot can't switch
 * accounts to bypass.
 */

const LS_KEY = "bloomiq_login_failures_v1";
const WINDOW_MS = 10 * 60 * 1000;     // 10 minutes
export const FAIL_THRESHOLD = 3;       // strikes before captcha kicks in

type FailureMap = Record<string, { count: number; firstAt: number; lastAt: number }>;

function readFailures(): FailureMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as FailureMap;
  } catch { return {}; }
}

function writeFailures(m: FailureMap): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(LS_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

function keyFor(identifier: string): string {
  return identifier.trim().toLowerCase();
}

export function recordLoginFailure(identifier: string): number {
  const now = Date.now();
  const m = readFailures();
  const k = keyFor(identifier);
  const cur = m[k];
  if (!cur || now - cur.firstAt > WINDOW_MS) {
    m[k] = { count: 1, firstAt: now, lastAt: now };
  } else {
    m[k] = { count: cur.count + 1, firstAt: cur.firstAt, lastAt: now };
  }
  writeFailures(m);
  return m[k].count;
}

export function clearLoginFailures(identifier: string): void {
  const m = readFailures();
  delete m[keyFor(identifier)];
  writeFailures(m);
}

export function captchaRequired(identifier: string): boolean {
  if (!identifier.trim()) return false;
  const now = Date.now();
  const cur = readFailures()[keyFor(identifier)];
  if (!cur) return false;
  if (now - cur.firstAt > WINDOW_MS) return false;
  return cur.count >= FAIL_THRESHOLD;
}

function makePuzzle(): { question: string; answer: number } {
  const a = 2 + Math.floor(Math.random() * 8);   // 2..9
  const b = 2 + Math.floor(Math.random() * 8);
  const op = Math.random() < 0.5 ? "+" : "*";
  return op === "+"
    ? { question: `${a} + ${b}`, answer: a + b }
    : { question: `${a} × ${b}`, answer: a * b };
}

export default function LoginCaptcha({
  onPass,
  onFail,
}: {
  onPass: () => void;
  onFail?: () => void;
}) {
  const [puzzle, setPuzzle] = useState(() => makePuzzle());
  const [val, setVal] = useState("");
  const [status, setStatus] = useState<"idle" | "wrong">("idle");

  // Reset on remount.
  useEffect(() => { setVal(""); setStatus("idle"); }, []);

  function check() {
    const n = parseInt(val.trim(), 10);
    if (Number.isFinite(n) && n === puzzle.answer) {
      setStatus("idle");
      onPass();
    } else {
      setStatus("wrong");
      onFail?.();
      setPuzzle(makePuzzle());
      setVal("");
    }
  }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm">
      <div className="text-xs font-semibold text-amber-900 mb-1.5">
        Quick check — too many failed sign-ins
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-base text-slate-900">
          {puzzle.question} =
        </span>
        <input
          type="number"
          inputMode="numeric"
          className="input flex-1 text-sm"
          style={{ maxWidth: 120 }}
          value={val}
          onChange={(e) => { setVal(e.target.value); setStatus("idle"); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); check(); } }}
          autoFocus
        />
        <button type="button" className="btn btn-secondary text-xs" onClick={check}>
          Check
        </button>
      </div>
      {status === "wrong" && (
        <div className="text-xs text-red-700 mt-1">Not quite — try the new puzzle.</div>
      )}
    </div>
  );
}
