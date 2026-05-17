import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: false,
  devIndicators: false,
  // Finding #25 CLOSED (2026-05-17 QA sweep, Round 6). All 33 production
  // bugs surfaced by flipping this to false in rounds 1-6 are now fixed:
  // 4 SyntaxErrors (duplicate const auth, corrupted lib files), 12
  // ReferenceErrors (user/token/requireAuthenticated/teacherClasses
  // undefined), 3 file-corruption truncations (groq, bloomVerifier,
  // schools-coming-soon), 10 recharts Formatter signature drifts, an
  // H3-codemod damage repair in /teacher/quizzes/new, plus cross-field
  // validation tightening for /teacher/generate, payments, auth, and
  // the Razorpay webhook. The build-time TS check is now an invariant
  // and pairs with tsconfig.check.json strict:true for CI-time checks.
  //
  // If you ever need to ship a hot fix that has a TS error, use a
  // targeted `// @ts-expect-error <reason>` line — never globally
  // disable build-time type-checking.
  typescript: { ignoreBuildErrors: false },
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
