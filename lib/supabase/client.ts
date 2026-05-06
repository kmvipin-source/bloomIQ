"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

// In-process serial mutex used in place of @supabase/auth-js's
// navigatorLock. Why: under React Strict Mode (dev) + multiple layouts
// calling sb.auth.getUser() back-to-back, the navigator-lock implementation
// throws a noisy "Lock '...' was released because another request stole it"
// error that surfaces in Next.js's dev overlay. It's harmless (the inner
// promise still resolves) but it scares everyone the first time. Using a
// simple per-tab promise chain avoids cross-task races without any of the
// cross-tab coordination quirks. Cross-tab token refresh is rarely needed
// in this app — each tab has its own session and refresh cycle.
let _authQueue: Promise<unknown> = Promise.resolve();
function processLock<R>(_name: string, _acquireTimeout: number, fn: () => Promise<R>): Promise<R> {
  const next = _authQueue.then(() => fn(), () => fn());
  // Keep the chain alive but don't let a rejection break the queue.
  _authQueue = next.catch(() => undefined);
  return next;
}

export function supabaseBrowser(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // NEXT_PUBLIC_* vars are inlined at BUILD time. If they're missing
  // here in production, the Vercel project doesn't have them under the
  // Production scope (or was built before they were added). Surface a
  // clear, actionable error instead of supabase-js's cryptic
  // "supabaseUrl is required" stack trace.
  if (!url || !anon) {
    const missing = [!url && "NEXT_PUBLIC_SUPABASE_URL", !anon && "NEXT_PUBLIC_SUPABASE_ANON_KEY"]
      .filter(Boolean)
      .join(", ");
    const msg =
      `BloomIQ build is missing ${missing}. ` +
      `Set these in Vercel → Settings → Environment Variables (Production scope), then redeploy with cache disabled.`;
    if (typeof window !== "undefined") {
      // eslint-disable-next-line no-console
      console.error("[supabaseBrowser]", msg);
    }
    throw new Error(msg);
  }

  _client = createClient(url, anon, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      lock: processLock,
    },
  });

  // Graceful sign-out / refresh-failure handling.
  // -----------------------------------------------------------------------
  // Supabase emits "SIGNED_OUT" when:
  //   - the user explicitly signs out
  //   - another device signed in (single-session policy revokes refresh
  //     tokens on the current tab via signOut({ scope: "others" }))
  //   - the refresh token expired or was invalidated server-side
  //
  // Without this listener, the user sees a console error
  // ("Invalid Refresh Token: Refresh Token Not Found") and a half-broken
  // page that can't load any authenticated data. With the listener we
  // route them cleanly back to /login with a reason banner the existing
  // /login page already understands.
  //
  // We intentionally skip the redirect on public surfaces (/, /login,
  // /signup, /staff, /pricing, /terms, /privacy, /auth) so signed-out
  // visitors browsing those pages don't get bounced to the login page
  // repeatedly.
  if (typeof window !== "undefined") {
    _client.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_OUT") return;
      const path = window.location.pathname;
      const publicPaths = ["/", "/login", "/signup", "/staff", "/pricing", "/terms", "/privacy", "/auth"];
      if (publicPaths.some((p) => path === p || path.startsWith(p + "/"))) return;
      // ?reason=elsewhere is already handled by the /login page banner —
      // it shows "Your session was signed out because this account signed
      // in on another device." That covers the dominant cause; for
      // expired-token cases the same banner is reasonable enough.
      window.location.href = "/login?reason=elsewhere&next=" + encodeURIComponent(path);
    });
  }

  return _client;
}
