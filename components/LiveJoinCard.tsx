"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Radio, ArrowRight } from "lucide-react";

/**
 * <LiveJoinCard />
 *
 * Slot at the top of the school student dashboard's "Assigned to you"
 * section. Lets a student join a live class quiz that the teacher has
 * just hosted by typing the 6-character code the teacher reads out (or
 * projects on a board).
 *
 * Flow:
 *   1. Teacher goes to /teacher/live → picks a quiz → backend mints a
 *      6-char code → teacher lands on /teacher/live/[code]/host with
 *      the code on screen.
 *   2. Teacher reads / shows the code to the class.
 *   3. Student types it here → we navigate to /student/live/[code],
 *      where the existing join flow takes over (display-name capture,
 *      lobby, then the live questions).
 *
 * Accepts only the alphabet used by the live-session generator — A–Z
 * and 2–9 minus visually-confusable I, O, 0, 1 (see
 * app/api/live/start/route.ts ALPHABET). We don't strictly enforce
 * the alphabet here — the server will reject an unknown code anyway —
 * but we uppercase + length-cap so a hurried student doesn't typo a
 * lowercase letter or paste extra whitespace and get a misleading
 * "Session not found" response.
 */
export default function LiveJoinCard() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function submit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setErr(null);
    const c = code.trim().toUpperCase();
    if (c.length !== 6) {
      setErr("The code is 6 characters long.");
      return;
    }
    if (!/^[A-Z0-9]+$/.test(c)) {
      setErr("Letters and numbers only.");
      return;
    }
    setBusy(true);
    // Navigation handles the rest — the live page does the actual
    // join API call and surfaces "Session not found" if the code is
    // wrong / the session has ended.
    router.push(`/student/live/${c}`);
  }

  return (
    <form
      onSubmit={submit}
      className="card flex items-center gap-4 flex-wrap mt-4"
      style={{
        background:
          "linear-gradient(135deg, color-mix(in oklab, #fb7185 8%, var(--color-card)) 0%, color-mix(in oklab, #f472b6 6%, var(--color-card)) 100%)",
        borderColor: "color-mix(in oklab, #fb7185 30%, var(--color-border))",
      }}
    >
      <div className="rounded-lg bg-gradient-to-br from-fuchsia-500 to-rose-500 text-white p-2 shrink-0">
        <Radio size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-base">Live class quiz</div>
        <div className="text-xs muted mt-0.5">
          Got a code from your teacher? Type it below to join the live session.
        </div>
      </div>
      <input
        className="input text-center text-xl tracking-[0.3em] font-mono uppercase w-44"
        maxLength={6}
        value={code}
        onChange={(e) => {
          setErr(null);
          setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
        }}
        placeholder="ABC123"
        aria-label="6-character live quiz code"
        autoComplete="off"
        autoCapitalize="characters"
      />
      <button
        type="submit"
        className="btn btn-primary"
        disabled={busy || code.length !== 6}
      >
        {busy ? (
          <>
            <span className="spinner" /> Joining…
          </>
        ) : (
          <>
            Join Live <ArrowRight size={14} />
          </>
        )}
      </button>
      {err && (
        <div className="basis-full text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
          {err}
        </div>
      )}
    </form>
  );
}
