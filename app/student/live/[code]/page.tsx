"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Trophy, ArrowLeft, Check } from "lucide-react";

type State = {
  session: {
    id: string;
    status: "lobby" | "running" | "ended";
    current_question_idx: number;
    seconds_per_question: number;
    question_started_at: string | null;
    ended_at: string | null;
    total_questions: number;
  };
  role: "host" | "player" | "viewer";
  players_count: number;
  current_question: {
    id: string;
    stem: string;
    options: string[];
    bloom_level: string;
    topic: string | null;
    idx: number;
  } | null;
};

type LeaderRow = { student_id: string; display_name: string | null; score: number };

const KAHOOT_COLORS = [
  "bg-red-500 hover:bg-red-600 active:bg-red-700",
  "bg-blue-500 hover:bg-blue-600 active:bg-blue-700",
  "bg-amber-500 hover:bg-amber-600 active:bg-amber-700",
  "bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700",
];

export default function StudentLivePage() {
  const params = useParams();
  const code = String(params?.code || "");
  const [joined, setJoined] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [defaultName, setDefaultName] = useState("");
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [picked, setPicked] = useState<{ idx: number; awarded: number; is_correct: boolean } | null>(null);
  const [score, setScore] = useState(0);
  const [leaderboard, setLeaderboard] = useState<LeaderRow[]>([]);
  const lastIdxRef = useRef<number>(-1);

  // Load student name as default.
  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { data: prof } = await sb.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
      const fn = (prof as { full_name: string | null } | null)?.full_name?.trim() || "";
      setDefaultName(fn);
      setDisplayName(fn);
    })();
  }, []);

  // Poll state every 2s once joined.
  useEffect(() => {
    if (!joined) return;
    let stopped = false;
    async function tick() {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        const res = await fetch(`/api/live/${code}/state`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const data = await res.json();
        if (!res.ok) {
          setErr(data.error || "Could not load state.");
          return;
        }
        if (!stopped) setState(data as State);

        // Reset pick when question advances.
        const idx = (data as State).session.current_question_idx;
        if (idx !== lastIdxRef.current) {
          lastIdxRef.current = idx;
          setPicked(null);
        }

        if ((data as State).session.status === "ended") {
          const lb = await fetch(`/api/live/${code}/leaderboard`, {
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
          const ld = await lb.json();
          if (lb.ok && !stopped) setLeaderboard((ld.rows as LeaderRow[]) || []);
        }
      } catch {
        /* silent */
      }
    }
    tick();
    const id = setInterval(tick, 2000);
    return () => { stopped = true; clearInterval(id); };
  }, [code, joined]);

  // Local clock for countdown.
  useEffect(() => {
    if (!joined) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [joined]);

  const remainingSec = useMemo(() => {
    if (!state?.session.seconds_per_question) return 0;
    const start = state.session.question_started_at ? new Date(state.session.question_started_at).getTime() : 0;
    if (!start) return 0;
    const elapsed = (now - start) / 1000;
    return Math.max(0, state.session.seconds_per_question - elapsed);
  }, [state, now]);

  async function join() {
    setBusy(true); setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Please sign in to join.");
      const res = await fetch(`/api/live/${code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ display_name: displayName || defaultName || "Player" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not join.");
      setJoined(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Join failed.");
    } finally {
      setBusy(false);
    }
  }

  async function pick(i: number) {
    if (!state || !state.session.question_started_at) return;
    if (picked) return;
    setBusy(true); setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Please sign in.");
      const start = new Date(state.session.question_started_at).getTime();
      const elapsedMs = Math.max(0, Date.now() - start);
      const res = await fetch(`/api/live/${code}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ selected_index: i, time_taken_ms: elapsedMs }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Submit failed.");
      setPicked({ idx: i, awarded: data.awarded_points || 0, is_correct: !!data.is_correct });
      setScore(typeof data.score === "number" ? data.score : score);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Submit failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!joined) {
    return (
      <div className="max-w-md mx-auto fade-in">
        <Link href="/student" className="text-sm text-slate-500 hover:text-slate-800 inline-flex items-center gap-1">
          <ArrowLeft size={14} /> Back home
        </Link>
        <div className="card mt-3 text-center">
          <div className="text-xs uppercase tracking-wide muted font-semibold">Joining quiz</div>
          <div className="text-3xl font-extrabold tracking-[0.15em] my-2">{code}</div>
          <label className="label text-left">Display name</label>
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name"
            maxLength={40}
          />
          {err && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}
          <button onClick={join} disabled={busy} className="btn btn-primary w-full mt-3">
            {busy ? <span className="spinner" /> : "Join"}
          </button>
        </div>
      </div>
    );
  }

  if (!state) {
    return <div className="grid place-items-center py-20"><div className="spinner" /></div>;
  }

  return (
    <div className="max-w-2xl mx-auto fade-in">
      <Link href="/student" className="text-sm text-slate-500 hover:text-slate-800 inline-flex items-center gap-1">
        <ArrowLeft size={14} /> Leave
      </Link>

      {err && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}

      {state.session.status === "lobby" && (
        <div className="card mt-3 text-center py-10">
          <div className="text-5xl mb-3">⏳</div>
          <div className="text-xl font-bold mb-1">Waiting for teacher to start…</div>
          <div className="text-sm muted">{state.players_count} player{state.players_count === 1 ? "" : "s"} in the lobby.</div>
        </div>
      )}

      {state.session.status === "running" && state.current_question && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-sm muted mb-2">
            <span>Question {state.session.current_question_idx + 1} of {state.session.total_questions}</span>
            <span>{Math.ceil(remainingSec)}s · score {score}</span>
          </div>
          <div className="card mb-3">
            <div className="text-base font-medium">{state.current_question.stem}</div>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            {state.current_question.options.map((o, i) => {
              const isPick = picked?.idx === i;
              const dim = picked && !isPick ? "opacity-40" : "";
              return (
                <button
                  key={i}
                  onClick={() => pick(i)}
                  disabled={!!picked || busy || remainingSec <= 0}
                  className={`text-white text-lg font-semibold rounded-xl p-5 text-left transition ${KAHOOT_COLORS[i]} ${dim}`}
                >
                  <span className="opacity-70 text-xs uppercase mr-2">{String.fromCharCode(65 + i)}</span>{o}
                </button>
              );
            })}
          </div>
          {picked && (
            <div className="card mt-3 text-center">
              <div className="font-semibold inline-flex items-center gap-2">
                <Check size={16} className="text-emerald-600" /> Locked in
              </div>
              <div className="text-sm muted mt-1">+{picked.awarded} pts · waiting for next question…</div>
            </div>
          )}
        </div>
      )}

      {state.session.status === "ended" && (
        <div className="mt-3">
          <div className="card text-center py-8">
            <Trophy size={42} className="mx-auto text-amber-500 mb-2" />
            <div className="text-xl font-bold">Quiz over</div>
            <div className="muted text-sm">Final score: <strong>{score}</strong></div>
            {(() => {
              const me = leaderboard.findIndex((r) => r.score === score);
              const rank = me >= 0 ? me + 1 : null;
              return rank ? <div className="muted text-sm mt-1">You finished #{rank}</div> : null;
            })()}
          </div>
          {leaderboard.length > 0 && (
            <div className="card mt-3">
              <div className="font-semibold mb-2">Top 5</div>
              <ol className="space-y-1">
                {leaderboard.slice(0, 5).map((p, i) => (
                  <li key={p.student_id} className="flex items-center justify-between text-sm">
                    <span><strong className="mr-2">{i + 1}.</strong>{p.display_name || "Player"}</span>
                    <span className="font-semibold">{p.score}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
