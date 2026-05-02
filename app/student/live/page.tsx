"use client";

import LiveJoinCard from "@/components/LiveJoinCard";
import { Radio } from "lucide-react";

/**
 * /student/live — sidebar destination for "Live class quiz".
 *
 * The school student's sidebar links here so the join affordance is
 * one click away from anywhere, not buried in the dashboard. The
 * page is intentionally minimal: a header that explains the flow
 * and the LiveJoinCard for code entry.
 *
 * Important behaviour invariant (don't break this):
 *   Live quiz answers are written to live_session_answers /
 *   live_session_players ONLY. They never touch quiz_attempts or
 *   attempt_answers, which means they never roll up into the class
 *   quiz stats, BloomHero, /student/progress, or any school admin
 *   report. Live quizzes are engagement-only by construction; the
 *   table separation guarantees it.
 */
export default function StudentLiveLandingPage() {
  return (
    <div className="max-w-3xl mx-auto fade-in">
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-gradient-to-br from-fuchsia-500 to-rose-500 text-white p-2 shrink-0">
          <Radio size={22} />
        </div>
        <div>
          <h1 className="h1">Live class quiz</h1>
          <p className="muted text-sm mt-1">
            Your teacher will give you a 6-character code on screen or out loud.
            Type it below to join the live session.
          </p>
        </div>
      </div>

      <LiveJoinCard />

      <div className="mt-6 card text-xs muted leading-relaxed">
        <strong className="text-slate-700">Note:</strong> Live class quizzes are for
        engagement only. Your live score, leaderboard rank, and answers are kept separate
        from your class quiz record — they don&apos;t affect your class average, Bloom
        mastery, or anything your teacher reviews as your official progress.
      </div>
    </div>
  );
}
