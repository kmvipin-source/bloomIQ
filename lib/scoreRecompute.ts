"use client";

// Best-effort fire-and-forget BloomIQ score recompute. Called from every
// client surface that ends an attempt (quiz / drill / speed / sprint /
// live) so the score badge and Future You reflect the latest activity.
//
// Recompute is a backend op:
//   - Returns 409 for students who haven't calibrated yet (silently
//     ignored — first-run flow drives them to calibration separately).
//   - Re-reads recent attempt_answers via service role on the server, so
//     there's no race with the just-written quiz_attempts row as long as
//     it has landed before this fires.
//
// Always wrapped in try/catch so a failure here cannot block the user's
// happy-path navigation (toast + router.push after submit).

import { supabaseBrowser } from "@/lib/supabase/client";

export type RecomputeTrigger = "quiz" | "drill" | "manual" | "recompute";

export async function triggerScoreRecompute(
  trigger: RecomputeTrigger,
  sourceId: string | null
): Promise<void> {
  try {
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    await fetch("/api/student/score/recompute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ trigger_event: trigger, source_id: sourceId }),
    });
  } catch {
    // Swallow: this should never break the post-submit UX.
  }
}
