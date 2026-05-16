"use client";

/**
 * /settings/appearance
 *
 * Visual theme picker. Lets the user:
 *   - toggle between Light and Dark mode
 *   - pick one of 5 curated themes (Emerald, Indigo, Rose, Amber, Slate)
 *   - see a live preview that re-renders with their selection
 *
 * Persistence model:
 *   - localStorage is updated instantly on every click via ThemeProvider
 *     (so the choice survives a refresh even when not signed in).
 *   - For signed-in users, we ALSO write profiles.theme + profiles.color_mode
 *     so the choice follows them across devices. The reconcile-on-load is
 *     handled here too: if the DB row says X but localStorage says Y, we
 *     trust the DB (the user's most recent intentional choice across all
 *     their devices) and update localStorage to match.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sun, Moon, Check, Sparkles, ArrowLeft, Palette } from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";
import {
  THEME_META,
  THEME_NAMES,
  type ColorMode,
  type ThemeName,
} from "@/lib/theme";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function AppearancePage() {
  const { theme, mode, setTheme, setMode } = useTheme();
  const [savingHint, setSavingHint] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  // Reconcile on mount: if signed in and the DB has a different value,
  // pull that into local state. This makes "I changed it on my laptop;
  // open phone, it's already that theme" work.
  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) { setSignedIn(false); return; }
      setSignedIn(true);
      const { data } = await sb
        .from("profiles")
        .select("theme, color_mode")
        .eq("id", user.id)
        .maybeSingle();
      if (data) {
        const dbTheme = data.theme as ThemeName | undefined;
        const dbMode = data.color_mode as ColorMode | undefined;
        if (dbTheme && THEME_NAMES.includes(dbTheme) && dbTheme !== theme) {
          setTheme(dbTheme);
        }
        if ((dbMode === "light" || dbMode === "dark") && dbMode !== mode) {
          setMode(dbMode);
        }
      }
    })();
    // intentionally only on mount — local state changes shouldn't re-trigger
    // a DB pull
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist any change to the DB for signed-in users. localStorage was
  // already updated by ThemeProvider — this is the cross-device leg.
  async function persistToProfile(nextTheme: ThemeName, nextMode: ColorMode) {
    if (!signedIn) return;
    setSavingHint("Saving…");
    try {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      await sb
        .from("profiles")
        .update({ theme: nextTheme, color_mode: nextMode })
        .eq("id", user.id);
      setSavingHint("Saved");
      setTimeout(() => setSavingHint(null), 1200);
    } catch {
      setSavingHint("Saved on this device");
      setTimeout(() => setSavingHint(null), 1500);
    }
  }

  function pickTheme(t: ThemeName) {
    setTheme(t);
    void persistToProfile(t, mode);
  }
  function pickMode(m: ColorMode) {
    setMode(m);
    void persistToProfile(theme, m);
  }

  return (
    <div className="min-h-screen bg-hero">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10">
        {/* Top bar — back link + page title */}
        <div className="flex items-center justify-between mb-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm muted hover:text-[var(--color-fg)] transition"
          >
            <ArrowLeft size={16} /> Back
          </Link>
          {savingHint && (
            <div className="text-xs muted fade-in">{savingHint}</div>
          )}
        </div>

        <div className="flex items-center gap-3 mb-2">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{
              background: "var(--gradient-cta)",
              boxShadow: "var(--shadow-brand)",
            }}
          >
            <Palette size={20} className="text-white" />
          </div>
          <div>
            <h1 className="h1">Appearance</h1>
            <p className="muted text-sm">
              Make ZCORIQ look the way you like. Changes apply instantly.
            </p>
          </div>
        </div>

        {/* MODE TOGGLE */}
        <section className="mt-10">
          <h2 className="h3 mb-3">Color mode</h2>
          <div className="grid grid-cols-2 gap-3 max-w-md">
            <ModeCard
              active={mode === "light"}
              onClick={() => pickMode("light")}
              icon={<Sun size={18} />}
              label="Light"
              hint="Bright surfaces"
            />
            <ModeCard
              active={mode === "dark"}
              onClick={() => pickMode("dark")}
              icon={<Moon size={18} />}
              label="Dark"
              hint="Easy on the eyes"
            />
          </div>
        </section>

        {/* THEME GRID */}
        <section className="mt-10">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="h3">Theme</h2>
            <div className="text-xs muted">5 curated palettes</div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {THEME_NAMES.map((t) => (
              <ThemeCard
                key={t}
                name={t}
                active={theme === t}
                onClick={() => pickTheme(t)}
              />
            ))}
          </div>
        </section>

        {/* LIVE PREVIEW */}
        <section className="mt-12">
          <h2 className="h3 mb-3">Preview</h2>
          <LivePreview />
        </section>

        <p className="text-xs muted mt-10">
          Your choice is saved to this browser{signedIn ? " and your account" : ""}.
          {signedIn ? " It will follow you across devices once you sign in there." : ""}
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ModeCard({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card card-hover text-left flex items-center gap-3 p-4 relative"
      style={
        active
          ? { borderColor: "var(--brand-500)", boxShadow: "var(--shadow-brand)" }
          : undefined
      }
    >
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center"
        style={{
          background: active ? "var(--gradient-cta)" : "var(--color-bg-soft)",
          color: active ? "#fff" : "var(--color-fg-soft)",
        }}
      >
        {icon}
      </div>
      <div className="flex-1">
        <div className="font-semibold">{label}</div>
        <div className="text-xs muted">{hint}</div>
      </div>
      {active && (
        <Check size={18} style={{ color: "var(--brand-600)" }} />
      )}
    </button>
  );
}

function ThemeCard({
  name,
  active,
  onClick,
}: {
  name: ThemeName;
  active: boolean;
  onClick: () => void;
}) {
  const meta = THEME_META[name];
  return (
    <button
      type="button"
      onClick={onClick}
      data-theme={name}
      className="card card-hover card-feature text-left p-0 overflow-hidden relative"
      style={
        active
          ? { borderColor: "var(--brand-500)", boxShadow: "var(--shadow-brand)" }
          : undefined
      }
    >
      {/* Color stripe — uses var(--brand-500) which is rebound by data-theme */}
      <div
        className="h-20 w-full relative"
        style={{ background: "var(--gradient-cta)" }}
      >
        <div className="absolute inset-0 opacity-30" style={{ background: "var(--gradient-hero)" }} />
        <div className="absolute bottom-3 left-4 right-4 flex items-center gap-2">
          <SwatchDot color="var(--brand-700)" />
          <SwatchDot color="var(--brand-500)" />
          <SwatchDot color="var(--brand-300)" />
          <SwatchDot color="var(--brand-100)" />
        </div>
        {active && (
          <div
            className="absolute top-3 right-3 w-6 h-6 rounded-full flex items-center justify-center"
            style={{ background: "#fff", color: "var(--brand-700)" }}
          >
            <Check size={14} strokeWidth={3} />
          </div>
        )}
      </div>
      <div className="p-4">
        <div className="flex items-center justify-between">
          <div className="font-semibold">{meta.label}</div>
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider muted font-bold">
            <Sparkles size={10} /> Preview
          </div>
        </div>
        <div className="text-xs muted mt-1">{meta.tagline}</div>
      </div>
    </button>
  );
}

function SwatchDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block w-4 h-4 rounded-full ring-2"
      style={{ background: color, boxShadow: "0 0 0 2px rgba(255,255,255,.6)" }}
    />
  );
}

/**
 * Mini preview that renders a few signature surfaces (button, card,
 * badge, hero strip) using the active theme. Helps the user judge the
 * choice before they go look at the real dashboard.
 */
function LivePreview() {
  return (
    <div className="card overflow-hidden p-0">
      <div
        className="px-6 py-8 relative"
        style={{ background: "var(--gradient-hero), var(--color-bg-soft)" }}
      >
        <div className="text-xs uppercase tracking-wider font-bold muted mb-2">
          Sample dashboard
        </div>
        <div className="text-2xl font-bold mb-1" style={{ color: "var(--color-fg)" }}>
          Welcome back, <span className="text-gradient-brand">Vipin</span>
        </div>
        <div className="text-sm muted">
          Your Apply level on Polynomials is at 68% — up 12 points this week.
        </div>
        <div className="flex items-center gap-2 mt-4">
          <button type="button" className="btn btn-primary">Start practice</button>
          <button type="button" className="btn btn-secondary">View report</button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 p-4 border-t" style={{ borderColor: "var(--color-border)" }}>
        <MiniTile label="Remember" pct={92} badge="badge-remember" />
        <MiniTile label="Apply"    pct={68} badge="badge-apply" />
        <MiniTile label="Analyze"  pct={41} badge="badge-analyze" />
      </div>
    </div>
  );
}

function MiniTile({ label, pct, badge }: { label: string; pct: number; badge: string }) {
  return (
    <div className="card-soft rounded-lg p-3 border" style={{ borderColor: "var(--color-border)" }}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold" style={{ color: "var(--color-fg-soft)" }}>{label}</div>
        <span className={`badge ${badge}`}>{label}</span>
      </div>
      <div className="text-xl font-bold" style={{ color: "var(--color-fg)" }}>{pct}%</div>
      <div className="h-1.5 w-full rounded-full mt-2" style={{ background: "var(--color-bg-soft)" }}>
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: "var(--gradient-cta)" }}
        />
      </div>
    </div>
  );
}
