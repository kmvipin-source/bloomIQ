/**
 * lib/theme.ts
 *
 * Theme system constants + helpers shared between server and client.
 * The actual React provider lives in components/ThemeProvider.tsx, but
 * the constants and the inline pre-hydration script generator are kept
 * here so they can be referenced from layout.tsx without pulling in
 * React.
 *
 * 5 themes × 2 modes. The DOM contract is:
 *   <html data-theme="emerald" data-mode="light">
 * which is set:
 *   1. Initially via the inline script in <head> (read from localStorage),
 *      so the page paints with the right palette and we avoid a flash of
 *      unthemed content.
 *   2. On every change via the React provider, which also writes back to
 *      localStorage and (for logged-in users) the profiles table.
 */

export type ThemeName = "emerald" | "indigo" | "rose" | "amber" | "slate";
export type ColorMode = "light" | "dark";

export const THEME_NAMES: ThemeName[] = ["emerald", "indigo", "rose", "amber", "slate"];

/**
 * Display metadata for the theme picker UI. The `swatch` color is what
 * gets rendered as the small dot in the sidebar quick-toggle and as the
 * accent stripe on the /settings/appearance preview cards.
 */
export const THEME_META: Record<
  ThemeName,
  { label: string; description: string; swatch: string; tagline: string }
> = {
  emerald: {
    label: "Emerald",
    description: "Fresh, calm, growth",
    tagline: "The default — calm green that says 'learning happens here'.",
    swatch: "#10b981",
  },
  indigo: {
    label: "Indigo",
    description: "Focused, scholarly",
    tagline: "Cool indigo — feels like a quiet library at night.",
    swatch: "#6366f1",
  },
  rose: {
    label: "Rose",
    description: "Warm, encouraging",
    tagline: "Warm rose — friendly and motivating without being childish.",
    swatch: "#f43f5e",
  },
  amber: {
    label: "Amber",
    description: "Energetic, optimistic",
    tagline: "Golden hour — energetic and optimistic, great for morning study.",
    swatch: "#f59e0b",
  },
  slate: {
    label: "Slate",
    description: "Minimal, premium",
    tagline: "Monochrome slate — minimal and serious, like a premium tool.",
    swatch: "#475569",
  },
};

export const DEFAULT_THEME: ThemeName = "emerald";
export const DEFAULT_MODE: ColorMode = "light";

export const STORAGE_KEY_THEME = "bloomiq.theme";
export const STORAGE_KEY_MODE = "bloomiq.mode";

export function isThemeName(x: unknown): x is ThemeName {
  return typeof x === "string" && (THEME_NAMES as string[]).includes(x);
}
export function isColorMode(x: unknown): x is ColorMode {
  return x === "light" || x === "dark";
}

/**
 * The inline script we drop into <head>. It runs synchronously before
 * React hydrates so the initial paint already has the user's palette.
 * Keep it tiny and dependency-free — anything that throws here means a
 * blank page.
 *
 * Resolution order:
 *   1. localStorage values (set by the React provider on every change)
 *   2. defaults (DEFAULT_THEME = emerald, DEFAULT_MODE = light)
 *
 * NOTE — we deliberately do NOT auto-pick dark from
 * `prefers-color-scheme: dark`. Most users never explicitly picked dark
 * mode in their OS — they just inherited it — so respecting system pref
 * by default surprises them with a dark BloomIQ they didn't choose. We
 * default to light and require an explicit click on the toggle to go
 * dark. Users who actually want "follow system" can be given a toggle
 * for that later as an opt-in option on /settings/appearance.
 */
export const THEME_INIT_SCRIPT = `
(function(){
  try {
    var t = localStorage.getItem("${STORAGE_KEY_THEME}");
    var m = localStorage.getItem("${STORAGE_KEY_MODE}");
    var validThemes = ${JSON.stringify(THEME_NAMES)};
    if (validThemes.indexOf(t) === -1) t = "${DEFAULT_THEME}";
    if (m !== "light" && m !== "dark") m = "${DEFAULT_MODE}";
    var html = document.documentElement;
    html.setAttribute("data-theme", t);
    html.setAttribute("data-mode", m);
    html.style.colorScheme = m;
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "${DEFAULT_THEME}");
    document.documentElement.setAttribute("data-mode", "${DEFAULT_MODE}");
  }
})();
`.trim();
