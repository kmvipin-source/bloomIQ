"use client";

import { useEffect } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

/**
 * Runs once on app boot. If localStorage has a stale Supabase session whose
 * refresh token is no longer valid (typical after a database wipe, a manual
 * delete of the auth.users row, or a long-expired session), Supabase throws
 * "Refresh Token Not Found" / "Invalid Refresh Token" on the next auth call —
 * which can break pages that haven't done anything wrong.
 *
 * This component does a single getSession() call and, if it surfaces a stale
 * token error, signs out cleanly so localStorage is cleared and pages can
 * proceed normally. Silent in the happy path.
 */
export default function AuthHealer() {
  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      try {
        const { error } = await sb.auth.getSession();
        if (error && /refresh token/i.test(error.message)) {
          await sb.auth.signOut().catch(() => {});
        }
      } catch (e) {
        // Defensive: any boot-time auth error → clean signout
        const msg = e instanceof Error ? e.message : String(e);
        if (/refresh token|jwt|expired|not found/i.test(msg)) {
          try { await sb.auth.signOut(); } catch { /* ignore */ }
        }
      }

      // Also catch any later background-refresh errors thrown by the client
      sb.auth.onAuthStateChange((event) => {
        if (event === "TOKEN_REFRESHED" || event === "SIGNED_OUT") {
          // Healthy events — nothing to do
        }
      });
    })();
  }, []);
  return null;
}
