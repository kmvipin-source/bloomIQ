"use client";

/**
 * lib/featureFlags.client.tsx
 *
 * Browser-side mirror of lib/featureFlags.ts. Server is the source of
 * truth; the client fetches a single bundle of public-readable flag
 * values from /api/flags/public and exposes them through a context
 * provider, a hook, and a `<FlagGate>` convenience component.
 *
 * Usage (the simple cases — this is what "easy to activate / deactivate"
 * means in practice):
 *
 *   // In a page or component:
 *   import { FlagGate, usePlatformFlag } from "@/lib/featureFlags.client";
 *
 *   <FlagGate flag="school_marketing_visible"
 *             fallback={<SchoolWaitlistCard />}>
 *     <SchoolPricingTier />
 *   </FlagGate>
 *
 *   // Or as a hook:
 *   const { enabled, loading } = usePlatformFlag("school_signup_enabled");
 *   if (loading) return <Spinner />;
 *   if (!enabled) return <SchoolWaitlistRedirect />;
 *
 * The provider is mounted at the root layout so any component can call
 * the hook without prop-drilling.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

// Keep this list in sync with FLAG_REGISTRY in lib/featureFlags.ts. Listed
// twice on purpose: the server file imports nothing from React, and the
// client file imports nothing from supabase-js. Duplication is small (one
// union type) and worth the clean boundary.
export type PlatformFlagName =
  | "school_marketing_visible"
  | "school_signup_enabled"
  | "independent_signup_enabled";

type FlagState = {
  values: Record<string, boolean>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const FlagContext = createContext<FlagState | null>(null);

/**
 * Wrap the app root in this so the hook works everywhere. Fetches
 * /api/flags/public once on mount; consumers can call refresh() if they
 * just toggled a flag in an admin UI and want to see the new value
 * without a hard reload.
 */
export function PlatformFlagProvider({ children }: { children: ReactNode }) {
  const [values, setValues] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFlags = useMemo(
    () => async () => {
      // F14 fix: a single retry after 1s on network failure. Without
      // this, an unlucky first-load blip leaves the flag bundle empty
      // until the user manually reloads (the provider lives in root
      // layout and never re-mounts on client navigation).
      async function attempt(): Promise<Record<string, boolean>> {
        const res = await fetch("/api/flags/public", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        return (json.flags || {}) as Record<string, boolean>;
      }
      try {
        setLoading(true);
        setError(null);
        let next: Record<string, boolean>;
        try {
          next = await attempt();
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
          next = await attempt();
        }
        setValues(next);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "unknown");
        // Leave the previous values in place so the UI doesn't flap.
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void fetchFlags();

    // F1 fix: refetch on auth state change so per-user / per-school
    // overrides take effect immediately after the user signs in or out
    // (otherwise the bundle fetched at anon mount would be stuck until
    // a full page reload). TOKEN_REFRESHED is included so a long-lived
    // session that just rotated also picks up any overrides added on
    // a different device in the meantime. PASSWORD_RECOVERY and
    // USER_UPDATED don't change auth identity for flag purposes, so we
    // skip those.
    let unsub: (() => void) | null = null;
    try {
      const sb = supabaseBrowser();
      const { data } = sb.auth.onAuthStateChange((event) => {
        if (
          event === "SIGNED_IN" ||
          event === "SIGNED_OUT" ||
          event === "TOKEN_REFRESHED"
        ) {
          void fetchFlags();
        }
      });
      unsub = () => data.subscription.unsubscribe();
    } catch {
      // Supabase client unavailable (e.g. during SSR sanity check) —
      // initial fetch already happened, nothing else to wire.
    }
    return () => {
      if (unsub) unsub();
    };
  }, [fetchFlags]);

  const state: FlagState = useMemo(
    () => ({ values, loading, error, refresh: fetchFlags }),
    [values, loading, error, fetchFlags]
  );

  return <FlagContext.Provider value={state}>{children}</FlagContext.Provider>;
}

/**
 * Read one flag. While the initial fetch is in flight, `enabled` is
 * `null` (NOT false) so callers can render a skeleton instead of
 * flashing the off-state. If you want a hard boolean answer ASAP, pass
 * a fallback via the second argument.
 */
export function usePlatformFlag(
  flag: PlatformFlagName,
  fallbackWhileLoading: boolean | null = null
): { enabled: boolean | null; loading: boolean; refresh: () => Promise<void> } {
  const ctx = useContext(FlagContext);
  if (!ctx) {
    // Provider not mounted — fail-safe: report loading=false and the
    // fallback so a misconfigured tree doesn't deadlock. We log loudly.
    if (typeof window !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn(
        "[featureFlags.client] usePlatformFlag called outside <PlatformFlagProvider>. " +
          "Returning fallback. Wrap your app root with the provider."
      );
    }
    return {
      enabled: fallbackWhileLoading,
      loading: false,
      refresh: async () => {},
    };
  }
  const present = Object.prototype.hasOwnProperty.call(ctx.values, flag);
  return {
    enabled: ctx.loading && !present ? fallbackWhileLoading : !!ctx.values[flag],
    loading: ctx.loading,
    refresh: ctx.refresh,
  };
}

/**
 * Declarative gate. Renders `children` if the flag is enabled, else
 * `fallback`. While the initial fetch is in flight, renders nothing
 * (or `loadingFallback` if provided) so an "off" flash never appears.
 *
 * Pass `invert` to gate on "flag is OFF" instead — useful for waitlist
 * banners that should only appear when a feature is disabled.
 *
 * F18 note: when `loadingFallback` is null (the default) AND the flag
 * has never been seen by the client, callers see literally nothing for
 * the initial fetch window (~200ms). On above-the-fold CTAs that's a
 * brief blank flash. Pass an explicit skeleton via `loadingFallback`
 * for critical layout slots.
 */
export function FlagGate({
  flag,
  children,
  fallback = null,
  loadingFallback = null,
  invert = false,
}: {
  flag: PlatformFlagName;
  // Finding #39 fix (B+): duplicate `children: ReactNode;` field (typo).
  children: ReactNode;
  fallback?: ReactNode;
  loadingFallback?: ReactNode;
  invert?: boolean;
}) {
  const { enabled, loading } = usePlatformFlag(flag);
  if (loading && enabled === null) return <>{loadingFallback}</>;
  const showChildren = invert ? !enabled : !!enabled;
  return <>{showChildren ? children : fallback}</>;
}
