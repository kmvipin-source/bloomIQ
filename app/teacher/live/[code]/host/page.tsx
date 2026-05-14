"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Play, ArrowLeft, Copy, Check, Trophy, Users } from "lucide-react";

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

type Player = {
  student_id: string;
  display_name: string | null;
  score: number;
};

type LeaderRow = { student_id: string; display_name: string | null; score: number };

const KAHOOT_COLORS = [
  "bg-red-500 hover:bg-red-600",
  "bg-blue-500 hover:bg-blue-600",
  "bg-amber-500 hover:bg-amber-600",
  "bg-emerald-500 hover:bg-emerald-600",
];

export default function LiveHostPage() {
  const params = useParams();
  const router = useRouter();
  const code = String(params?.code || "");
  const [state, setState] = useState<State | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderRow[]>([]);
  const [now, setNow] = useState<number>(Date.now());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const advancedRef = useRef<number>(-1); // last idx auto-advanced

  // Poll state every 2s. AbortController on each tick so in-flight
  // requests are cancelled when the component unmounts (avoids
  // bandwidth waste + late-resolved promises updating state on a dead
  // tree).
  useEffect(() => {
    let stopped = false;
    const ctl = new AbortController();
    async function tick() {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        const res = await fetch(`/api/live/${code}/state`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
          signal: ctl.signal,
        });
        const data = await res.json();
        if (!res.ok) {
          setErr(data.error || "State error");
          return;
        }
        if (!stopped) setState(data as State);

        // Players list — host RLS allows reading.
        const { data: { user } } = await sb.auth.getUser();
        if (user && data?.session?.id) {
          const { data: pl } = await sb
            .from("live_session_players")
            .select("student_id, display_name, score")
            .eq("session_id", (data as State).session.id)
            .order("score", { ascending: false });
          if (!stopped) setPlayers((pl as Player[]) || []);
        }

        if ((data as State)?.session?.status === "ended") {
          const lb = await fetch(`/api/live/${code}/leaderboard`, {
            headers: { Authorization: `Bearer ${session.access_token}` },
            signal: ctl.signal,
          });
          const ld = await lb.json();
          if (lb.ok && !stopped) setLeaderboard((ld.rows as LeaderRow[]) || []);
        }
      } catch {
        /* polling errors are silent — includes AbortError on unmount */
      }
    }
    tick();
    const id = setInterval(tick, 2000);
    return () => { stopped = true; ctl.abort(); clearInterval(id); };
  }, [code]);

  // Local clock for countdown.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const elapsedSec = useMemo(() => {
    const start = state?.session.question_started_at ? new Date(state.session.question_started_at).getTime() : 0;
    if (!start) return 0;
    return Math.max(0, (now - start) / 1000);
  }, [state, now]);

  const remainingSec = useMemo(() => {
    if (!state?.session.seconds_per_question) return 0;
    return Math.max(0, state.session.seconds_per_question - elapsedSec);
  }, [state, elapsedSec]);

  // Auto-advance: when timer ends OR all players have answered, host pings /next.
  useEffect(() => {
    if (!state) return;
    if (state.session.status !== "running") return;
    if (state.role !== "host") return;
    const idx = state.session.current_question_idx;
    if (advancedRef.current === idx) return;

    let shouldAdvance = false;
    if (remainingSec <= 0 && state.session.question_started_at) {
      shouldAdvance = true;
    }
    // (We can't easily know answered-count here without another query; skip
    // that auto-trigger. Host can hit Next manually anytime.)
    if (shouldAdvance) {
      advancedRef.current = idx;
      void advance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remainingSec, state]);

  async function callHost(path: string) {
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error("Please sign in.");
    const res = await fetch(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Action failed");
    return data;
  }

  async function startRunning() {
    setBusy(true); setErr(null);
    try { await callHost(`/api/live/${code}/start-running`); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed."); }
    finally { setBusy(false); }
  }

  async function advance() {
    setBusy(true); setErr(null);
    try { await callHost(`/api/live/${code}/next`); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed."); }
    finally { setBusy(false); }
  }

  async function hostAgain() {
    if (!state) return;
    setBusy(true); setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Please sign in.");
      // Look up the original quiz_id via the session row.
      const { data: row } = await sb
        .from("live_sessions")
        .select("quiz_id, seconds_per_question")
        .eq("code", code)
        .maybeSingle();
      if (!row) throw new Error("Original session vanished.");
      const r = row as { quiz_id: string; seconds_per_question: number };
      const res = await fetch("/api/live/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ quiz_id: r.quiz_id, seconds_per_question: r.seconds_per_question }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start.");
      router.push(`/teacher/live/${data.code}/host`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  async function copyJoinLink() {
    const url = `${window.location.origin}/student/live/${code}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silent */
    }
  }

  if (!state) {
    return <div className="grid place-items-center py-20"><div className="spinner" /></div>;
  }

  const pct = state.session.seconds_per_question > 0
    ? Math.max(0, Math.min(100, (remainingSec / state.session.seconds_per_question) * 100))
    : 0;

  return (
    <div className="max-w-5xl mx-auto fade-in">
      <Link href="/teacher/live" className="text-sm text-slate-500 hover:text-slate-800 inline-flex items-center gap-1">
        <ArrowLeft size={14} /> Pick another quiz
      </Link>

      {err && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}

      {/* LOBBY */}
      {state.session.status === "lobby" && (
        <div className="mt-4">
          <div className="card text-center py-10">
            <div className="text-xs uppercase tracking-wide muted font-semibold">Join code</div>
            <div className="text-7xl font-extrabold tracking-[0.2em] text-emerald-700 my-3 select-all">{code}</div>
            <button type="button" onClick={copyJoinLink} className="btn btn-secondary inline-flex">
              {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy join link</>}
            </button>
            <div className="text-xs muted mt-3">Students go to <code>/student/live/{code}</code> on their device.</div>
          </div>

          <div className="card mt-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold flex items-center gap-2"><Users size={16} /> Players ({state.players_count})</h3>
              <span className="text-xs muted">{state.session.seconds_per_question}s per question</span>
            </div>
            {players.length === 0 ? (
              <div className="muted text-sm">Waiting for students to join…</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {players.map((p) => (
                  <span key={p.student_id} className="text-sm px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-900">
                    {p.display_name || "Player"}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={startRunning}
                disabled={busy || state.players_count === 0}
                aria-label={busy ? "Starting quiz" : "Start quiz"}
                aria-busy={busy}
                className="btn btn-primary"
              >
                {busy ? <span className="spinner" /> : <><Play size={14} /> Start quiz</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RUNNING */}
      {state.session.status === "running" && (
        <div className="mt-4">
          <div className="flex items-center justify-between text-sm muted mb-2">
            <span>Question {state.session.current_question_idx + 1} of {state.session.total_questions}</span>
            <span>{Math.ceil(remainingSec)}s left · {state.players_count} players</span>
          </div>
          <div className="h-2 bg-slate-200 rounded-full overflow-hidden mb-4">
            <div className="h-full bg-gradient-to-r from-emerald-500 to-amber-500 transition-all" style={{ width: `${pct}%` }} />
          </div>

          {state.current_question && (
            <div className="card">
              <div className="text-2xl font-bold mb-4">{state.current_question.stem}</div>
              <div className="grid sm:grid-cols-2 gap-3">
                {state.current_question.options.map((o, i) => (
                  <div key={i} className={`text-white text-xl font-semibold rounded-xl p-5 ${KAHOOT_COLORS[i]}`}>
                    <span className="opacity-70 text-sm uppercase mr-2">{String.fromCharCode(65 + i)}</span>{o}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={advance}
              disabled={busy}
              aria-label={busy ? "Advancing to next question" : "Next question"}
              aria-busy={busy}
              className="btn btn-primary"
            >
              {busy ? <span className="spinner" /> : "Next question"}
            </button>
          </div>
        </div>
      )}

      {/* ENDED */}
      {state.session.status === "ended" && (
        <div className="mt-4">
          <div className="card text-center py-8">
            <Trophy size={42} className="mx-auto text-amber-500 mb-2" />
            <div className="text-2xl font-bold">Game over</div>
            <div className="muted text-sm">Here's your podium.</div>
          </div>

          {leaderboard.length > 0 && (
            <div className="grid grid-cols-3 gap-3 mt-4 max-w-xl mx-auto">
              {/*
                Podium layout: slot 0 = left (2nd place), slot 1 = center
                (1st place, tallest), slot 2 = right (3rd place). The
                `slotToRank` array maps each display slot to the actual
                leaderboard rank to show in it. heights / colors / labels
                are now indexed by SLOT (not rank), so the 1st-place
                player always lands on the gold center pillar.
              */}
              {(() => {
                const slotToRank = [1, 0, 2]; // 2nd, 1st, 3rd
                const heights = ["h-32", "h-40", "h-24"];
                const colors = ["bg-slate-300", "bg-amber-400", "bg-amber-700"];
                const labels = ["2nd", "1st", "3rd"];
                return slotToRank.map((rank, slot) => {
                  const p = leaderboard[rank];
                  if (!p) return <div key={`empty-${slot}`} />;
                  return (
                    <div key={p.student_id} className="flex flex-col items-center justify-end">
                      <div className="text-sm font-semibold mb-1 text-center">{p.display_name || "Player"}</div>
                      <div className="text-xs muted mb-1">{p.score} pts</div>
                      <div className={`${heights[slot]} ${colors[slot]} w-full rounded-t-lg grid place-items-center text-white font-bold`}>
                        {labels[slot]}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}

          {leaderboard.length > 0 && (
            <div className="card mt-4">
              <div className="font-semibold mb-2">Full leaderboard</div>
              <ol className="space-y-1">
                {leaderboard.map((p, i) => (
                  <li key={p.student_id} className="flex items-center justify-between text-sm">
                    <span><strong className="mr-2">{i + 1}.</strong>{p.display_name || "Player"}</span>
                    <span className="font-semibold">{p.score}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="mt-4 flex justify-center">
            <button type="button" onClick={hostAgain} disabled={busy} className="btn btn-primary">
              {busy ? <span className="spinner" /> : "Host again"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
