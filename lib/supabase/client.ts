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
  return _client;
}
