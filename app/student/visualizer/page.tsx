"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  Film, Sparkles, ArrowLeft, Loader2, Play, Pause, ChevronLeft, ChevronRight, History, RotateCcw,
} from "lucide-react";

type Frame = { svg: string; caption: string; duration_ms: number };
type Animation = {
  id: string;
  title: string;
  summary: string | null;
  frames: Frame[];
};
type HistoryRow = {
  id: string;
  topic: string;
  title: string | null;
  created_at: string;
};

export default function VisualizerPage() {
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [animation, setAnimation] = useState<Animation | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [progress, setProgress] = useState(0);
  const advanceTimer = useRef<number | null>(null);
  const tickTimer = useRef<number | null>(null);
  const frameStartedAt = useRef<number>(Date.now());

  useEffect(() => { void loadHistory(); }, []);

  useEffect(() => {
    if (!animation) return;
    setFrameIdx(0);
    setPlaying(true);
    setProgress(0);
    frameStartedAt.current = Date.now();
  }, [animation]);

  useEffect(() => {
    if (!animation || !playing) {
      if (advanceTimer.current) window.clearTimeout(advanceTimer.current);
      if (tickTimer.current) window.clearInterval(tickTimer.current);
      return;
    }
    const dur = animation.frames[frameIdx]?.duration_ms || 4500;
    frameStartedAt.current = Date.now();
    setProgress(0);

    advanceTimer.current = window.setTimeout(() => {
      setFrameIdx((i) => {
        if (!animation) return 0;
        if (i >= animation.frames.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, dur) as unknown as number;

    tickTimer.current = window.setInterval(() => {
      const elapsed = Date.now() - frameStartedAt.current;
      setProgress(Math.min(1, elapsed / dur));
    }, 100) as unknown as number;

    return () => {
      if (advanceTimer.current) window.clearTimeout(advanceTimer.current);
      if (tickTimer.current) window.clearInterval(tickTimer.current);
    };
  }, [animation, frameIdx, playing]);

  async function loadHistory() {
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    const { data } = await sb
      .from("concept_animations")
      .select("id, topic, title, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(10);
    setHistory((data as unknown as HistoryRow[]) || []);
  }

  async function loadOne(id: string) {
    const sb = supabaseBrowser();
    const { data } = await sb
      .from("concept_animations")
      .select("id, title, summary, frames")
      .eq("id", id)
      .maybeSingle();
    if (data) {
      const a = data as { id: string; title: string; summary: string | null; frames: Frame[] };
      setAnimation({ id: a.id, title: a.title, summary: a.summary, frames: a.frames || [] });
    }
  }

  async function generate() {
    setErr(null);
    if (topic.trim().length < 3) {
      setErr("Type at least 3 characters.");
      return;
    }
    setBusy(true);
    setAnimation(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired - please sign in again.");
      const r = await fetch("/api/visualizer/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ topic: topic.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Visualizer failed");
      setAnimation({
        id: j.id,
        title: j.title,
        summary: j.summary,
        frames: j.frames as Frame[],
      });
      void loadHistory();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Visualizer failed");
    } finally {
      setBusy(false);
    }
  }

  function prev() {
    if (!animation) return;
    setPlaying(false);
    setFrameIdx((i) => Math.max(0, i - 1));
  }
  function next() {
    if (!animation) return;
    setPlaying(false);
    setFrameIdx((i) => Math.min(animation.frames.length - 1, i + 1));
  }
  function togglePlay() {
    if (!animation) return;
    if (frameIdx >= animation.frames.length - 1 && !playing) {
      setFrameIdx(0);
    }
    setPlaying((p) => !p);
  }
  function restart() {
    setFrameIdx(0);
    setPlaying(true);
  }

  // Six pre-baked Ken-Burns shots that cycle through the frames so the camera
  // never moves the same way twice in a row. Each is from->to transform pair.
  const SHOTS = [
    { from: "scale(1.00) translate(0%, 0%)",   to: "scale(1.06) translate(-2%, -1%)" },
    { from: "scale(1.06) translate(-1%, -1%)", to: "scale(1.00) translate(0%, 0%)"   },
    { from: "scale(1.00) translate(-2%, 0%)",  to: "scale(1.05) translate(2%, 0%)"   },
    { from: "scale(1.05) translate(0%, -1%)",  to: "scale(1.00) translate(0%, 1%)"   },
    { from: "scale(1.00) translate(0%, -1%)",  to: "scale(1.04) translate(-1%, 1%)"  },
    { from: "scale(1.03) translate(1%, 0%)",   to: "scale(1.00) translate(-1%, 0%)"  },
  ];

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
        <ArrowLeft size={14} /> Back to dashboard
      </Link>

      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-fuchsia-100 text-fuchsia-700 p-3 shrink-0">
          <Film size={22} />
        </div>
        <div className="flex-1">
          <h1 className="h1">Concept Visualizer</h1>
          <p className="muted mt-1">
            Type any concept and watch it animated step by step. Best for the things that don&apos;t click from words alone - biology cycles, mechanics diagrams, electric circuits, chemistry mechanisms.
          </p>
        </div>
      </div>

      <div className="card mt-6">
        <label className="label">What do you want explained?</label>
        <input
          className="input"
          placeholder="e.g. Krebs cycle, Newton's third law in pulleys, how a transistor amplifies"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          maxLength={200}
        />
        {err && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>
        )}
        <button className="btn btn-primary mt-3" onClick={generate} disabled={busy}>
          {busy ? <><Loader2 className="animate-spin" size={16} /> Animating...</> : <><Sparkles size={16} /> Animate it</>}
        </button>
      </div>

      {animation && animation.frames.length > 0 && (() => {
        const dur = animation.frames[frameIdx]?.duration_ms || 4500;
        const shot = SHOTS[frameIdx % SHOTS.length];
        return (
          <div className="card mt-4">
            <div className="text-xs uppercase tracking-wide font-semibold text-fuchsia-700">Now playing</div>
            <h2 className="font-bold text-lg mt-0.5">{animation.title}</h2>

            <style key={`anim-${frameIdx}-${dur}`}>{`
              .vz-active { animation: vz-burns ${dur}ms cubic-bezier(.4,0,.2,1) both; transform-origin: 50% 50%; }
              .vz-frame  { animation: vz-frame-in 650ms cubic-bezier(.2,.7,.2,1) both; }
              @keyframes vz-burns {
                from { transform: ${shot.from}; }
                to   { transform: ${shot.to};   }
              }
              @keyframes vz-frame-in {
                from { opacity: 0; filter: blur(4px); }
                to   { opacity: 1; filter: blur(0);   }
              }
            `}</style>

            <div className="relative mt-3 rounded-lg border border-slate-200 bg-white overflow-hidden" style={{ aspectRatio: "5 / 3" }}>
              {animation.frames.map((f, i) => (
                <div
                  key={i}
                  className={`absolute inset-0 transition-opacity duration-500 ${i === frameIdx ? "vz-active vz-frame" : ""}`}
                  style={{ opacity: i === frameIdx ? 1 : 0, pointerEvents: i === frameIdx ? "auto" : "none" }}
                  aria-hidden={i !== frameIdx}
                  dangerouslySetInnerHTML={{ __html: wrapResponsiveSvg(f.svg) }}
                />
              ))}

              <div className="absolute top-0 left-0 right-0 h-1 bg-slate-100">
                <div
                  className="h-full bg-fuchsia-500 transition-all"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>

              <div className="absolute top-2 right-2 text-[10px] uppercase tracking-wide font-bold bg-slate-900/70 text-white rounded-full px-2 py-0.5">
                {frameIdx + 1} / {animation.frames.length}
              </div>
            </div>

            <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-sm text-slate-800 min-h-[3rem]">
              {animation.frames[frameIdx]?.caption || ""}
            </div>

            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <button className="btn btn-secondary" onClick={prev} disabled={frameIdx === 0}>
                <ChevronLeft size={14} /> Previous
              </button>
              <button className="btn btn-primary" onClick={togglePlay}>
                {playing ? <><Pause size={14} /> Pause</> : <><Play size={14} /> Play</>}
              </button>
              <button className="btn btn-secondary" onClick={next} disabled={frameIdx >= animation.frames.length - 1}>
                Next <ChevronRight size={14} />
              </button>
              <button className="btn btn-ghost" onClick={restart}>
                <RotateCcw size={14} /> Restart
              </button>
            </div>

            {animation.summary && (
              <div className="mt-4">
                <div className="text-xs uppercase tracking-wide font-semibold text-slate-500 mb-1">Key idea</div>
                <p className="text-sm text-slate-700">{animation.summary}</p>
              </div>
            )}
          </div>
        );
      })()}

      <h2 className="h2 mt-10 mb-3 flex items-center gap-2">
        <History size={18} /> Recent animations
      </h2>
      {history.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">No animations yet - try one above.</div>
      ) : (
        <div className="space-y-2">
          {history.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => loadOne(h.id)}
              className="w-full card card-hover text-left flex items-center gap-3"
            >
              <div className="rounded-lg bg-fuchsia-100 text-fuchsia-700 p-2 shrink-0"><Film size={16} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">{h.title || h.topic}</div>
                <div className="text-xs muted">{new Date(h.created_at).toLocaleDateString()}</div>
              </div>
              <span className="text-emerald-700 text-xs font-semibold">Replay</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Strip width/height from the AI-generated <svg> opening tag so the SVG
// scales to fill the player container via its viewBox.
function wrapResponsiveSvg(svg: string): string {
  if (!svg.startsWith("<svg")) return svg;
  return svg.replace(/^<svg([^>]*)>/, (_m, attrs: string) => {
    const cleaned = String(attrs)
      .replace(/\swidth\s*=\s*"[^"]*"/gi, "")
      .replace(/\sheight\s*=\s*"[^"]*"/gi, "");
    return `<svg${cleaned} style="width:100%;height:100%;display:block">`;
  });
}
