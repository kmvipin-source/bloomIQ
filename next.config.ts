import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: false,
  devIndicators: false,
  // 2026-05-17 QA sweep partial closure: the meta-cause of every critical
  // bug in rounds 1-5 was this flag set to true silently swallowing all TS
  // errors at build time. We tried flipping it off — and uncovered ~25 more
  // pre-existing errors (recharts Formatter signature drift, a botched H3
  // script in /teacher/quizzes/new, recharts in /school/reports + /student/
  // progress + BloomChart + EngagementTrends, plus a PlanDiff type clash).
  // Those need their own incremental cleanup before this flag can go off
  // permanently. Until then:
  //   1) tsconfig.check.json is strict:true (the audit invariant). Run
  //      `tsc --noEmit -p tsconfig.check.json` in CI to gate new merges.
  //   2) This stays true so production deploys aren't blocked on legacy
  //      debt during the cleanup.
  // Track the remaining error list in COMMIT_MSG_TODAY.txt under "Round 6".
  typescript: { ignoreBuildErrors: true },
  // Sidebar labels say "Tests" and "Exam Papers" but the actual route
  // segments are /teacher/quizzes and /teacher/papers. Until the labels
  // are normalised, redirect the natural-guess URLs so docs / muscle
  // memory don't 404. Same idea for /me on the teacher side: there's
  // no canonical /me yet, but /settings/profile is the right page.
  async redirects() {
    return [
      { source: "/teacher/tests",      destination: "/teacher/quizzes", permanent: false },
      { source: "/teacher/exam-papers", destination: "/teacher/papers", permanent: false },
      { source: "/teacher/profile",    destination: "/settings/profile", permanent: false },
      { source: "/me",                  destination: "/settings/profile", permanent: false },
    ];
  },
};

export default nextConfig;
