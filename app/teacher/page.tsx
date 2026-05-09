"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Sparkles, Library, ListChecks, Users, Building2, ArrowRight, ClipboardCheck, Radio, Calendar } from "lucide-react";
import TeacherRetakeRequests from "@/components/TeacherRetakeRequests";
import TeacherInvites from "@/components/TeacherInvites";
import CurrentPlanBadge from "@/components/CurrentPlanBadge";

/**
 * Friendly first name. Profiles often store full names like "Ms. Smith"
 * or "Dr. Aditi Rao Hydari" - naively taking the first whitespace token
 * gives "Ms." / "Dr." which reads bizarrely in the greeting. Strip a
 * leading salutation if present and use the next meaningful token.
 */
function friendlyFirstName(fullName: string): string {
  if (!fullName) return "";
  const tokens = fullName.trim().split(/\s+/);
  const SALUTATIONS = new Set([
    "mr", "mrs", "ms", "miss", "mx",
    "dr", "prof", "sir", "madam", "sri", "smt",
  ]);
  for (const t of tokens) {
    const stripped = t.replace(/\.$/, "").toLowerCase();
    if (SALUTATIONS.has(stripped)) continue;
    return t;
  }
  return tokens[0] || "";
}

type RecentQuiz = {
  id: string;
  name: string;
  code: string;
  subject: string | null;
  questionCount: number;
  attemptCount: number;
  lastAttemptAt: string | null;
  assignedByName: string | null; // null when not assigned anywhere I can see
  assignedByMe: boolean;
  // Live hosting requires quiz ownership (the live picker + API filter
  // by owner_id). On a co-teacher's view this is false for tests
  // assigned to their class but owned by another teacher; we hide the
  // "Host live" button in that case so it isn't a dead-end click.
  ownedByMe: boolean;
};

export default function TeacherHome() {
  const [stats, setStats] = useState({ pending: 0, approved: 0, quizzes: 0, attempts: 0, retakePending: 0 });
  const [recent, setRecent] = useState<RecentQuiz[]>([]);
  const [name, setName] = useState("");
  const [schoolId, setSchoolId] = useState<string | null>(null);
  // Guards the "Join your school" card from flashing during the
  // initial profile fetch. Without this, every navigation back to /teacher
  // briefly renders the join-school branch (because schoolId starts as
  // null) before /api/auth/me resolves and the dashboard hydrates.
  // Same pattern Defect 7 used on /teacher/analytics.
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinErr, setJoinErr] = useState<string | null>(null);
  const [joinInfo, setJoinInfo] = useState<string | null>(null);

  async function loadProfile() {
    const sb = supabaseBrowser();
    // Service-role lookup — reading profiles via the user-token client races
    // RLS on the edge and produces a flicker of empty name / "join a school"
    // state before the dashboard hydrates.
    const { data: { session } } = await sb.auth.getSession();
    const token = session?.access_token;
    if (!token) return null;
    const r = await fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!r.ok) {
      setProfileLoaded(true);
      return null;
    }
    const me = await r.json() as { uid: string; email: string | null; full_name: string | null; school_id: string | null };
    setName(me.full_name || "");
    setSchoolId(me.school_id);
    setProfileLoaded(true);
    return { id: me.uid, email: me.email };
  }

  async function joinSchool() {
    setJoinErr(null); setJoinInfo(null);
    if (!joinCode.trim()) return setJoinErr("Enter the school code your Admin Head shared.");
    setJoinBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const res = await fetch("/api/school/join", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ code: joinCode.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to join.");
      setJoinInfo(`Joined ${data.school?.name || "the school"}.`);
      setJoinCode("");
      await loadProfile();
    } catch (e) {
      setJoinErr(e instanceof Error ? e.message : "Failed to join.");
    } finally {
      setJoinBusy(false);
    }
  }

  // leaveSchool() was a self-service teacher-leaves-school action wired
  // to a tiny "Leave" button in the home-page header. Removed because:
  // a misclick + a reflex-dismissed native confirm could revoke a primary
  // teacher mid-term and leave their class unassigned, which broke
  // students' access to in-flight tests. School offboarding belongs to
  // the Admin Head's flow (DELETE via /school/teachers, which preserves
  // an audit trail and prompts class reassignment first). The DELETE
  // endpoint at /api/school/join still exists in case we want to surface
  // the action again from a Profile-page "danger zone" with a stronger
  // confirm — that's a deliberate later decision, not an oversight.

  useEffect(() => {
    (async () => {
      const user = await loadProfile();
      if (!user) return;
      const sb = supabaseBrowser();

      const [pend, appr] = await Promise.all([
        sb.from("question_bank").select("id", { count: "exact", head: true }).eq("status", "pending").eq("owner_id", user.id),
        sb.from("question_bank").select("id", { count: "exact", head: true }).eq("status", "approved").eq("owner_id", user.id),
      ]);

      // Recent tests = visibility-filtered union (owned ∪ primary-class
      // ∪ I-assigned). Mirrors the rule used by /teacher/reports and
      // /teacher/analytics so the home page agrees with what those pages
      // show. We also pull the assigner per quiz for the "Assigned by"
      // sub-line.
      const { data: cts } = await sb
        .from("class_teachers")
        .select("role, class_id")
        .eq("teacher_id", user.id);
      const ctRows = ((cts as Array<{ role: string; class_id: string }> | null) || []);
      const taughtClassIds = ctRows.map((r) => r.class_id);
      const primaryClassIds = new Set(
        ctRows.filter((r) => r.role === "primary" || r.role === "acting").map((r) => r.class_id)
      );

      type AsgHomeRow = {
        quiz_id: string;
        class_id: string | null;
        assigned_by: string | null;
        assigner: { full_name: string | null } | null;
      };
      const asgsAll: AsgHomeRow[] = [];
      const SELECT = "quiz_id, class_id, assigned_by, assigner:profiles!quiz_assignments_assigned_by_fkey(full_name)";
      {
        const { data } = await sb.from("quiz_assignments").select(SELECT).eq("assigned_by", user.id);
        asgsAll.push(...(((data as unknown) as AsgHomeRow[]) || []));
      }
      if (taughtClassIds.length > 0) {
        const { data } = await sb.from("quiz_assignments").select(SELECT).in("class_id", taughtClassIds);
        asgsAll.push(...(((data as unknown) as AsgHomeRow[]) || []));
      }
      const assignerByQuiz = new Map<string, { name: string; isMe: boolean }>();
      const visibleAssignedIds = new Set<string>();
      for (const r of asgsAll) {
        if (!r.quiz_id) continue;
        const meAssigned = r.assigned_by === user.id;
        const primaryHere = !!(r.class_id && primaryClassIds.has(r.class_id));
        if (!meAssigned && !primaryHere) continue;
        visibleAssignedIds.add(r.quiz_id);
        const name = r.assigner?.full_name || "Unknown";
        const cur = assignerByQuiz.get(r.quiz_id);
        if (!cur || (meAssigned && !cur.isMe)) assignerByQuiz.set(r.quiz_id, { name, isMe: meAssigned });
      }

      // Owned quizzes — always in scope.
      const { data: ownedQz } = await sb
        .from("quizzes").select("id, name, code, subject, created_at")
        .eq("owner_id", user.id);
      type QzRow = { id: string; name: string; code: string; subject: string | null; created_at: string | null };
      const ownedList = (ownedQz as QzRow[]) || [];

      // Assigned-not-owned quizzes I can still see (primary or assigner).
      let extraList: QzRow[] = [];
      const ownedSet = new Set(ownedList.map((q) => q.id));
      const missing = Array.from(visibleAssignedIds).filter((id) => !ownedSet.has(id));
      if (missing.length > 0) {
        const { data: extra } = await sb
          .from("quizzes").select("id, name, code, subject, created_at")
          .in("id", missing);
        extraList = (extra as QzRow[]) || [];
      }
      const qzList: QzRow[] = [...ownedList, ...extraList]
        .sort((a, b) => Date.parse(b.created_at || "1970-01-01") - Date.parse(a.created_at || "1970-01-01"))
        .slice(0, 5);

      // Total visible count (for the stats tile) — union, not just owned.
      const totalVisibleCount = new Set([...ownedList.map((q) => q.id), ...visibleAssignedIds]).size;

      const quizIds = qzList.map((q) => q.id);
      let attempts = 0;
      if (quizIds.length) {
        const { count } = await sb.from("quiz_attempts").select("id", { count: "exact", head: true }).in("quiz_id", quizIds);
        attempts = count || 0;
      }

      const ownedQuizIdSet = new Set(ownedList.map((q) => q.id));
      const enriched: RecentQuiz[] = await Promise.all(qzList.map(async (q) => {
        const [{ count: qCount }, { data: lastAtt }, { count: aCount }] = await Promise.all([
          sb.from("quiz_questions").select("question_id", { count: "exact", head: true }).eq("quiz_id", q.id),
          sb.from("quiz_attempts").select("submitted_at").eq("quiz_id", q.id).not("submitted_at", "is", null).order("submitted_at", { ascending: false }).limit(1),
          sb.from("quiz_attempts").select("id", { count: "exact", head: true }).eq("quiz_id", q.id),
        ]);
        const last = ((lastAtt as Array<{ submitted_at: string }> | null) || [])[0];
        const a = assignerByQuiz.get(q.id);
        return {
          id: q.id,
          name: q.name,
          code: q.code,
          subject: q.subject,
          questionCount: qCount || 0,
          attemptCount: aCount || 0,
          lastAttemptAt: last?.submitted_at || null,
          assignedByName: a?.name ?? null,
          assignedByMe: !!a?.isMe,
          ownedByMe: ownedQuizIdSet.has(q.id),
        };
      }));

      // Pending retake / extension requests routed to this teacher.
      // Powers the focus card priority below — when there's even one
      // request waiting, that's the most urgent thing on the page.
      let retakePending = 0;
      try {
        const { count: rrc } = await sb
          .from("quiz_retake_requests")
          .select("id", { count: "exact", head: true })
          .eq("teacher_id", user.id)
          .eq("status", "pending");
        retakePending = rrc || 0;
      } catch { /* table may not exist on very old DBs — silent */ }

      setStats({
        pending: pend.count || 0,
        approved: appr.count || 0,
        quizzes: totalVisibleCount,
        attempts,
        retakePending,
      });
      setRecent(enriched);
    })();
  }, []);

  const tiles = [
    { label: "Approved questions", hint: "Ready to use in tests",  value: stats.approved, icon: Library,        iconBg: "bg-emerald-100", iconFg: "text-emerald-700", href: "/teacher/quizzes/new" },
    { label: "Awaiting review",    hint: "AI drafts to approve",     value: stats.pending,  icon: ClipboardCheck, iconBg: "bg-amber-100",   iconFg: "text-amber-700",   href: "/teacher/review" },
    { label: "Tests created",    hint: "Across all your classes",  value: stats.quizzes,  icon: ListChecks,     iconBg: "bg-sky-100",     iconFg: "text-sky-700",     href: "/teacher/quizzes" },
    { label: "Student attempts",   hint: "Class tests only",       value: stats.attempts, icon: Users,          iconBg: "bg-violet-100",  iconFg: "text-violet-700",  href: "/teacher/analytics" },
  ];

  const focus: { title: string; sub: string; href: string; cta: string; tone: "amber" | "emerald" | "sky" | "rose" } =
    stats.retakePending > 0
      ? {
          title: `${stats.retakePending} student${stats.retakePending === 1 ? " is" : "s are"} asking for an extension or retake`,
          sub: "Approve a new due date or deny — the request is waiting on you.",
          href: "#retake-requests",
          cta: "Review requests",
          tone: "rose",
        }
      : stats.pending > 0
      ? {
          title: `${stats.pending} ${stats.pending === 1 ? "question is" : "questions are"} awaiting your review`,
          sub: "AI-drafted questions need a quick approval before they can land in a test.",
          href: "/teacher/review",
          cta: "Review now",
          tone: "amber",
        }
      : stats.quizzes === 0
      ? {
          title: "Let's get your first test going",
          sub: "Generate AI-drafted questions from your lesson notes, then review and assemble them into a test.",
          href: "/teacher/generate",
          cta: "Generate questions",
          tone: "emerald",
        }
      : {
          title: "All caught up",
          sub: "Nothing pending. Generate a fresh question set, host a live class quiz, or check this week's analytics.",
          href: "/teacher/digest",
          cta: "Open This Week",
          tone: "sky",
        };
  const focusTones = {
    amber:   { bg: "from-amber-50 to-orange-50",    border: "border-amber-200",    fg: "text-amber-900",    btn: "bg-amber-600 hover:bg-amber-700 text-white" },
    emerald: { bg: "from-emerald-50 to-teal-50",    border: "border-emerald-200",  fg: "text-emerald-900",  btn: "bg-emerald-600 hover:bg-emerald-700 text-white" },
    sky:     { bg: "from-sky-50 to-blue-50",        border: "border-sky-200",      fg: "text-sky-900",      btn: "bg-sky-600 hover:bg-sky-700 text-white" },
    rose:    { bg: "from-rose-50 to-pink-50",       border: "border-rose-200",     fg: "text-rose-900",     btn: "bg-rose-600 hover:bg-rose-700 text-white" },
  } as const;
  const focusTone = focusTones[focus.tone];

  const firstName = friendlyFirstName(name);

  return (
    <div className="max-w-6xl mx-auto fade-in">
      <div
        className="rounded-2xl px-5 py-5"
        style={{
          background: "linear-gradient(135deg, color-mix(in oklab, var(--brand-100, #d1fae5) 50%, var(--color-card, #fff)) 0%, color-mix(in oklab, #e0f2fe 35%, var(--color-card, #fff)) 100%)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h1 className="h1">
              Welcome back{firstName ? `, ${firstName}` : ""} &#x1F44B;
            </h1>
            <p className="muted mt-1 text-sm">
              Here&apos;s your snapshot for today.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <CurrentPlanBadge />
            {/* "Leave school" button removed. It was a footgun: one
                mistaken click + a reflex-dismissed native confirm could
                revoke a primary teacher mid-term and leave the class
                unassigned. School offboarding belongs to the Admin
                Head's flow at /school/teachers — preserves audit
                trail and prompts class reassignment before access
                is revoked. The DELETE endpoint at /api/school/join
                still exists if we want to surface this from a Profile
                danger-zone later with a stronger confirm. */}
          </div>
        </div>
      </div>

      <TeacherInvites onChanged={() => loadProfile()} />

      {/* Wait for the profile fetch to resolve before deciding which
          branch to render. Without this guard, schoolId is briefly
          null on every navigation here and the join-school card
          flashes for one frame before the dashboard hydrates. */}
      {!profileLoaded && (
        <div className="mt-6 grid place-items-center py-12"><div className="spinner" /></div>
      )}

      {profileLoaded && !schoolId && (
        <div className="mt-4 card">
          <h3 className="font-semibold flex items-center gap-2 mb-1"><Building2 size={16} /> Join your school</h3>
          <p className="text-xs muted mb-3">If your school&apos;s Admin Head has set up BloomIQ, ask them for the school code and enter it here. Your classes and analytics will roll up to their dashboard. Skip this if you&apos;re using BloomIQ on your own.</p>
          <div className="flex gap-2 max-w-md">
            <input
              className="input text-center font-mono uppercase tracking-[0.2em]"
              maxLength={8}
              placeholder="ABC123"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && joinSchool()}
            />
            <button type="button" className="btn btn-primary" onClick={joinSchool} disabled={joinBusy}>
              {joinBusy ? <span className="spinner" /> : "Join"}
            </button>
          </div>
          {joinErr && <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-1.5 rounded">{joinErr}</div>}
          {joinInfo && <div className="mt-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-1.5 rounded">{joinInfo}</div>}
        </div>
      )}

      {/* Everything below is gated on school membership. Without a
          school the teacher has no plan; we already redirect any
          sub-route here, so suppress the dashboard chrome too. The
          join card above stays visible until they enrol. Also gated
          on profileLoaded so the dashboard chrome doesn't render
          before the profile fetch resolves. */}
      {profileLoaded && schoolId && (
      <>

      <div className={`rounded-2xl px-5 py-4 mt-5 border bg-gradient-to-br ${focusTone.bg} ${focusTone.border} flex items-start justify-between gap-4 flex-wrap`}>
        <div className="min-w-0">
          <div className={`text-base font-bold ${focusTone.fg}`}>{focus.title}</div>
          <div className={`text-sm mt-0.5 ${focusTone.fg} opacity-80`}>{focus.sub}</div>
        </div>
        <Link href={focus.href} className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold shrink-0 transition ${focusTone.btn}`}>
          {focus.cta} <ArrowRight size={14} />
        </Link>
      </div>

      {/* Scope note. Each of the four tiles uses a different scope rule
          and that's confusing, so spell it out per metric. Question
          bank is per-teacher (private). Tests/Attempts use the union
          visibility rule (own + primary class + I-assigned). */}
      <div className="mt-4 rounded-lg bg-slate-50/80 border border-slate-200 px-3 py-2 text-xs text-slate-600">
        <strong className="text-slate-800">What&apos;s counted in these tiles:</strong>
        <ul className="mt-1 space-y-0.5 list-disc list-inside">
          <li>
            <strong>Approved questions</strong> &amp; <strong>Awaiting review</strong>: your own question bank — every teacher has a private bank, so other teachers&apos; questions don&apos;t show up here.
          </li>
          <li>
            <strong>Tests created</strong> &amp; <strong>Student attempts</strong>: tests on classes where you&apos;re the <strong>primary teacher</strong>, plus any tests <strong>you personally assigned</strong> (even on classes where you&apos;re only a co-teacher). Tests other teachers assigned to your co-teacher classes are not counted.
          </li>
        </ul>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
        {tiles.map(({ label, hint, value, icon: Icon, iconBg, iconFg, href }) => (
          <Link
            key={label}
            href={href}
            className="card card-hover block focus:outline-none focus:ring-2 focus:ring-emerald-500 rounded-xl"
          >
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-lg ${iconBg} ${iconFg} grid place-items-center shrink-0`}>
                <Icon size={20} />
              </div>
              <div className="min-w-0">
                <div className="text-3xl font-bold leading-tight">{value}</div>
                <div className="text-xs uppercase tracking-wide muted font-semibold">{label}</div>
              </div>
            </div>
            <div className="text-[11px] muted mt-2">{hint}</div>
          </Link>
        ))}
      </div>

      <div className="card mt-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="h2 mb-0">Recent tests</h3>
          <Link href="/teacher/quizzes" className="text-sm text-emerald-700 font-semibold">
            View all &rarr;
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-3xl mb-2">&#x1F4ED;</div>
            <div className="font-semibold mb-1">No tests yet</div>
            <p className="muted text-sm mb-4">Compose your first test and you&apos;ll get a 6-character code to share with students.</p>
            <Link href="/teacher/quizzes/new" className="btn btn-primary inline-flex">
              Create a test
            </Link>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {recent.map((q) => (
              <li key={q.id} className="py-3 flex items-center gap-4 flex-wrap">
                <div className="flex-1 min-w-0">
                  <Link href={`/teacher/quizzes/${q.id}`} className="font-semibold hover:text-emerald-700 truncate block">
                    {q.name}
                  </Link>
                  <div className="text-xs muted mt-0.5 flex items-center gap-2 flex-wrap">
                    {q.subject && (
                      <span className="px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-700 font-medium">
                        {q.subject}
                      </span>
                    )}
                    <code className="text-[10px] px-1.5 py-0.5 bg-slate-100 rounded font-mono">{q.code}</code>
                    <span>{q.questionCount} question{q.questionCount === 1 ? "" : "s"}</span>
                    <span aria-hidden>&middot;</span>
                    <span className="inline-flex items-center gap-1">
                      <Users size={11} /> {q.attemptCount} attempt{q.attemptCount === 1 ? "" : "s"}
                    </span>
                    {q.lastAttemptAt && (
                      <>
                        <span aria-hidden>&middot;</span>
                        <span className="inline-flex items-center gap-1">
                          <Calendar size={11} /> Last {new Date(q.lastAttemptAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </span>
                      </>
                    )}
                    {q.assignedByName && (
                      <>
                        <span aria-hidden>&middot;</span>
                        <span className="inline-flex items-center gap-1">
                          Assigned by{" "}
                          <span className={q.assignedByMe ? "text-emerald-700 font-semibold" : "font-medium"}>
                            {q.assignedByMe ? "you" : q.assignedByName}
                          </span>
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {/* Host live requires quiz ownership (live picker filters by
                      owner_id, live API requires owner). Hide the button on
                      tests this teacher doesn't own — otherwise clicking it
                      lands on a picker where the test isn't there, dead-end. */}
                  {q.ownedByMe && (
                    <Link href="/teacher/live" className="btn btn-ghost text-xs" title="Host this test as a live class session">
                      <Radio size={12} /> Host live
                    </Link>
                  )}
                  <Link href={`/teacher/quizzes/${q.id}`} className="btn btn-secondary text-xs">
                    View
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      </>
      )}

      {/* Retake / extension request panel — sits lower on the page so
          it's not competing with the focus card and stats trio for
          attention. The focus card flashes a rose CTA when there's
          a pending request, with href="#retake-requests" anchoring
          here. */}
      <div id="retake-requests" className="scroll-mt-24">
        <TeacherRetakeRequests />
      </div>
    </div>
  );
}
