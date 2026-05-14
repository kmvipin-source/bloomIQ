"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  Mic, MicOff, Volume2, VolumeX, ArrowLeft, Loader2, Bot, Trash2, Sparkles, Film,
} from "lucide-react";
import { suggestedTopics } from "@/lib/topicSuggestions";
import { type LearnerProfile } from "@/components/LearnerProfilePrompt";
import CurrentGoalChip from "@/components/CurrentGoalChip";
import DOMPurify from "isomorphic-dompurify";

// =============================================================================
// VOICE AI TEACHER — speak your doubt, hear the answer back. The student
// experience: tap mic, ask question naturally, see live transcript, hear
// AI voice reply, optionally see the Concept Visualizer animation alongside.
//
// Voice handling is 100% browser-side via the Web Speech API (free, no
// extra AI cost). The chat content uses the existing /api/tutor/chat
// endpoint, so behavior matches the text-mode tutor exactly.
//
// Browser support: Speech Recognition is Chrome/Edge/Safari. Speech Synthesis
// is universal. We graceful-degrade if recognition is unavailable.
// =============================================================================

type Turn = { role: "user" | "assistant"; content: string };

// Web Speech types — narrowest possible to keep TS happy without DOM lib changes.
type SR = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: { results: { 0: { transcript: string }; isFinal: boolean }[] & { length: number } }) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
};

declare global {
  interface Window {
    SpeechRecognition?: new () => SR;
    webkitSpeechRecognition?: new () => SR;
  }
}

export default function VoiceTeacherPage() {
  const [history, setHistory] = useState<Turn[]>([]);
  const [interim, setInterim] = useState<string>("");
  const [listening, setListening] = useState(false);
  const [voiceOut, setVoiceOut] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  // Goal-aware "try things like…" sample prompts (2026-05-12). Previously
  // hardcoded to "kinetic energy", "mitosis vs meiosis", and "Newton's
  // third law in pulleys" — a corporate trainee, CAT aspirant, or UPSC
  // student saw physics/biology prompts that have nothing to do with
  // their syllabus.
  const [examGoal, setExamGoal] = useState<string | null>(null);
  const [learnerProfile, setLearnerProfile] = useState<LearnerProfile | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        const { data: prof } = await sb
          .from("profiles")
          .select("exam_goal, learner_profile")
          .eq("id", user.id)
          .maybeSingle();
        const row = prof as { exam_goal: string | null; learner_profile: string | null } | null;
        if (row?.exam_goal) setExamGoal(row.exam_goal);
        const lp = row?.learner_profile;
        if (lp === "k12" || lp === "competitive_exam" || lp === "corporate") {
          setLearnerProfile(lp);
        }
      } catch { /* silent — falls back to k12 defaults */ }
    })();
  }, []);

  const samplePrompts = (() => {
    const tops = suggestedTopics(examGoal, learnerProfile).slice(0, 3);
    return tops.map((t) => `"Explain ${t} to me like I'm asking my teacher."`);
  })();

  // Animation panel (lazily loaded if user taps "Show me an animation")
  const [animTopic, setAnimTopic] = useState<string | null>(null);
  const [animLoading, setAnimLoading] = useState(false);
  const [animFrames, setAnimFrames] = useState<Array<{ svg: string; caption: string; duration_ms: number }>>([]);
  const [animFrameIdx, setAnimFrameIdx] = useState(0);

  const recognizerRef = useRef<SR | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const SR = (typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition)) || null;
    if (!SR) {
      setUnsupported(true);
      return;
    }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = "en-IN"; // Indian English first; users can speak Hindi/Tamil and most still works
    recognizerRef.current = rec;
  }, []);

  // Auto-scroll on new turn.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history, interim]);

  function startListening() {
    if (!recognizerRef.current) return;
    setErr(null);
    setInterim("");
    const rec = recognizerRef.current;
    let finalText = "";

    rec.onresult = (ev) => {
      let text = "";
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else text += r[0].transcript;
      }
      setInterim(finalText + text);
    };
    rec.onerror = (ev) => {
      const msg = ev?.error || "voice error";
      if (msg === "not-allowed") setErr("Microphone permission was denied. Allow it in your browser settings.");
      else if (msg === "no-speech") setErr("Didn't catch that — try again, a bit louder.");
      else setErr(`Voice error: ${msg}`);
      setListening(false);
    };
    rec.onend = () => {
      setListening(false);
      const said = (finalText || "").trim();
      if (said) void send(said);
      setInterim("");
    };

    try {
      rec.start();
      setListening(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start voice");
      setListening(false);
    }
  }

  function stopListening() {
    try { recognizerRef.current?.stop(); } catch { /* ignore */ }
    setListening(false);
  }

  async function send(message: string) {
    setErr(null);
    const newHistory: Turn[] = [...history, { role: "user", content: message }];
    setHistory(newHistory);
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");

      // Free-tier lifetime-once gate on Voice AI Teacher: claim the touch on
      // the FIRST message of this page session. Paid users always succeed.
      if (history.length === 0) {
        const tr = await fetch("/api/feature/touch", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ key: "voice_teacher" }),
        });
        if (!tr.ok) {
          const tj = await tr.json().catch(() => ({}));
          throw new Error(tj?.error || "Voice AI Teacher is a Premium feature.");
        }
      }

      const r = await fetch("/api/tutor/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ history: newHistory.slice(0, -1), message }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Tutor failed");
      const reply = j.reply as string;
      setHistory((h) => [...h, { role: "assistant", content: reply }]);
      if (voiceOut) speak(reply);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Tutor failed");
      setHistory((h) => h.slice(0, -1));
    } finally {
      setBusy(false);
    }
  }

  function speak(text: string) {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-IN";
      u.rate = 1.0;
      u.pitch = 1.0;
      window.speechSynthesis.speak(u);
    } catch { /* swallow — voice is optional */ }
  }

  function stopSpeaking() {
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  }

  function reset() {
    stopSpeaking();
    setHistory([]);
    setInterim("");
    setErr(null);
    setAnimFrames([]);
    setAnimTopic(null);
    setAnimFrameIdx(0);
  }

  // Animation: lazy-load using the existing visualizer endpoint. The student
  // can pick any phrase from the chat or type a fresh topic to animate.
  async function animateLastConcept() {
    // Default to the last user message as the topic.
    const last = [...history].reverse().find((t) => t.role === "user");
    const topicGuess = last?.content?.trim().slice(0, 200) || "this concept";
    setAnimTopic(topicGuess);
    setAnimLoading(true);
    setAnimFrames([]);
    setAnimFrameIdx(0);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return;
      const r = await fetch("/api/visualizer/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ topic: topicGuess }),
      });
      const j = await r.json();
      if (r.ok && Array.isArray(j.frames)) {
        setAnimFrames(j.frames);
        // Auto-advance frames (no controls in this compact view)
        let idx = 0;
        const cycle = () => {
          if (idx >= j.frames.length - 1) return;
          idx += 1;
          setAnimFrameIdx(idx);
          window.setTimeout(cycle, j.frames[idx]?.duration_ms || 3500);
        };
        window.setTimeout(cycle, j.frames[0]?.duration_ms || 3500);
      }
    } finally {
      setAnimLoading(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700">
          <ArrowLeft size={14} /> Back to dashboard
        </Link>
        <CurrentGoalChip />
      </div>

      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-violet-100 text-violet-700 p-3 shrink-0">
          <Mic size={22} />
        </div>
        <div className="flex-1">
          <h1 className="h1">Voice AI Teacher</h1>
          <p className="muted mt-1">
            Tap the mic, speak your doubt, hear the answer back. Hands-free study for the commute home, the
            walk to school, or right before bed. No app to install.
          </p>
        </div>
      </div>

      {unsupported && (
        <div className="card mt-4 bg-amber-50 border-amber-200 text-sm text-amber-900">
          <strong>Voice input isn&apos;t supported in this browser.</strong> Try Chrome or Edge on Android, or
          Safari on iPhone. You can still use the <Link href="/student/tutor" className="underline">text-based Tutor</Link>.
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4 mt-6">
        {/* CHAT COLUMN */}
        <div className="space-y-3">
          {/* Conversation */}
          <div ref={scrollRef} className="card h-[420px] overflow-y-auto p-4 space-y-3">
            {history.length === 0 && !interim ? (
              <div className="text-center py-12 muted text-sm">
                <Bot size={20} className="mx-auto text-violet-500 mb-2" />
                <p>Tap the mic and ask a question. Try things like:</p>
                <ul className="mt-2 text-xs space-y-1">
                  {samplePrompts.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <>
                {history.map((t, i) => (
                  <div key={i} className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[88%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap ${
                      t.role === "user"
                        ? "bg-emerald-600 text-white rounded-br-sm"
                        : "bg-slate-100 text-slate-900 rounded-bl-sm"
                    }`}>
                      {t.content}
                    </div>
                  </div>
                ))}
                {interim && (
                  <div className="flex justify-end">
                    <div className="max-w-[88%] rounded-2xl rounded-br-sm bg-emerald-600/40 text-white px-3.5 py-2 text-sm italic">
                      {interim}…
                    </div>
                  </div>
                )}
                {busy && (
                  <div className="flex justify-start">
                    <div className="bg-slate-100 text-slate-700 rounded-2xl rounded-bl-sm px-3.5 py-2 text-sm inline-flex items-center gap-2">
                      <Loader2 className="animate-spin" size={14} /> Thinking…
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {err && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>
          )}

          {/* Mic + voice-out controls */}
          <div className="card p-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <button
                type="button"
                onClick={listening ? stopListening : startListening}
                disabled={unsupported || busy}
                className={`btn ${listening ? "btn-danger" : "btn-primary"} text-base px-5 py-3`}
              >
                {listening ? <><MicOff size={18} /> Stop</> : <><Mic size={18} /> Tap to speak</>}
              </button>

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => setVoiceOut((v) => !v)}
                  className="btn btn-ghost"
                  title={voiceOut ? "AI voice on" : "AI voice off"}
                >
                  {voiceOut ? <Volume2 size={16} /> : <VolumeX size={16} />}
                  <span className="text-xs">{voiceOut ? "Voice on" : "Voice off"}</span>
                </button>
                {history.length > 0 && (
                  <button type="button" onClick={reset} className="btn btn-secondary">
                    <Trash2 size={14} /> Clear
                  </button>
                )}
              </div>
            </div>
            <p className="text-xs muted mt-2 text-center">
              Voice in &amp; voice out happen entirely in your browser — your microphone audio never leaves the device.
            </p>
          </div>
        </div>

        {/* ANIMATION COLUMN */}
        <div className="space-y-3">
          <div className="card">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-start gap-2">
                <Film size={18} className="text-fuchsia-700 mt-0.5 shrink-0" />
                <div>
                  <h2 className="font-semibold text-base">Animate this concept</h2>
                  <p className="text-xs muted mt-0.5">
                    See your last question turned into an animated, narrated explainer.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={animateLastConcept}
                disabled={animLoading || history.length === 0}
                className="btn btn-primary"
              >
                {animLoading ? <><Loader2 className="animate-spin" size={14} /> Animating…</> : <><Sparkles size={14} /> Animate</>}
              </button>
            </div>
          </div>

          {/* Same per-element animation trick as the Visualizer page. Re-mount
              the <style> on every frame change so keyframes restart cleanly. */}
          <style key={`vt-anim-${animFrameIdx}`}>{`
            .vt-active text { animation: vt-fade 700ms ease-out both; }
            .vt-active rect, .vt-active circle, .vt-active ellipse, .vt-active polygon, .vt-active polyline {
              animation: vt-pop 600ms cubic-bezier(.2,.9,.3,1.2) both;
            }
            .vt-active line, .vt-active path { animation: vt-draw 900ms ease-out both; }
            .vt-active text:nth-child(2n) { animation-delay: 80ms; }
            .vt-active text:nth-child(3n) { animation-delay: 160ms; }
            .vt-active rect:nth-child(2n) { animation-delay: 60ms; }
            .vt-active line:nth-child(2n) { animation-delay: 140ms; }
            .vt-active path:nth-child(2n) { animation-delay: 180ms; }
            @keyframes vt-fade { from { opacity: 0; } to { opacity: 1; } }
            @keyframes vt-pop  { from { opacity: 0; transform: scale(.85); transform-origin: center; } to { opacity: 1; transform: scale(1); } }
            @keyframes vt-draw { from { opacity: 0; stroke-dasharray: 1200; stroke-dashoffset: 1200; } to { opacity: 1; stroke-dasharray: 1200; stroke-dashoffset: 0; } }
          `}</style>
          <div className="card relative" style={{ aspectRatio: "5 / 3" }}>
            {animFrames.length === 0 ? (
              <div className="absolute inset-0 grid place-items-center text-center muted text-sm p-6">
                {animLoading ? "Drawing…" : "The animation will appear here once you tap Animate."}
              </div>
            ) : (
              <>
                {animFrames.map((f, i) => (
                  <div
                    key={i}
                    className={`absolute inset-0 transition-opacity duration-700 ${i === animFrameIdx ? "vt-active" : ""}`}
                    style={{ opacity: i === animFrameIdx ? 1 : 0, pointerEvents: i === animFrameIdx ? "auto" : "none" }}
                    aria-hidden={i !== animFrameIdx}
                    dangerouslySetInnerHTML={{ __html: wrapResponsiveSvg(f.svg) }}
                  />
                ))}
                <div className="absolute top-2 right-2 text-[10px] uppercase tracking-wide font-bold bg-slate-900/70 text-white rounded-full px-2 py-0.5">
                  {animFrameIdx + 1} / {animFrames.length}
                </div>
              </>
            )}
          </div>

          {animFrames.length > 0 && (
            <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-sm text-slate-800">
              {animFrames[animFrameIdx]?.caption || ""}
            </div>
          )}

          {animTopic && (
            <p className="text-xs muted">
              Animating: <strong>{animTopic}</strong>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// Sanitize FIRST then strip width/height. The SVG arrives from the LLM
// and is injected via dangerouslySetInnerHTML — it can carry <script>,
// event handlers, javascript: URLs etc. DOMPurify's SVG profile keeps
// visual elements (path/polygon/g/text) and drops everything else.
function wrapResponsiveSvg(svg: string): string {
  const safe = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "foreignObject"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
  });
  if (!safe.startsWith("<svg")) return safe;
  return safe.replace(/^<svg([^>]*)>/, (_m, attrs: string) => {
    const cleaned = String(attrs)
      .replace(/\swidth\s*=\s*"[^"]*"/gi, "")
      .replace(/\sheight\s*=\s*"[^"]*"/gi, "");
    return `<svg${cleaned} style="width:100%;height:100%;display:block">`;
  });
}
