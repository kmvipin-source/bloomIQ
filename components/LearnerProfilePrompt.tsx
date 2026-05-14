"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { GraduationCap, Trophy, Briefcase } from "lucide-react";

/**
 * LearnerProfilePrompt — inline learning-context picker on the generate
 * pages (teacher + student). Two display states:
 *
 *   1. UNANSWERED — silent default (learner_profile === 'k12' AND the
 *      user has never explicitly picked here). Shows a soft welcome
 *      card asking "Quick question — what are you here to learn?" with
 *      three rich option cards.
 *
 *   2. ANSWERED — once the user has picked any value (or even just
 *      seen this prompt before, captured via a localStorage flag).
 *      Compact chip row stays visible at the top of the page so the
 *      user can switch context any time without leaving the page.
 *      Current selection highlighted in emerald.
 *
 * Why both modes: the unanswered state is welcoming and explanatory.
 * The answered state is unobtrusive but always available — modern
 * apps (Linear's project switcher, Slack's workspace switcher, ChatGPT's
 * model picker) all keep context-switchers persistent rather than
 * one-shot. Hiding the picker after first pick is hostile UX.
 *
 * Three values:
 *   k12              — default for everyone
 *   competitive_exam — auto-set elsewhere when a student picks an exam goal
 *   corporate        — software / mainframe / cloud / professional
 *
 * Calling convention:
 *
 *   <LearnerProfilePrompt onChange={(v) => setProfile(v)} />
 *
 * onChange fires both on initial fetch and on every user-driven switch,
 * so the parent can swap intent chips / skill detectors immediately.
 */

export type LearnerProfile = "k12" | "competitive_exam" | "corporate";

// User-namespaced key. The previous single shared key meant that on a
// shared device, the first student dismissing the prompt suppressed it
// for everyone after them. We now key by uid so each user sees the
// rich-mode prompt once. The "bloomiq:" prefix matches the wipe-on-
// logout sweep in Sidebar.tsx / MobileNav.tsx.
function storageKey(uid: string): string {
  return `bloomiq:learner-profile-prompt-seen:${uid}`;
}

type Props = {
  /** Notified whenever the user picks a value (including initial fetch). */
  onChange?: (profile: LearnerProfile) => void;
};

const PROFILE_META: Record<LearnerProfile, {
  label: string;
  hint: string;
  icon: React.ReactNode;
}> = {
  k12: {
    label: "K-12 / school",
    hint: "Photosynthesis, quadratics, history…",
    icon: <GraduationCap size={16} />,
  },
  competitive_exam: {
    label: "Competitive exam",
    hint: "CAT, JEE, NEET, GRE, GATE…",
    icon: <Trophy size={16} />,
  },
  corporate: {
    label: "Professional / training",
    hint: "Java, AWS, mainframe, certifications…",
    icon: <Briefcase size={16} />,
  },
};

export default function LearnerProfilePrompt({ onChange }: Props) {
  const [currentProfile, setCurrentProfile] = useState<LearnerProfile | null>(null);
  const [saving, setSaving] = useState<LearnerProfile | null>(null);
  // The "rich" mode = first time we're showing this surface to the user.
  // Once they interact (pick anything OR even just reload after seeing it
  // in rich mode), we collapse to compact mode permanently.
  const [richMode, setRichMode] = useState<boolean>(false);

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;

      let prevSeen = false;
      if (typeof window !== "undefined") {
        try {
          prevSeen = localStorage.getItem(storageKey(user.id)) === "1";
        } catch { /* ignore */ }
      }

      try {
        const { data, error } = await sb
          .from("profiles")
          .select("learner_profile")
          .eq("id", user.id)
          .single();
        if (error) throw error;
        const v = (data as { learner_profile?: string })?.learner_profile as LearnerProfile | undefined;
        const resolved = (v === "k12" || v === "competitive_exam" || v === "corporate") ? v : "k12";
        setCurrentProfile(resolved);
        onChange?.(resolved);

        // Rich mode only when the user hasn't explicitly picked yet
        // (still on default 'k12') AND we've never shown them this
        // surface before. Otherwise compact mode.
        const showRich = resolved === "k12" && !prevSeen;
        setRichMode(showRich);
        // Mark as seen the moment we render anything — so if they
        // reload, they get compact mode next time even if they didn't
        // pick anything.
        if (typeof window !== "undefined") {
          try { localStorage.setItem(storageKey(user.id), "1"); } catch { /* ignore */ }
        }
      } catch {
        setCurrentProfile("k12");
        onChange?.("k12");
        setRichMode(!prevSeen);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pick(profile: LearnerProfile) {
    if (saving || profile === currentProfile) {
      // Even no-op picks should collapse rich mode to compact.
      if (richMode) setRichMode(false);
      return;
    }
    setSaving(profile);
    try {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { error } = await sb
        .from("profiles")
        .update({ learner_profile: profile })
        .eq("id", user.id);
      if (error) throw error;
      setCurrentProfile(profile);
      onChange?.(profile);
      setRichMode(false);
    } catch {
      // Silent failure — page still works on local state.
    } finally {
      setSaving(null);
    }
  }

  if (currentProfile === null) return null;

  // ---------- Rich mode (first-time welcome) ---------------------------
  if (richMode) {
    return (
      <div className="card mt-5 border-emerald-200 bg-emerald-50/30">
        <div className="text-sm font-semibold text-slate-900">
          Quick question — what are you here to learn?
        </div>
        <div className="text-xs muted mt-0.5">
          We&apos;ll tune the suggestions below. You can change this anytime
          here or in{" "}
          <Link href="/settings/profile" className="text-emerald-700 font-semibold hover:underline">
            your profile
          </Link>
          .
        </div>

        <div className="grid sm:grid-cols-3 gap-2 mt-3">
          {(Object.keys(PROFILE_META) as LearnerProfile[]).map((k) => {
            const meta = PROFILE_META[k];
            const on = k === currentProfile;
            return (
              <button
                key={k}
                type="button"
                onClick={() => pick(k)}
                disabled={!!saving}
                className={`text-left p-3 rounded-lg border transition disabled:opacity-50 ${
                  on
                    ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200"
                    : "border-slate-200 bg-white hover:bg-slate-50 hover:border-emerald-400"
                }`}
              >
                <div className="flex items-center gap-1.5 font-semibold text-sm">
                  <span className={on ? "text-emerald-700" : "text-emerald-700"}>
                    {meta.icon}
                  </span>
                  {meta.label}
                </div>
                <div className="text-xs muted mt-0.5">{meta.hint}</div>
                {saving === k && <div className="text-[10px] muted mt-1">Saving…</div>}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ---------- Compact mode (persistent chip row) -----------------------
  // Stays visible at the top of the page after any first interaction.
  // Lets the user switch context without navigating to settings.
  return (
    <div className="mt-5 flex items-center gap-2 flex-wrap text-xs">
      <span className="muted shrink-0">Learning context:</span>
      {(Object.keys(PROFILE_META) as LearnerProfile[]).map((k) => {
        const meta = PROFILE_META[k];
        const on = k === currentProfile;
        return (
          <button
            key={k}
            type="button"
            onClick={() => pick(k)}
            disabled={!!saving}
            title={meta.hint}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-semibold transition disabled:opacity-50 ${
              on
                ? "border-emerald-700 bg-emerald-600 text-white shadow-sm ring-1 ring-emerald-700/40"
                : "border-slate-300 text-slate-600 bg-white hover:bg-slate-50 font-medium"
            }`}
            aria-pressed={on}
          >
            <span className={on ? "text-white" : "text-slate-500"}>{meta.icon}</span>
            {meta.label}
            {saving === k && <span className={`text-[10px] ml-0.5 ${on ? "text-white/80" : "muted"}`}>…</span>}
          </button>
        );
      })}
      <span className="muted shrink-0 ml-1">
        — change anytime
      </span>
    </div>
  );
}
