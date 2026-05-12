"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { Class } from "@/lib/types";
import { Users } from "lucide-react";
import Empty from "@/components/Empty";

// "acting" is the cover-teacher role used when a co-teacher is filling in
// for an absent primary. Class-context normalises it to primary for
// permissions; mirror that here so the badge + sort match.
type ClassRow = Class & { memberCount?: number; myRole: "primary" | "co" | "acting"; mySubject: string | null };

export default function ClassesPage() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { setLoading(false); return; }

    // Fetch via the server route. The route reads class_teachers + classes
    // with the service-role key, so admin-assigned classes always surface
    // here even if RLS on those tables has a gap.
    try {
      const res = await fetch("/api/teacher/classes", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      let json: { ok?: boolean; classes?: ClassRow[]; error?: string } = {};
      let raw = "";
      try { raw = await res.text(); json = raw ? JSON.parse(raw) : {}; } catch {}
      if (!res.ok) {
        throw new Error(json?.error || `HTTP ${res.status}: ${raw.slice(0, 200)}`);
      }
      setClasses((json.classes as ClassRow[]) || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load classes");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <h1 className="h1">Classes</h1>
      <p className="muted mt-1">Classes you teach as primary or co-teacher. Open one to manage its roster and assignments.</p>

      <div className="mt-4 text-sm text-slate-700 bg-sky-50 border border-sky-200 px-3 py-2 rounded-lg">
        Classes are now created by your school Admin Head (typically the Principal). If you need a new class, ask them to set one up and assign you as the primary teacher.
      </div>

      <h2 className="h2 mt-8 mb-3">Your classes</h2>
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
          Couldn&rsquo;t load your classes: {error}
        </div>
      )}
      {classes.length === 0 ? (
        <Empty
          icon="👥"
          title="No classes yet"
          body="You haven't been assigned to any classes. Ask your school Admin Head to create a class and add you as the primary or a co-teacher."
        />
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {classes.map((c) => (
            <Link
              key={c.id}
              href={`/teacher/classes/${c.id}`}
              className="card card-hover block"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{c.name}</div>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {c.myRole === "primary" || c.myRole === "acting" ? (
                      <span className="text-[10px] uppercase tracking-wide font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                        {c.myRole === "acting" ? "Acting Primary" : "Primary"}
                      </span>
                    ) : (
                      <span className="text-[10px] uppercase tracking-wide font-bold text-sky-700 bg-sky-50 border border-sky-200 rounded-full px-2 py-0.5">
                        Co-teacher{c.mySubject ? ` · ${c.mySubject}` : ""}
                      </span>
                    )}
                    {c.grade && <span className="text-xs muted">Grade {c.grade}</span>}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs muted">Join code</div>
                  <code className="text-sm font-mono font-bold">{c.join_code}</code>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between gap-2 text-xs muted">
                <span className="flex items-center gap-1">
                  <Users size={14} /> {c.memberCount || 0} student{c.memberCount === 1 ? "" : "s"}
                </span>
                <span>Created {new Date(c.created_at).toLocaleDateString()}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
