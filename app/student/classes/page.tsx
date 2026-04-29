"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { Class } from "@/lib/types";
import { Users, LogOut } from "lucide-react";

type ClassRow = Class;

export default function StudentClassesPage() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;

    const { data: mem } = await sb
      .from("class_members")
      .select("class:classes(*)")
      .eq("student_id", user.id);

    type Row = { class: Class | null };
    const rows = ((mem as unknown as Row[]) || []).filter((r) => r.class);
    setClasses(rows.map((r) => r.class!));
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function join() {
    setErr(null); setInfo(null);
    const c = code.trim().toUpperCase();
    if (c.length < 4) return setErr("Please enter a valid class code.");
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) throw new Error("Not signed in");

      const { data: cls } = await sb.from("classes").select("id, name").eq("join_code", c).maybeSingle();
      if (!cls) throw new Error("No class found with that code.");

      const { error } = await sb.from("class_members").insert({
        class_id: cls.id,
        student_id: user.id,
      });
      // Ignore PK conflict (already a member) — treat as success
      if (error && !error.message.toLowerCase().includes("duplicate")) {
        throw error;
      }
      setInfo(`Joined ${cls.name}.`);
      setCode("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not join class");
    } finally {
      setBusy(false);
    }
  }

  async function leave(cid: string, name: string) {
    if (!confirm(`Leave ${name}? You'll lose access to its assignments.`)) return;
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    const { error } = await sb.from("class_members")
      .delete()
      .eq("class_id", cid)
      .eq("student_id", user.id);
    if (error) {
      alert(`Could not leave: ${error.message}`);
      return;
    }
    setClasses((arr) => arr.filter((c) => c.id !== cid));
  }

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <h1 className="h1">My Classes</h1>
      <p className="muted mt-1">Classes you&apos;ve joined. Your teacher can assign quizzes to a class — you&apos;ll see them on your home page.</p>

      <div className="card mt-6">
        <h3 className="font-semibold mb-3">Join a class</h3>
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="label">Class code</label>
            <input
              className="input text-center text-xl tracking-[0.3em] font-mono uppercase"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABC123"
              onKeyDown={(e) => e.key === "Enter" && join()}
            />
          </div>
          <button className="btn btn-primary" onClick={join} disabled={busy}>
            {busy ? <><span className="spinner" /> Joining…</> : "Join"}
          </button>
        </div>
        {err && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}
        {info && <div className="mt-3 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg">{info}</div>}
      </div>

      <h2 className="h2 mt-8 mb-3 flex items-center gap-2"><Users size={20} /> Your classes</h2>
      {classes.length === 0 ? (
        <div className="card text-center py-12 muted">
          You haven&apos;t joined any classes yet. Ask your teacher for a class code.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {classes.map((c) => (
            <div key={c.id} className="card">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold">{c.name}</div>
                  {c.grade && <div className="text-xs muted mt-0.5">Grade {c.grade}</div>}
                </div>
                <button className="btn btn-ghost text-red-600" onClick={() => leave(c.id, c.name)} title="Leave class">
                  <LogOut size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
