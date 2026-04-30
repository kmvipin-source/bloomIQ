"use client";

/**
 * components/ThemeQuickToggle.tsx
 *
 * Compact appearance switcher meant for the bottom of the sidebar.
 *
 * Layout:
 *   [● ● ● ● ●]   [☀/🌙]   ⚙
 *    swatches      mode    settings link
 *
 * Each swatch is a clickable dot in the theme's brand color. Clicking
 * applies the theme instantly. Long-press / hover reveals the theme name.
 * The mode button toggles light/dark. The gear icon links to the full
 * /settings/appearance page for a richer preview.
 *
 * Persistence to the user's profile is fire-and-forget — we don't block
 * the UI on the network. The /settings/appearance page does the same
 * write but shows a "Saving…" hint; here we want it to feel instant.
 */

import Link from "next/link";
import { Sun, Moon, Settings as SettingsIcon } from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";
import { THEME_META, THEME_NAMES, type ThemeName } from "@/lib/theme";
import { supabaseBrowser } from "@/lib/supabase/client";

async function persistInBackground(theme: ThemeName, mode: "light" | "dark") {
  // Best-effort write to profiles. Doesn't block UI; failures are
  // silent — localStorage already captured the choice.
  try {
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    await sb
      .from("profiles")
      .update({ theme, color_mode: mode })
      .eq("id", user.id);
  } catch {
    /* best-effort */
  }
}

export default function ThemeQuickToggle() {
  const { theme, mode, setTheme, toggleMode } = useTheme();

  function pick(t: ThemeName) {
    setTheme(t);
    void persistInBackground(t, mode);
  }
  function flip() {
    const next = mode === "light" ? "dark" : "light";
    toggleMode();
    void persistInBackground(theme, next);
  }

  return (
    <div
      className="rounded-xl p-2.5 mb-2"
      style={{
        background: "var(--color-bg-soft)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        {/* Theme swatches */}
        <div className="flex items-center gap-1.5">
          {THEME_NAMES.map((t) => {
            const active = t === theme;
            return (
              <button
                key={t}
                type="button"
                onClick={() => pick(t)}
                title={THEME_META[t].label}
                aria-label={`Switch to ${THEME_META[t].label} theme`}
                className="relative rounded-full transition-transform hover:scale-110"
                style={{
                  width: active ? 22 : 18,
                  height: active ? 22 : 18,
                  background: THEME_META[t].swatch,
                  boxShadow: active
                    ? `0 0 0 2px var(--color-card), 0 0 0 4px ${THEME_META[t].swatch}`
                    : "0 0 0 1.5px var(--color-card)",
                }}
              />
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 mt-2">
        <button
          type="button"
          onClick={flip}
          aria-label={mode === "light" ? "Switch to dark mode" : "Switch to light mode"}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold transition"
          style={{
            background: "var(--color-card)",
            color: "var(--color-fg-soft)",
            border: "1px solid var(--color-border)",
          }}
          title={mode === "light" ? "Switch to dark" : "Switch to light"}
        >
          {mode === "light" ? <Moon size={13} /> : <Sun size={13} />}
          {mode === "light" ? "Dark" : "Light"}
        </button>
        <Link
          href="/settings/appearance"
          aria-label="Open appearance settings"
          title="Appearance settings"
          className="rounded-lg p-1.5 transition"
          style={{
            background: "var(--color-card)",
            color: "var(--color-fg-soft)",
            border: "1px solid var(--color-border)",
          }}
        >
          <SettingsIcon size={13} />
        </Link>
      </div>
    </div>
  );
}
