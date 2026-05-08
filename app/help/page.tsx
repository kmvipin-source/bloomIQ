"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  HelpCircle, ArrowLeft, ArrowRight, BookOpen, Sparkles,
  ClipboardCheck, ListChecks, Radio, Users, BarChart3, FileText,
  MessageCircle, Building2, Mail, GraduationCap, ShieldCheck,
} from "lucide-react";

/**
 * /help — role-aware help center.
 *
 * One page, content rendered conditionally on the viewer's role:
 *   - Teacher: getting started → build a test → run a class → AI
 *     helpers → reports → troubleshooting.
 *   - Super-teacher (school admin): school setup → manage teachers /
 *     classes / students → AI helpers → reports → plan.
 *   - Student / independent: short blurb pointing at /student/help
 *     (not built yet — flag for future).
 *
 * Uses native <details>/<summary> for collapsible FAQ rows. Avoids JS
 * hover/click handlers entirely so the page is fast and accessible
 * (keyboard, screen-reader, search-engine friendly out of the box).
 */

type Role = "teacher" | "super_teacher" | "student" | null;

type Topic = {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  q: string;
  body: React.ReactNode;
};

export default function HelpPage() {
  const router = useRouter();
  const [role, setRole] = useState<Role>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) { setLoading(false); return; }
      const { data: prof } = await sb
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      setRole(((prof as { role: Role } | null)?.role) || null);
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return <div className="grid place-items-center py-20"><div className="spinner" /></div>;
  }

  // Pick the section list based on role. Each section has a heading
  // and a list of topic Q/A pairs.
  const homeHref =
    role === "super_teacher" ? "/school" :
    role === "teacher"       ? "/teacher" :
                                "/student";

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <button
        type="button"
        onClick={() => router.push(homeHref)}
        className="text-xs muted hover:text-emerald-700 inline-flex items-center gap-1 mb-3"
      >
        <ArrowLeft size={12} /> Back to dashboard
      </button>

      <div
        className="rounded-2xl px-5 py-5"
        style={{
          background: "linear-gradient(135deg, color-mix(in oklab, var(--brand-100, #d1fae5) 50%, var(--color-card, #fff)) 0%, color-mix(in oklab, #e0f2fe 35%, var(--color-card, #fff)) 100%)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-white p-2 shrink-0" style={{ color: "var(--brand-700)" }}>
            <HelpCircle size={22} />
          </div>
          <div>
            <h1 className="h1">Help &amp; how-tos</h1>
            <p className="muted text-sm mt-1">
              {role === "super_teacher"
                ? "Run BloomIQ for your whole school — teachers, classes, students, reports."
                : role === "teacher"
                ? "From AI-drafted questions to live class quizzes — the workflow at a glance."
                : "Most help topics live on your dashboard cards. Click around — every feature has a one-line intro."}
            </p>
          </div>
        </div>
      </div>

      {role === "super_teacher" && <SchoolAdminHelp />}
      {role === "teacher" && <TeacherHelp />}
      {(role === "student" || !role) && (
        <div className="card mt-5 text-sm muted">
          The student help center is on the way. In the meantime, every tile on
          your dashboard has a one-line description, and the {" "}
          <Link href="/settings/profile" className="text-emerald-700 font-semibold">
            Profile page
          </Link>{" "}
          covers personal details, password, 2FA, and theme.
        </div>
      )}

      {/* Footer — universal contact / feedback. */}
      <div className="card mt-5 text-sm">
        <h2 className="h2 mb-2 flex items-center gap-2"><Mail size={18} /> Still stuck?</h2>
        <p className="muted">
          Email <a className="text-emerald-700 font-semibold" href="mailto:support@bloomiq.app">support@bloomiq.app</a>{" "}
          and we&apos;ll get back to you within one working day. Include a screenshot if a page is showing
          something unexpected — saves a round-trip.
        </p>
      </div>
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  topics,
}: {
  title: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  topics: Topic[];
}) {
  return (
    <section className="card mt-5">
      <h2 className="h2 mb-3 flex items-center gap-2"><Icon size={18} /> {title}</h2>
      <div className="divide-y divide-slate-100">
        {topics.map((t, i) => (
          <details key={i} className="group py-3">
            <summary className="cursor-pointer list-none flex items-start justify-between gap-3 text-sm font-semibold">
              <span className="flex items-start gap-2 min-w-0">
                <t.icon size={14} className="mt-0.5 shrink-0 muted" />
                <span>{t.q}</span>
              </span>
              <ArrowRight size={14} className="muted shrink-0 transition group-open:rotate-90" />
            </summary>
            <div className="text-sm muted leading-relaxed mt-2 pl-6">{t.body}</div>
          </details>
        ))}
      </div>
    </section>
  );
}

// ============================================================
// Teacher help
// ============================================================
function TeacherHelp() {
  const gettingStarted: Topic[] = [
    {
      icon: BookOpen,
      q: "How do I get my first test running?",
      body: (
        <>
          Three steps. <strong>Generate</strong> AI-drafted questions from your
          lesson notes (sidebar &rarr; Content &rarr; Generate). <strong>Review</strong>{" "}
          them — approve the ones you like, edit or reject the rest. Then{" "}
          <strong>Tests</strong> &rarr; <em>New test</em> to assemble approved
          questions into a test, give it a name, save. You&apos;ll get a 6-character
          code you can share with students or assign through the class.
        </>
      ),
    },
    {
      icon: Building2,
      q: "Do I have to join a school?",
      body: (
        <>
          Yes &mdash; teacher accounts work inside a school. Until you join one,
          your dashboard shows just the &ldquo;Join your school&rdquo; card and
          everything else (Generate, Tests, Live class quiz, Analytics, the AI
          helpers) is held back. Ask your school&apos;s Admin Head for the
          8-character school code, or get them to invite you by email from the
          school&apos;s Teachers page. The moment you&apos;re in, the full
          dashboard reveals itself &mdash; no other setup needed.
        </>
      ),
    },
  ];

  const buildContent: Topic[] = [
    {
      icon: Sparkles,
      q: "How does AI question generation work?",
      body: (
        <>
          Paste lesson text, upload a PDF, or describe a topic. BloomIQ drafts a
          set of multiple-choice questions tagged by Bloom level (Remember &rarr;
          Create). Drafts go into your <strong>Review</strong> queue &mdash;
          they&apos;re never live until you approve. You can edit any question
          before approving.
        </>
      ),
    },
    {
      icon: ClipboardCheck,
      q: "What happens in Review?",
      body: (
        <>
          Three actions per question: <strong>Approve</strong> (moves to your
          question bank), <strong>Edit</strong> (fix wording, options, correct
          answer, Bloom level), <strong>Reject</strong> (drops it). Only approved
          questions can be assembled into tests.
        </>
      ),
    },
    {
      icon: ListChecks,
      q: "How do I assemble approved questions into a test?",
      body: (
        <>
          Sidebar &rarr; Content &rarr; <strong>Tests</strong> &rarr; <em>New test</em>.
          Browse your approved-question library on the left, click to add to the
          test on the right, name it, save. The test gets a 6-character code.
          You can mix Bloom levels and topics; the recommended duration adjusts
          to match the question difficulty.
        </>
      ),
    },
    {
      icon: FileText,
      q: "What are Exam Papers vs Tests?",
      body: (
        <>
          Same content, formal output. <strong>Tests</strong> live online;
          students take them in the app, you see analytics. <strong>Exam Papers</strong>{" "}
          are downloadable PDFs &mdash; for printed/handwritten exam sittings.
          Both come from your approved question bank.
        </>
      ),
    },
  ];

  const runClass: Topic[] = [
    {
      icon: Users,
      q: "How do I assign a test to a class?",
      body: (
        <>
          Open the test (Tests &rarr; click name) &rarr; <strong>Assign test</strong> &rarr;
          pick a class &rarr; (optional) set a due date. Every member of that
          class will see it under &ldquo;Assigned to you&rdquo; on their dashboard.
        </>
      ),
    },
    {
      icon: Users,
      q: "Why is there an Assign button on a test that's already assigned?",
      body: (
        <>
          The button changes to <strong>Assign more</strong> after the first
          assignment, and clicking it adds <em>another</em> assignment row &mdash;
          it doesn&apos;t replace the previous one. Three legitimate reasons to
          re-assign:
          <ul className="mt-2 space-y-1 list-disc list-inside">
            <li>
              <strong>Push to a second class</strong> &mdash; same test, e.g. Section A and Section B both take it.
            </li>
            <li>
              <strong>Add specific students</strong> &mdash; extend access to a transfer student or anyone not on the original class roster.
            </li>
            <li>
              <strong>Re-assign with a new due date</strong> &mdash; for makeup days, extensions, or a parent-meeting deadline.
            </li>
          </ul>
          The full assignment list lives on the test detail page if you want
          to audit or remove individual ones.
        </>
      ),
    },
    {
      icon: Radio,
      q: "What is Live class quiz?",
      body: (
        <>
          Real-time, Kahoot-style. Sidebar &rarr; Content &rarr; <strong>Live class quiz</strong>{" "}
          &rarr; pick a test &rarr; you get a 6-character code on screen. Students
          go to <em>Live class quiz</em> in their sidebar, type the code, and
          you advance questions together. <strong>Important:</strong> live scores
          are <em>engagement only</em> &mdash; they don&apos;t count toward class
          averages or reports. Use a regular assigned test for the official record.
        </>
      ),
    },
    {
      icon: Radio,
      q: "What's the point of Host live for a test I've already assigned?",
      body: (
        <>
          Live and Assign are orthogonal &mdash; the same test can serve both
          purposes within a single week. Common reasons to host an
          already-assigned test live:
          <ul className="mt-2 space-y-1 list-disc list-inside">
            <li><strong>Pre-test warmup</strong> &mdash; run it live the day before so students see the question style and can talk through tricky ones together.</li>
            <li><strong>Post-test review</strong> &mdash; once submissions are in, re-host to walk the class through the same questions for reinforcement, gamified, without re-grading anyone.</li>
            <li><strong>Quick formative check</strong> &mdash; pull up an existing test mid-lesson as an exit ticket without polluting the gradebook.</li>
            <li><strong>Misconception drill</strong> &mdash; re-host a weak-topic test until comprehension is solid.</li>
            <li><strong>Substitute / filler</strong> &mdash; pre-built test, zero prep, productive class time.</li>
          </ul>
          Live runs are stored separately from the official record &mdash; they
          don&apos;t affect class averages, Bloom mastery, or admin reports,
          regardless of how many times you host the same test.{" "}
          <strong>Note:</strong> only the test owner can host live. If a
          colleague created the test and assigned it to your class, you&apos;ll
          see it but the Host live button is hidden &mdash; ask them to host,
          or copy the test and host the copy.
        </>
      ),
    },
    {
      icon: BarChart3,
      q: "Where do I see student attempts?",
      body: (
        <>
          Sidebar &rarr; Insights &rarr; <strong>Test analytics</strong> shows
          per-test breakdowns: who took it, scores, Bloom-level performance,
          per-question difficulty. <strong>Class analytics</strong> (on each
          class page) gives the cross-test view of one class &mdash; student
          trajectories, pp change between first and latest attempt.{" "}
          <strong>Reports</strong> is the term-wide cross-class summary with
          Excel/PDF exports.
        </>
      ),
    },
  ];

  const aiHelpers: Topic[] = [
    {
      icon: MessageCircle,
      q: "What is Teacher Coach?",
      body: (
        <>
          A chat interface that knows your classes&apos; data. Ask things like
          &ldquo;which students are struggling most with Apply-level questions in
          algebra?&rdquo; and it answers using your actual grade book &mdash; no
          generic advice. Sidebar &rarr; Assist &rarr; Teacher Coach.
        </>
      ),
    },
    {
      icon: Sparkles,
      q: "What is This Week?",
      body: (
        <>
          AI-generated weekly briefing. Tells you which classes were active,
          which students need attention, and surfaces patterns across recent
          attempts. Read it Monday morning before you walk in.
        </>
      ),
    },
  ];

  const troubleshoot: Topic[] = [
    {
      icon: ShieldCheck,
      q: "How do I change my password or set up 2FA?",
      body: (
        <>
          Sidebar bottom &rarr; <strong>Profile</strong> for password changes;{" "}
          <strong>Security</strong> for two-factor authentication. We strongly
          recommend 2FA for any account with student data.
        </>
      ),
    },
    {
      icon: GraduationCap,
      q: "A student says they can't see their assigned test",
      body: (
        <>
          Three things to check. (1) Is the student a member of the class you
          assigned it to? Check Classes &rarr; class detail &rarr; roster.
          (2) Did the assignment save? Open the test &rarr; Assign &mdash; the
          class should be ticked. (3) Has the student signed in with the
          correct email? Email mismatch is the most common cause.
        </>
      ),
    },
  ];

  const visibility: Topic[] = [
    {
      icon: Users,
      q: "Which tests do I see on Home / Reports / Test analytics?",
      body: (
        <>
          You see a test if any of these are true:
          <ul className="mt-2 space-y-1 list-disc list-inside">
            <li>You <strong>own</strong> the test (you created it).</li>
            <li>You&apos;re the <strong>primary teacher</strong> on a class it&apos;s assigned to &mdash; you see every test pushed to your class, regardless of who created or assigned it.</li>
            <li>You <strong>personally assigned</strong> the test, even on a class where you&apos;re only a co-teacher.</li>
          </ul>
          Subject co-teachers don&apos;t see tests they didn&apos;t push, so a
          Math co-teacher isn&apos;t flooded with the Biology primary&apos;s
          assessments.
        </>
      ),
    },
    {
      icon: BarChart3,
      q: "What's actually in the Home tile numbers?",
      body: (
        <>
          The four Home tiles use two different scope rules:
          <ul className="mt-2 space-y-1 list-disc list-inside">
            <li><strong>Approved questions</strong> &amp; <strong>Awaiting review</strong>: your private question bank &mdash; every teacher has their own, so other teachers&apos; questions never show up here.</li>
            <li><strong>Tests created</strong> &amp; <strong>Student attempts</strong>: tests on classes where you&apos;re the primary teacher, plus any tests you personally assigned (even on co-teacher classes). Tests other teachers assigned to your co-teacher classes are excluded.</li>
          </ul>
          Live class engagement is always tracked separately &mdash; it never
          counts toward these numbers.
        </>
      ),
    },
    {
      icon: ListChecks,
      q: "What do the \"Assigned by\" labels mean?",
      body: (
        <>
          On Home, Reports, Test analytics, and Class analytics, every test
          shows who pushed it: <strong>by you</strong> or{" "}
          <strong>by [Teacher Name]</strong>. This matters in two-teacher
          classes where the same test can be assigned by either person, and
          the assigner is responsible for follow-up: due-date extensions,
          retake requests, parent communication. On the Class analytics
          &ldquo;Tests in this class&rdquo; table, the column doubles as a
          delegation map &mdash; you can see at a glance which tests are yours
          to follow up on and which are your colleague&apos;s.
        </>
      ),
    },
    {
      icon: Building2,
      q: "What does the Admin Head see compared to me?",
      body: (
        <>
          The Admin Head and any Deputies see <strong>everything in the
          school</strong> &mdash; all teachers, all classes, all submitted
          attempts. They use this view for term reviews, year-end audits, and
          school-wide AI Coach questions. Your view is scoped to what you
          teach or assigned, so the same test can show up in both places
          (yours and theirs) but the totals will differ &mdash; that&apos;s
          expected.
        </>
      ),
    },
  ];

  return (
    <>
      <Section title="Getting started" icon={BookOpen} topics={gettingStarted} />
      <Section title="Build content" icon={Sparkles} topics={buildContent} />
      <Section title="Run your class" icon={Users} topics={runClass} />
      <Section title="Visibility & what's in your numbers" icon={BarChart3} topics={visibility} />
      <Section title="AI helpers" icon={MessageCircle} topics={aiHelpers} />
      <Section title="Troubleshooting" icon={ShieldCheck} topics={troubleshoot} />
    </>
  );
}

// ============================================================
// School admin help
// ============================================================
function SchoolAdminHelp() {
  const setup: Topic[] = [
    {
      icon: Building2,
      q: "First-time setup checklist",
      body: (
        <>
          Four steps. (1) <strong>Profile</strong> &rarr; <em>Your school</em> &rarr;
          upload a logo. (2) <strong>Roster</strong> &rarr; <em>Teachers</em> &rarr;
          invite by email <em>or</em> share the school join code with them.
          (3) <strong>All Classes</strong> &rarr; create your classes (Grade 9 / Section A
          format works best) and assign primary teachers. (4) Add students to each
          class &mdash; primary teachers can do this from their own dashboard.
        </>
      ),
    },
    {
      icon: ShieldCheck,
      q: "Where is the school join code?",
      body: (
        <>
          Two places. <strong>School Home</strong> &mdash; under the school name, with a
          Copy button. <strong>Profile</strong> &rarr; <em>Your school</em> card &mdash;
          same code, also with Copy. Share it with teachers via WhatsApp or email; they
          paste it on their own dashboard&apos;s &ldquo;Join your school&rdquo; card.
        </>
      ),
    },
  ];

  const manage: Topic[] = [
    {
      icon: Users,
      q: "How do I invite a teacher?",
      body: (
        <>
          Two paths. <strong>Email invite</strong> (recommended): Roster &rarr;
          Teachers &rarr; <em>Invite teacher</em> &rarr; type their email. They get
          a join link. <strong>School code</strong> (faster for bulk): copy the
          school code and share it &mdash; teachers paste it on their dashboard.
          Both flows end up in the same place.
        </>
      ),
    },
    {
      icon: Building2,
      q: "How do classes work?",
      body: (
        <>
          Roster &rarr; <strong>All Classes</strong>. Naming follows{" "}
          <code>Grade {"{N}"} &middot; Section {"{X}"}</code> by convention.
          Each class needs a <strong>primary teacher</strong> (assign from the
          class row); you can add co-teachers later. Students join a class via
          the primary teacher&apos;s roster, not directly &mdash; this keeps the
          chain of responsibility clean.
        </>
      ),
    },
    {
      icon: GraduationCap,
      q: "What does Top Students show?",
      body: (
        <>
          A school-wide leaderboard ranked by class-quiz performance only &mdash;
          personal practice never enters this number. Useful for spotting students
          who are excelling across multiple classes, or for awards / recognition
          programmes.
        </>
      ),
    },
  ];

  const insights: Topic[] = [
    {
      icon: BarChart3,
      q: "What's in Reports?",
      body: (
        <>
          Insights &rarr; <strong>Reports</strong>. Bloom-level breakdown across
          your school, engagement metrics, an at-risk student list, and a
          per-class performance grid. Filter by date range and class. All numbers
          are scoped to <em>class-assigned tests only</em> &mdash; personal
          practice never affects what you see here.
        </>
      ),
    },
    {
      icon: Users,
      q: "How does my view differ from a teacher's view?",
      body: (
        <>
          You and any Deputies see <strong>everything in the school</strong>{" "}
          &mdash; every test, every class, every submitted attempt, regardless
          of which teacher created or assigned it. A regular teacher only sees
          tests on their primary classes plus tests they personally assigned.
          So the same test can appear in both your reports and theirs but the
          totals can differ &mdash; that&apos;s expected.{" "}
          <strong>Live class engagement</strong> is excluded from your school
          totals (it&apos;s tracked separately and doesn&apos;t affect the
          class record). Only the Admin Head can transfer the Admin Head role;
          everything else is identical between Head and Deputy.
        </>
      ),
    },
    {
      icon: MessageCircle,
      q: "What is School Coach?",
      body: (
        <>
          Chat interface that reads your school&apos;s data. Ask &ldquo;which
          teacher&apos;s class has the lowest Apply-level scores this term?&rdquo;
          or &ldquo;how does Section A compare to Section B in the recent
          algebra test?&rdquo; &mdash; it answers using your actual roster, not
          generic advice. Assist &rarr; School Coach.
        </>
      ),
    },
    {
      icon: Sparkles,
      q: "What is This Week?",
      body: (
        <>
          AI-generated school-wide briefing. Surfaces classes that were active,
          struggling cohorts, recently-onboarded teachers, and weekly trends.
          Designed to be readable in 90 seconds before a Monday principal&apos;s
          meeting.
        </>
      ),
    },
  ];

  const account: Topic[] = [
    {
      icon: ShieldCheck,
      q: "How do I transfer Admin Head to another teacher?",
      body: (
        <>
          School Home &rarr; <em>Transfer Admin Head</em> (collapsed by default;
          click to open) &rarr; type the new admin&apos;s email. They become the
          super-teacher; you become a regular teacher. Irreversible without their
          help, so confirm twice before clicking.
        </>
      ),
    },
    {
      icon: Building2,
      q: "Where does the school logo show up?",
      body: (
        <>
          On <strong>School Home</strong> at the top, in the BloomIQ branding
          row of every super-teacher / teacher / school-student sidebar, and on
          the parent-share link pages your students send out. PNG/JPG/SVG up to
          2&nbsp;MB; square images render best.
        </>
      ),
    },
    {
      icon: Mail,
      q: "How do I change my school's plan?",
      body: (
        <>
          Plan changes are managed by Anthropic / sales right now &mdash; not
          self-serve. The badge in your top-right shows your current tier. Email
          support@bloomiq.app to upgrade or change your subscription.
        </>
      ),
    },
  ];

  return (
    <>
      <Section title="School setup" icon={Building2} topics={setup} />
      <Section title="Manage teachers, classes, students" icon={Users} topics={manage} />
      <Section title="Reports & AI helpers" icon={BarChart3} topics={insights} />
      <Section title="Account & plan" icon={ShieldCheck} topics={account} />
    </>
  );
}
