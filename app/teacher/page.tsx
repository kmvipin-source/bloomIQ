"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Sparkles, Library, ListChecks, Users, Building2, LogOut, MessageCircle, Radio } from "lucide-react";

export default function TeacherHome() {
  const [stats, setStats] = useState({ pending: 0, approved: 0, quizzes: 0, attempts: 0 });
  const [recent, setRecent] = useState<{ id: string; name: string; code: string }[]>([]);
  const [name, setName] = useState("");
  const [schoolName, setSchoolName] = useState<string | null>(null);
  const [schoolId, setSchoolId] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinErr, setJoinErr] = useState<string | null>(null);
  const [joinInfo, setJoinInfo] = useState<string | null>(null);

  async function loadProfile() {
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    const { data: prof } = await sb.from("profiles").select("full_name, school_id").eq("id", user.id).single();
    setName(prof?.full_name || "");
    setSchoolId(prof?.school_id || null);
    if (prof?.school_id) {
      const { data: sch } = await sb.from("schools").select("name").eq("id", prof.school_id).maybeSingle();
      setSchoolName((sch as { name: string } | null)?.name || null);
    } else {
      setSchoolName(null);
    }
    return user;
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

  async function leaveSchool() {
    if (!confirm("Leave this school? Your classes and quizzes stay with you, but they'll stop rolling up to the school dashboard.")) return;
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    const res = await fetch("/api/school/join", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const data = await res.json();
    if (!res.ok) {
      alert(`Could not leave: ${data.error}`);
      return;
    }
    await loadProfile();
  }

  useEffect(() => {
    (async () => {
      const user = await loadProfile();
      if (!user) return;
      const sb = supabaseBrowser();

      const [pend, appr, qz] = await Promise.all([
        sb.from("question_bank").select("id", { count: "exact", head: true }).eq("status", "pending").eq("owner_id", user.id),
        sb.from("question_bank").select("id", { count: "exact", head: true }).eq("status", "approved").eq("owner_id", user.id),
        sb.from("quizzes").select("id, name, code", { count: "exact" }).eq("owner_id", user.id).order("created_at", { ascending: false }).limit(5),
      ]);
      const quizIds = (qz.data || []).map((q) => q.id);
      let attempts = 0;
      if (quizIds.length) {
        const { count } = await sb.from("quiz_attempts").select("id", { count: "exact", head: true }).in("quiz_id", quizIds);
        attempts = count || 0;
      }
      setStats({
        pending: pend.count || 0,
        approved: appr.count || 0,
        quizzes: qz.count || 0,
        attempts,
      });
      setRecent(qz.data || []);
    })();
  }, []);

  const tiles = [
    { label: "Approved questions", value: stats.approved, icon: Library,    color: "from-emerald-500 to-emerald-600" },
    { label: "Awaiting review",    value: stats.pending,  icon: Sparkles,   color: "from-amber-400 to-amber-500" },
    { label: "Quizzes created",    value: stats.quizzes,  icon: ListChecks, color: "from-sky-500 to-sky-600" },
    { label: "Student attempts",   value: stats.attempts, icon: Users,      color: "from-violet-500 to-violet-600" },
  ];

  return (
    <div className="max-w-6xl mx-auto fade-in">
      <h1 className="h1">Welcome back{name ? `, ${name.split(" ")[0]}` : ""} 👋</h1>
      <p className="muted mt-1">Here&apos;s your snapshot.</p>

      {schoolId ? (
        <div className="mt-4 card flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <Building2 size={18} className="text-emerald-700 shrink-0" />
            <div>
              <div className="text-xs muted uppercase tracking-wide font-semibold">Part of</div>
              <div className="font-semibold">{schoolName || "your school"}</div>
            </div>
          </div>
          <button onClick={leaveSchool} className="btn btn-ghost text-xs text-slate-500 hover:text-red-600">
            <LogOut size={12} /> Leave school
          </button>
        </div>
      ) : (
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
            <button className="btn btn-primary" onClick={joinSchool} disabled={joinBusy}>
              {joinBusy ? <span className="spinner" /> : "Join"}
            </button>
          </div>
          {joinErr && <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-1.5 rounded">{joinErr}</div>}
          {joinInfo && <div className="mt-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-1.5 rounded">{joinInfo}</div>}
        </div>
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-6">
        {tiles.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="card card-hover">
            <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${color} text-white grid place-items-center mb-3`}>
              <Icon size={20} />
            </div>
            <div className="text-3xl font-bold">{value}</div>
            <div className="text-sm muted">{label}</div>
          </div>
        ))}
      </div>

      {/* AI assistants — coach + weekly brief + live quiz */}
      <div className="grid sm:grid-cols-3 gap-4 mt-6">
        <Link href="/teacher/coach" className="card card-hover flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 text-white grid place-items-center shrink-0">
            <MessageCircle size={20} />
          </div>
          <div className="min-w-0">
            <div className="font-semibold">Teacher Coach</div>
            <div className="text-sm muted">Chat about your classes.</div>
          </div>
        </Link>
        <Link href="/teacher/digest" className="card card-hover flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-sky-500 to-sky-600 text-white grid place-items-center shrink-0">
            <Sparkles size={20} />
          </div>
          <div className="min-w-0">
            <div className="font-semibold">This Week</div>
            <div className="text-sm muted">AI-generated weekly briefing.</div>
          </div>
        </Link>
        <Link href="/teacher/live" className="card card-hover flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-fuchsia-500 to-rose-500 text-white grid place-items-center shrink-0">
            <Radio size={20} />
          </div>
          <div className="min-w-0">
            <div className="font-semibold">Live class quiz</div>
            <div className="text-sm muted">Kahoot-style live MCQ session.</div>
          </div>
        </Link>
      </div>

      <div className="grid lg:grid-cols-2 gap-6 mt-6">
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="h2">Quick actions</h3>
          </div>
          <div className="grid gap-2">
            <Link href="/teacher/generate" className="btn btn-primary justify-start">✨ Generate questions from content</Link>
            <Link href="/teacher/review"   className="btn btn-secondary justify-start">📝 Review {stats.pending} pending</Link>
            <Link href="/teacher/quizzes/new" className="btn btn-secondary justify-start">⏱️ Create a new quiz</Link>
            <Link href="/teacher/analytics" className="btn btn-secondary justify-start">📊 View class analytics</Link>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="h2">Recent quizzes</h3>
            <Link href="/teacher/quizzes" className="text-sm text-emerald-700 font-semibold">View all</Link>
          </div>
          {recent.length === 0 ? (
            <p className="muted text-sm">No quizzes yet. Create your first one to get a quiz code to share with students.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {recent.map((q) => (
                <li key={q.id} className="py-2.5 flex items-center justify-between">
                  <Link href={`/teacher/quizzes/${q.id}`} className="font-medium hover:text-emerald-700">{q.name}</Link>
                  <code className="text-xs px-2 py-1 bg-slate-100 rounded">{q.code}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
