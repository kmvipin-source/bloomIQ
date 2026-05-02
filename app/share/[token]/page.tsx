import { supabaseAdmin } from "@/lib/supabase/server";
import { BLOOM_LEVELS, BLOOM_META } from "@/lib/bloom";
import { notFound } from "next/navigation";
import Link from "next/link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // never cache — link state changes

/**
 * /share/[token]
 *
 * Public, no-auth-required, read-only progress page for a student's
 * parent / tutor / counsellor. Refuses to render if the token is invalid,
 * revoked, or expired.
 *
 * Lookup uses the service-role admin client (bypasses RLS) because the
 * viewer is anonymous. The route does its OWN validity check —
 * specifically: row exists, revoked_at IS NULL, expires_at > now().
 *
 * Security model:
 *   - Token is 36 chars (crypto.randomUUID()) — ~122 bits of entropy.
 *     Brute-forcing is computationally infeasible.
 *   - We don't index the page (noindex meta + robots.txt — site
 *     deployment level concern, set in next.config.ts headers).
 *   - We DON'T expose the student's email, phone, or any PII beyond
 *     name + Bloom mastery + recent test scores. That's the deliberate
 *     scope — anything more sensitive (per-question detail, AI tutor
 *     transcripts) requires a higher-scope token NOT YET implemented.
 */

type ShareRow = {
  id: string;
  token: string;
  user_id: string;
  scope: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
};

type Profile = {
  id: string;
  full_name: string | null;
  exam_goal: string | null;
};

type AttemptRow = {
  id: string;
  score: number;
  total: number;
  submitted_at: string | null;
  quiz: { name: string; code: string } | null;
};

type AnswerRow = {
  bloom_level: string;
  is_correct: boolean | null;
};

type BloomMastery = Record<string, { correct: number; total: number }>;

async function loadShare(token: string): Promise<{
  link: ShareRow;
  profile: Profile;
  attempts: AttemptRow[];
  mastery: BloomMastery;
} | null> {
  const admin = supabaseAdmin();

  // 1. Validate the share link.
  const { data: link } = await admin
    .from("student_share_links")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (!link) return null;
  if (link.revoked_at) return null;
  if (new Date(link.expires_at).getTime() < Date.now()) return null;

  // 2. Fetch the student's profile — name + goal only.
  const { data: profile } = await admin
    .from("profiles")
    .select("id, full_name, exam_goal")
    .eq("id", link.user_id)
    .maybeSingle();
  if (!profile) return null;

  // 3. Recent submitted attempts.
  const { data: attemptRows } = await admin
    .from("quiz_attempts")
    .select("id, score, total, submitted_at, quiz:quizzes(name, code)")
    .eq("student_id", link.user_id)
    .not("submitted_at", "is", null)
    .order("submitted_at", { ascending: false })
    .limit(10);
  const attempts = (attemptRows as unknown as AttemptRow[]) || [];

  // 4. Bloom mastery breakdown across all submitted attempts.
  const submittedIds = attempts.map((a) => a.id).filter(Boolean);
  let mastery: BloomMastery = {};
  if (submittedIds.length > 0) {
    const { data: ans } = await admin
      .from("attempt_answers")
      .select("bloom_level, is_correct")
      .in("attempt_id", submittedIds);
    for (const a of (ans as AnswerRow[] | null) || []) {
      if (!mastery[a.bloom_level]) mastery[a.bloom_level] = { correct: 0, total: 0 };
      mastery[a.bloom_level].total++;
      if (a.is_correct) mastery[a.bloom_level].correct++;
    }
  }

  return { link: link as ShareRow, profile: profile as Profile, attempts, mastery };
}

type PageProps = { params: Promise<{ token: string }> };

export default async function PublicSharePage({ params }: PageProps) {
  const { token } = await params;
  const data = await loadShare(token);
  if (!data) notFound();
  const { link, profile, attempts, mastery } = data;

  const studentName = profile.full_name || "Student";
  const completed = attempts.length;
  const avg =
    completed > 0
      ? Math.round(
          attempts.reduce((s, a) => s + (a.total ? (a.score / a.total) * 100 : 0), 0) / completed,
        )
      : 0;

  // Days until the link auto-expires — surfaced gently so the parent
  // knows this isn't a permanent URL and can ask the student to refresh
  // it if needed.
  const daysLeft = Math.max(
    0,
    Math.ceil((new Date(link.expires_at).getTime() - Date.now()) / 86400000),
  );

  return (
    <main className="min-h-screen px-6 py-10" style={{ background: "var(--color-bg, #f8fafc)" }}>
      <div className="max-w-3xl mx-auto">
        {/* Brand bar */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🌱</span>
            <span className="font-bold tracking-tight">BloomIQ</span>
            <span className="text-[10px] uppercase tracking-wider font-bold text-emerald-700 bg-emerald-100 rounded-full px-2 py-0.5">
              Read-only
            </span>
          </div>
          <Link href="/" className="text-xs text-emerald-700 hover:underline">
            What is BloomIQ?
          </Link>
        </div>

        <div className="card mb-4">
          <h1 className="text-2xl font-bold">{studentName}&apos;s progress</h1>
          <p className="muted text-sm mt-1">
            A read-only snapshot of {studentName.split(" ")[0]}&apos;s practice on BloomIQ.
            This link auto-expires in <strong>{daysLeft} day{daysLeft === 1 ? "" : "s"}</strong>.
            No sign-up needed.
          </p>
        </div>

        {/* Headline numbers */}
        <div className="grid sm:grid-cols-3 gap-3 mb-4">
          <div className="card">
            <div className="text-xs muted uppercase font-semibold">Tests taken</div>
            <div className="text-3xl font-bold">{completed}</div>
          </div>
          <div className="card">
            <div className="text-xs muted uppercase font-semibold">Average score</div>
            <div className="text-3xl font-bold">{completed > 0 ? `${avg}%` : "—"}</div>
          </div>
          <div className="card">
            <div className="text-xs muted uppercase font-semibold">Studying for</div>
            <div className="text-base font-semibold mt-1">
              {profile.exam_goal ? profile.exam_goal.replace(/_/g, " ") : "—"}
            </div>
          </div>
        </div>

        {/* Bloom mastery — the headline visualisation */}
        {Object.keys(mastery).length > 0 ? (
          <div className="card mb-4">
            <h2 className="font-semibold mb-1">Thinking-level breakdown</h2>
            <p className="text-xs muted mb-3">
              BloomIQ tags every question by Bloom&apos;s Taxonomy — six levels of
              cognitive depth, from simple recall to creative synthesis.
            </p>
            <div className="space-y-2">
              {BLOOM_LEVELS.map((l) => {
                const data = mastery[l];
                if (!data || !data.total) return null;
                const p = Math.round((data.correct / data.total) * 100);
                return (
                  <div key={l}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="font-medium">{BLOOM_META[l].label}</span>
                      <span className="muted">
                        {data.correct} of {data.total} · {p}%
                      </span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full transition-all"
                        style={{ width: `${p}%`, backgroundColor: BLOOM_META[l].color }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="card mb-4 text-center muted text-sm py-8">
            No completed tests yet — check back once {studentName.split(" ")[0]} has practiced a few.
          </div>
        )}

        {/* Recent tests */}
        {attempts.length > 0 && (
          <div className="card">
            <h2 className="font-semibold mb-2">Recent tests</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase muted">
                  <tr>
                    <th className="text-left py-2">Test</th>
                    <th className="text-left py-2">Score</th>
                    <th className="text-left py-2">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {attempts.slice(0, 5).map((a) => (
                    <tr key={a.id}>
                      <td className="py-2">{a.quiz?.name || "Test"}</td>
                      <td className="py-2 font-semibold">
                        {a.score}/{a.total}{" "}
                        {a.total > 0 && (
                          <span className="muted">
                            ({Math.round((a.score / a.total) * 100)}%)
                          </span>
                        )}
                      </td>
                      <td className="py-2 muted">
                        {a.submitted_at ? new Date(a.submitted_at).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Footer — light context for the recipient */}
        <div className="text-xs muted text-center mt-6 leading-relaxed">
          Shared by {studentName} via BloomIQ. This page is private (link-only)
          and never indexed by search engines.{" "}
          <Link href="/" className="text-emerald-700 hover:underline">
            Learn more about BloomIQ →
          </Link>
        </div>
      </div>
    </main>
  );
}
