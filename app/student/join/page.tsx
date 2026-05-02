"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function JoinPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setErr(null);
    const c = code.trim().toUpperCase();
    if (c.length < 4) return setErr("Please enter a valid quiz code.");
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { setErr("Please sign in first."); setBusy(false); return; }
      const r = await fetch(`/api/student/quiz-by-code?code=${encodeURIComponent(c)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (r.status === 404) { setErr("No quiz found with that code. Double-check with your teacher."); setBusy(false); return; }
      if (r.status === 410) { setErr("This quiz is closed."); setBusy(false); return; }
      if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(j?.error || "Lookup failed."); setBusy(false); return; }
      router.push(`/student/quiz/${c}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Lookup failed");
      setBusy(false);
    }
  }

  return (
    <div className="max-w-md mx-auto fade-in">
      <h1 className="h1">Join a test</h1>
      <p className="muted mt-1">Enter the 6-character code your teacher shared.</p>

      <div className="card mt-6">
        <label className="label">Test code</label>
        <input
          className="input text-center text-2xl tracking-[0.4em] font-mono uppercase"
          maxLength={8}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABC123"
          autoFocus
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
        {err && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}
        <button className="btn btn-primary w-full mt-4" onClick={go} disabled={busy}>
          {busy ? <><span className="spinner" /> Loading…</> : "Start quiz"}
        </button>
      </div>
    </div>
  );
}
