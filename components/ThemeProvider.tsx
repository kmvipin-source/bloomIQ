"use client";

/**
 * components/ThemeProvider.tsx
 *
 * React context provider that owns the active theme + color mode.
 *
 * Source of truth ordering:
 *   1. The inline pre-hydration script in <head> sets data-theme +
 *      data-mode on <html> from localStorage. That's what the user sees
 *      first paint.
 *   2. This provider mounts, reads the same localStorage, and reflects
 *      it into React state so child components can call useTheme() and
 *      re-render when it changes.
 *   3. setTheme / setMode update both <html> attributes AND localStorage
 *      atomically.
 *   4. Optional: when a logged-in user changes a setting, the
 *      /settings/appearance page (or the sidebar quick-toggle) also
 *      writes the choice to profiles.theme / profiles.color_mode so it
 *      follows the user across devices. That side-effect lives at the
 *      callsite, not here, to keep the provider sync-only.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_MODE,
  DEFAULT_THEME,
  STORAGE_KEY_MODE,
  STORAGE_KEY_THEME,
  THEME_NAMES,
  isColorMode,
  isThemeName,
  type ColorMode,
  type ThemeName,
} from "@/lib/theme";

type Ctx = {
  theme: ThemeName;
  mode: ColorMode;
  setTheme: (t: ThemeName) => void;
  setMode: (m: ColorMode) => void;
  toggleMode: () => void;
};

const ThemeContext = createContext<Ctx | null>(null);

function readInitial(): { theme: ThemeName; mode: ColorMode } {
  if (typeof window === "undefined") {
    return { theme: DEFAULT_THEME, mode: DEFAULT_MODE };
  }
  // Prefer the value already on <html> (set by the inline init script)
  // because that's what's actually rendered. localStorage is the
  // fallback for cases where the script didn't run for some reason.
  const html = document.documentElement;
  const tAttr = html.getAttribute("data-theme");
  const mAttr = html.getAttribute("data-mode");
  const tStored = localStorage.getItem(STORAGE_KEY_THEME);
  const mStored = localStorage.getItem(STORAGE_KEY_MODE);
  const theme: ThemeName =
    isThemeName(tAttr) ? tAttr :
    isThemeName(tStored) ? tStored : DEFAULT_THEME;
  const mode: ColorMode =
    isColorMode(mAttr) ? mAttr :
    isColorMode(mStored) ? mStored : DEFAULT_MODE;
  return { theme, mode };
}

function applyToDOM(theme: ThemeName, mode: ColorMode) {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  html.setAttribute("data-theme", theme);
  html.setAttribute("data-mode", mode);
  // colorScheme tells the browser to render native form widgets,
  // scrollbars, etc. in the matching mode. Without this, dark themes
  // still show light-mode scrollbars on Chrome/Edge.
  html.style.colorScheme = mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(DEFAULT_THEME);
  const [mode, setModeState] = useState<ColorMode>(DEFAULT_MODE);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from DOM/localStorage on first client render.
  useEffect(() => {
    const { theme: t, mode: m } = readInitial();
    setThemeState(t);
    setModeState(m);
    setHydrated(true);
  }, []);

  // Listen for storage events so theme changes in another tab propagate.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY_THEME && isThemeName(e.newValue)) {
        setThemeState(e.newValue);
        applyToDOM(e.newValue, mode);
      }
      if (e.key === STORAGE_KEY_MODE && isColorMode(e.newValue)) {
        setModeState(e.newValue);
        applyToDOM(theme, e.newValue);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [theme, mode]);

  const setTheme = useCallback((t: ThemeName) => {
    if (!THEME_NAMES.includes(t)) return;
    setThemeState(t);
    applyToDOM(t, mode);
    try { localStorage.setItem(STORAGE_KEY_THEME, t); } catch { /* private mode */ }
  }, [mode]);

  const setMode = useCallback((m: ColorMode) => {
    if (m !== "light" && m !== "dark") return;
    setModeState(m);
    applyToDOM(theme, m);
    try { localStorage.setItem(STORAGE_KEY_MODE, m); } catch { /* private mode */ }
  }, [theme]);

  const toggleMode = useCallback(() => {
    setMode(mode === "light" ? "dark" : "light");
  }, [mode, setMode]);

  // While not hydrated we still render children — the DOM already has
  // the right attributes from the inline script, so nothing flashes.
  // We just don't trigger React re-renders that depend on theme until
  // we've synced state with the DOM.
  void hydrated;

  return (
    <ThemeContext.Provider value={{ theme, mode, setTheme, setMode, toggleMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): Ctx {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Render-tree-level fallback for components used outside the
    // provider (e.g., during a Storybook story or a test) — no-op
    // setters, defaults for read.
    return {
      theme: DEFAULT_THEME,
      mode: DEFAULT_MODE,
      setTheme: () => {},
      setMode: () => {},
      toggleMode: () => {},
    };
  }
  return ctx;
}
