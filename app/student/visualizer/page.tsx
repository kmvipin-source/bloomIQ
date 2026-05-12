"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { supabaseBrowser } from "@/lib/supabase/client";
import katex from "katex";
import "katex/dist/katex.min.css";
import {
  Film, Sparkles, ArrowLeft, Loader2, Play, Pause,
  ChevronLeft, ChevronRight, History, RotateCcw,
} from "lucide-react";
import { type LearnerProfile } from "@/components/LearnerProfilePrompt";
import { suggestedTopics, placeholderTopic } from "@/lib/topicSuggestions";

// =============================================================================
// Concept Visualizer — data-driven, motion-powered renderer.
// -----------------------------------------------------------------------------
// The API now returns frames with TYPED elements (circle/rect/line/path/...)
// so Motion can interpolate between frames using shared layoutIds. Older rows
// in concept_animations are SVG-string-based — we still render those via
// dangerouslySetInnerHTML for back-compat.
// =============================================================================

type ElType =
  | "circle" | "rect" | "ellipse" | "line" | "path" | "polygon" | "text" | "group";

type Element = {
  id: string;
  type: ElType;
  cx?: number; cy?: number; r?: number; rx?: number; ry?: number;
  x?: number; y?: number; width?: number; height?: number;
  x1?: number; y1?: number; x2?: number; y2?: number;
  d?: string; points?: string; text?: string;
  // Optional KaTeX source — when present on a `text` element the renderer
  // typesets it as proper math (fractions, integrals, vectors) inside a
  // <foreignObject>. Plain `text` is the fallback if KaTeX errors.
  latex?: string;
  fill?: string; stroke?: string; strokeWidth?: number; strokeDasharray?: string;
  opacity?: number; rotate?: number;
  fontSize?: number; fontWeight?: string;
  transform?: string;
  children?: Element[];
  shadow?: boolean;
  glow?: boolean;
  emphasize?: boolean;
  animate?: "spin" | "bob" | "drift" | "flash" | "wiggle" | "flow" | "orbit";
};

type Frame = {
  // New typed shape
  elements?: Element[];
  step_label?: string;
  caption: string;
  duration_ms: number;
  // Legacy shape (rows created before migration to typed elements)
  svg?: string;
};

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

const SPRING = { type: "spring", stiffness: 120, damping: 18, mass: 0.7 } as const;

// Resolve a fill/stroke string. Accepts plain color OR "color1->color2"
// gradient syntax. Returns the SVG paint reference + an optional def fragment
// to insert into <defs>.
function resolvePaint(
  raw: string | undefined,
  refKey: string,
): { paint: string | undefined; defs: { id: string; from: string; to: string } | null } {
  if (!raw) return { paint: undefined, defs: null };
  if (raw.includes("->")) {
    const [from, to] = raw.split("->").map((s) => s.trim());
    if (from && to) {
      const id = `vz-grad-${refKey}`;
      return { paint: `url(#${id})`, defs: { id, from, to } };
    }
  }
  return { paint: raw, defs: null };
}

const PULSE_ANIMATE = {
  scale: [1, 1.07, 1],
  opacity: [1, 0.92, 1],
};
const PULSE_TRANSITION = { duration: 1.6, repeat: Infinity, ease: "easeInOut" as const };

// Per-frame ambient motion presets. Each returns a (animate, transition)
// pair that loops while the frame is on screen.
function presetMotion(name: NonNullable<Element["animate"]>): {
  animate: Record<string, number[]>;
  transition: { duration: number; repeat: typeof Infinity; ease: "easeInOut" | "linear" };
} {
  switch (name) {
    case "spin":
      return { animate: { rotate: [0, 360] }, transition: { duration: 6, repeat: Infinity, ease: "linear" } };
    case "bob":
      return { animate: { y: [0, -8, 0] }, transition: { duration: 1.8, repeat: Infinity, ease: "easeInOut" } };
    case "drift":
      return { animate: { x: [0, 12, 0, -12, 0] }, transition: { duration: 5, repeat: Infinity, ease: "easeInOut" } };
    case "flash":
      return { animate: { opacity: [1, 0.4, 1] }, transition: { duration: 1.2, repeat: Infinity, ease: "easeInOut" } };
    case "wiggle":
      return { animate: { rotate: [-3, 3, -3] }, transition: { duration: 0.6, repeat: Infinity, ease: "easeInOut" } };
    case "flow":
      return { animate: { strokeDashoffset: [0, -32] }, transition: { duration: 1.5, repeat: Infinity, ease: "linear" } };
    case "orbit":
      return {
        animate: { x: [0, 8, 0, -8, 0], y: [0, -8, 0, 8, 0] },
        transition: { duration: 4, repeat: Infinity, ease: "linear" },
      };
  }
}

// -----------------------------------------------------------------------------
// Element renderer — emits a single motion SVG node for one element. Shared
// layoutId across frames is what lets shapes tween between keyframes.
// -----------------------------------------------------------------------------
function ElementNode({
  el,
  frameKey,
  registerDef,
}: {
  el: Element;
  frameKey: string;
  registerDef: (def: { id: string; from: string; to: string }) => void;
}) {
  const fillRef = resolvePaint(el.fill, frameKey + "-" + el.id + "-f");
  const strokeRef = resolvePaint(el.stroke, frameKey + "-" + el.id + "-s");
  if (fillRef.defs) registerDef(fillRef.defs);
  if (strokeRef.defs) registerDef(strokeRef.defs);

  // Origin for rotate / pulse. SVG transform-origin must be set in pixel units.
  const origin = `${el.cx ?? el.x ?? 400}px ${el.cy ?? el.y ?? 240}px`;

  const filters: string[] = [];
  if (el.shadow) filters.push("url(#vz-shadow)");
  if (el.glow) filters.push("url(#vz-glow)");
  const filterAttr = filters.length ? filters.join(" ") : undefined;

  // Build the loop animation. Emphasize wins (it's the focal pulse), else
  // the per-element preset, else no loop and we just use the layout SPRING.
  let loopAnimate: Record<string, number[]> | undefined;
  let loopTransition: object | undefined;
  if (el.emphasize) {
    loopAnimate = PULSE_ANIMATE;
    loopTransition = PULSE_TRANSITION;
  } else if (el.animate) {
    const m = presetMotion(el.animate);
    loopAnimate = m.animate;
    loopTransition = m.transition;
    // "flow" requires a stroke-dasharray to be visible; supply a sensible
    // default if the AI didn't.
    if (el.animate === "flow" && !el.strokeDasharray) {
      // mutate a copy via the spread below — no real mutation here
    }
  }

  const common = {
    fill: fillRef.paint ?? "none",
    stroke: strokeRef.paint,
    strokeWidth: el.strokeWidth,
    strokeDasharray:
      el.strokeDasharray ?? (el.animate === "flow" ? "8 6" : undefined),
    opacity: el.opacity ?? 1,
    filter: filterAttr,
    style: { transformOrigin: origin, transformBox: "fill-box" as const },
    animate: loopAnimate,
    transition: loopTransition ?? SPRING,
  };

  const layoutKey = el.id;
  const transform = el.rotate
    ? `rotate(${el.rotate} ${el.cx ?? el.x ?? 400} ${el.cy ?? el.y ?? 240})`
    : el.transform;

  switch (el.type) {
    case "circle":
      return (
        <motion.circle
          layoutId={layoutKey}
          key={frameKey + ":" + layoutKey}
          cx={el.cx ?? 0}
          cy={el.cy ?? 0}
          r={el.r ?? 8}
          {...common}
        />
      );
    case "rect":
      return (
        <motion.rect
          layoutId={layoutKey}
          key={frameKey + ":" + layoutKey}
          x={el.x ?? 0}
          y={el.y ?? 0}
          width={el.width ?? 0}
          height={el.height ?? 0}
          rx={el.rx}
          ry={el.ry}
          {...common}
        />
      );
    case "ellipse":
      return (
        <motion.ellipse
          layoutId={layoutKey}
          key={frameKey + ":" + layoutKey}
          cx={el.cx ?? 0}
          cy={el.cy ?? 0}
          rx={el.rx ?? 0}
          ry={el.ry ?? 0}
          {...common}
        />
      );
    case "line":
      return (
        <motion.line
          layoutId={layoutKey}
          key={frameKey + ":" + layoutKey}
          x1={el.x1 ?? 0}
          y1={el.y1 ?? 0}
          x2={el.x2 ?? 0}
          y2={el.y2 ?? 0}
          {...common}
        />
      );
    case "path":
      return (
        <motion.path
          layoutId={layoutKey}
          key={frameKey + ":" + layoutKey}
          d={el.d || ""}
          {...common}
        />
      );
    case "polygon":
      return (
        <motion.polygon
          layoutId={layoutKey}
          key={frameKey + ":" + layoutKey}
          points={el.points || ""}
          {...common}
        />
      );
    case "text": {
      // LaTeX path: render KaTeX HTML inside a <foreignObject>. We catch
      // KaTeX parse errors so a malformed equation falls back to plain
      // text rather than crashing the frame. Width/height of the foreign
      // viewport is overlarge intentionally — KaTeX measures itself.
      if (el.latex) {
        let html = "";
        try {
          html = katex.renderToString(el.latex, {
            displayMode: false,
            throwOnError: false,
            output: "html",
          });
        } catch {
          html = "";
        }
        if (html) {
          const fontSize = el.fontSize ?? 16;
          // foreignObject anchors at top-left; shift so x,y reads as the
          // baseline-ish anchor SVG <text> would have used.
          const fox = (el.x ?? 0) - 4;
          const foy = (el.y ?? 0) - fontSize - 4;
          return (
            <motion.foreignObject
              layoutId={layoutKey}
              key={frameKey + ":" + layoutKey}
              x={fox}
              y={foy}
              width={400}
              height={fontSize * 3}
              opacity={el.opacity ?? 1}
              filter={filterAttr}
              style={{ transformOrigin: origin, transformBox: "fill-box" as const, overflow: "visible" }}
              animate={el.emphasize ? PULSE_ANIMATE : undefined}
              transition={el.emphasize ? PULSE_TRANSITION : SPRING}
            >
              <div
                style={{
                  fontSize: `${fontSize}px`,
                  fontWeight: el.fontWeight ?? "600",
                  color: fillRef.paint ?? "#0f172a",
                  display: "inline-block",
                  whiteSpace: "nowrap",
                  lineHeight: 1.1,
                }}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </motion.foreignObject>
          );
        }
      }
      return (
        <motion.text
          layoutId={layoutKey}
          key={frameKey + ":" + layoutKey}
          x={el.x ?? 0}
          y={el.y ?? 0}
          fontSize={el.fontSize ?? 14}
          fontWeight={el.fontWeight ?? "600"}
          fill={fillRef.paint ?? "#0f172a"}
          opacity={el.opacity ?? 1}
          filter={filterAttr}
          style={{ transformOrigin: origin, transformBox: "fill-box" as const, paintOrder: "stroke" }}
          stroke={strokeRef.paint}
          strokeWidth={el.strokeWidth ?? (el.stroke ? 3 : 0)}
          animate={el.emphasize ? PULSE_ANIMATE : undefined}
          transition={el.emphasize ? PULSE_TRANSITION : SPRING}
        >
          {el.text}
        </motion.text>
      );
    }
    case "group":
      return (
        <motion.g
          layoutId={layoutKey}
          key={frameKey + ":" + layoutKey}
          transform={transform}
          opacity={el.opacity ?? 1}
          transition={SPRING}
        >
          {(el.children || []).map((c) => (
            <ElementNode key={c.id} el={c} frameKey={frameKey + "/" + el.id} registerDef={registerDef} />
          ))}
        </motion.g>
      );
  }
}

function FrameRenderer({ frame, idx }: { frame: Frame; idx: number }) {
  // Legacy SVG-string path — render as before.
  if (!frame.elements && frame.svg) {
    return (
      <div
        className="absolute inset-0"
        dangerouslySetInnerHTML={{ __html: stripSizeAttrs(frame.svg) }}
      />
    );
  }

  const els = frame.elements || [];

  // Walk all elements (incl. group children) and collect any auto-gradient
  // defs they want; render them once at the top of <defs>.
  const gradDefs = new Map<string, { from: string; to: string }>();
  function collect(arr: Element[], prefix: string) {
    for (const el of arr) {
      const fillR = resolvePaint(el.fill, prefix + "-" + el.id + "-f");
      const strR  = resolvePaint(el.stroke, prefix + "-" + el.id + "-s");
      if (fillR.defs) gradDefs.set(fillR.defs.id, { from: fillR.defs.from, to: fillR.defs.to });
      if (strR.defs) gradDefs.set(strR.defs.id, { from: strR.defs.from, to: strR.defs.to });
      if (el.type === "group" && el.children) collect(el.children, prefix + "/" + el.id);
    }
  }
  collect(els, String(idx));

  // No-op def collector for ElementNode (defs already collected above and
  // rendered in <defs>; ElementNode only needs to know how to reference them).
  const noopRegister = () => {};

  return (
    <motion.svg
      key={`frame-${idx}`}
      viewBox="0 0 800 480"
      className="absolute inset-0"
      style={{ width: "100%", height: "100%", display: "block" }}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        {/* Page background — soft vertical wash plus a faint dot grid for depth. */}
        <linearGradient id="vz-bg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#fdf4ff" />
          <stop offset="1" stopColor="#f1f5f9" />
        </linearGradient>
        <pattern id="vz-grid" x="0" y="0" width="40" height="40" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="#cbd5e1" opacity="0.45" />
        </pattern>

        {/* Drop shadow + outer glow for elements that opt in. */}
        <filter id="vz-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="3" />
          <feOffset dx="0" dy="2" result="off" />
          <feComponentTransfer><feFuncA type="linear" slope="0.35" /></feComponentTransfer>
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="vz-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* Auto-gradient defs collected from elements. */}
        {[...gradDefs.entries()].map(([id, g]) => (
          <linearGradient key={id} id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={g.from} />
            <stop offset="1" stopColor={g.to} />
          </linearGradient>
        ))}
      </defs>

      {/* Background layers */}
      <rect x="0" y="0" width="800" height="480" fill="url(#vz-bg)" />
      <rect x="0" y="0" width="800" height="480" fill="url(#vz-grid)" />

      <AnimatePresence mode="sync">
        {els.map((el) => (
          <ElementNode
            key={el.id}
            el={el}
            frameKey={String(idx)}
            registerDef={noopRegister}
          />
        ))}
      </AnimatePresence>
    </motion.svg>
  );
}

function stripSizeAttrs(svg: string): string {
  if (!svg.startsWith("<svg")) return svg;
  return svg.replace(/^<svg([^>]*)>/, (_m, attrs: string) => {
    const cleaned = String(attrs)
      .replace(/\swidth\s*=\s*"[^"]*"/gi, "")
      .replace(/\sheight\s*=\s*"[^"]*"/gi, "");
    return `<svg${cleaned} style="width:100%;height:100%;display:block">`;
  });
}

// -----------------------------------------------------------------------------
// Page component
// -----------------------------------------------------------------------------
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

  // ---- Learner-profile-aware copy (silent — no UI on this page) ---
  // The same Concept Visualizer is used by school students (k12),
  // competitive-exam aspirants, and corporate trainees. We do NOT
  // show a picker here — that already lives on /student/generate
  // ("Take a test") and /settings/profile. We just READ the value
  // silently and tune the SUGGESTED examples in the heading +
  // placeholder, and the soft hint sent to the AI prompt.
  // A class-9 student sees "biology cycles, electric circuits";
  // a Java trainee sees "HashMap collisions, OAuth flow".
  // Default (and fallback) is "k12" — same content the page has
  // always shown to school students.
  const [learnerProfile, setLearnerProfile] = useState<LearnerProfile | null>(null);
  // Pull granular exam_goal alongside learner_profile so CAT vs JEE vs
  // NEET disambiguate cleanly. Earlier code locked the competitive_exam
  // bucket to JEE/NEET examples, which read wrong for CAT / UPSC / Bank
  // exam aspirants. Vipin 2026-05-12.
  const [examGoal, setExamGoal] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        const { data } = await sb
          .from("profiles")
          .select("learner_profile, exam_goal")
          .eq("id", user.id)
          .single();
        const row = data as { learner_profile?: string; exam_goal?: string | null } | null;
        const v = row?.learner_profile;
        if (v === "k12" || v === "competitive_exam" || v === "corporate") {
          setLearnerProfile(v);
        } else {
          setLearnerProfile("k12");
        }
        if (row?.exam_goal) setExamGoal(row.exam_goal);
      } catch {
        setLearnerProfile("k12");
      }
    })();
  }, []);

  // Heading examples + topic placeholder both now route through the
  // goal-aware helper in lib/topicSuggestions.ts so a CAT student sees
  // CAT-style examples (not JEE/NEET), a JEE student sees JEE examples,
  // etc. The user can change goal from the persistent chip in the
  // header any time.
  function headingExamples(): string {
    const tops = suggestedTopics(examGoal, learnerProfile).slice(0, 4);
    return tops.join(", ");
  }
  function topicPlaceholder(): string {
    return placeholderTopic(examGoal, learnerProfile);
  }

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
        // Pass the learner profile through. The server uses it as a soft
        // hint when interpreting ambiguous topics — e.g. "stack" should
        // mean the data structure for a corporate trainee, but a
        // hardware/CS-curriculum stack diagram for a school student
        // taking a programming basics module.
        body: JSON.stringify({ topic: topic.trim(), learner_profile: learnerProfile || undefined }),
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

  const frame = animation?.frames[frameIdx];
  const stepLabel =
    frame?.step_label ||
    (animation ? `Step ${frameIdx + 1} of ${animation.frames.length}` : "");

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
            Type any concept and watch it animated step by step. Best for the things that don&apos;t click from words alone — {headingExamples()}.
          </p>
        </div>
      </div>

      <div className="card mt-6">
        <label className="label">What do you want explained?</label>
        <input
          className="input"
          placeholder={topicPlaceholder()}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          maxLength={200}
        />
        {err && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>
        )}
        <button type="button" className="btn btn-primary mt-3" onClick={generate} disabled={busy}>
          {busy ? <><Loader2 className="animate-spin" size={16} /> Animating...</> : <><Sparkles size={16} /> Animate it</>}
        </button>
      </div>

      {animation && animation.frames.length > 0 && frame && (
        <div className="card mt-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-xs uppercase tracking-wide font-semibold text-fuchsia-700">Now playing</div>
              <h2 className="font-bold text-lg mt-0.5">{animation.title}</h2>
            </div>
            <span className="text-xs font-semibold rounded-full bg-fuchsia-50 text-fuchsia-800 border border-fuchsia-200 px-2.5 py-1">
              {stepLabel}
            </span>
          </div>

          <div
            className="relative mt-3 rounded-lg border border-slate-200 bg-white overflow-hidden"
            style={{ aspectRatio: "5 / 3" }}
          >
            <FrameRenderer frame={frame} idx={frameIdx} />

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
            {frame.caption || ""}
          </div>

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <button type="button" className="btn btn-secondary" onClick={prev} disabled={frameIdx === 0}>
              <ChevronLeft size={14} /> Previous
            </button>
            <button type="button" className="btn btn-primary" onClick={togglePlay}>
              {playing ? <><Pause size={14} /> Pause</> : <><Play size={14} /> Play</>}
            </button>
            <button type="button" className="btn btn-secondary" onClick={next} disabled={frameIdx >= animation.frames.length - 1}>
              Next <ChevronRight size={14} />
            </button>
            <button type="button" className="btn btn-ghost" onClick={restart}>
              <RotateCcw size={14} /> Restart
            </button>
          </div>

          {/* Step thumbnails — quick jump */}
          <div className="mt-3 grid grid-cols-5 gap-1.5">
            {animation.frames.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => { setPlaying(false); setFrameIdx(i); }}
                className="text-[10px] font-semibold rounded-md py-1.5 px-1 transition border"
                style={{
                  borderColor: i === frameIdx ? "#a21caf" : "#e2e8f0",
                  background: i === frameIdx ? "#fdf4ff" : "transparent",
                  color: i === frameIdx ? "#86198f" : "#475569",
                }}
              >
                {i + 1}
              </button>
            ))}
          </div>

          {animation.summary && (
            <div className="mt-4">
              <div className="text-xs uppercase tracking-wide font-semibold text-slate-500 mb-1">Key idea</div>
              <p className="text-sm text-slate-700">{animation.summary}</p>
            </div>
          )}
        </div>
      )}

      <h2 className="h2 mt-10 mb-3 flex items-center gap-2">
        <History size={18} /> Recent animations
      </h2>
      {history.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">No animations yet — try one above.</div>
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
