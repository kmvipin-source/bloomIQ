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
  _client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        lock: processLock,
      },
    }
  );
  return _client;
}
