"use client";

import { useEffect, useState } from "react";
import { Inbox, CheckCircle2, XCircle, BookOpenCheck } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";

type Invite = {
  class_id: string;
  class_name: string;
  school_id: string | null;
  school_name: string;
  role: "primary" | "co";
  subject: string | null;
  invited_at: string;
  invited_by_name: string;
};

export default function TeacherInvites({ onChanged }: { onChanged?: () => void }) {
  const [items, setItems] = useState<Invite[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return;
      const r = await fetch("/api/teacher/invites", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      const j = await r.json();
      if (r.ok) setItems(j.invites as Invite[]);
    } catch { /* silent */ }
  }
  useEffect(() => { load(); }, []);

  async function respond(classId: string, action: "accept" | "decline") {
    setBusy(classId + action);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Session expired.");
      const r = await fetch("/api/teacher/invites/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ class_id: classId, action }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Failed");
      toast.success(action === "accept" ? "Invite accepted." : "Invite declined.");
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  if (!items || items.length === 0) return null;

  return (
    <div className="card mt-4 border-emerald-200" style={{ background: "linear-gradient(135deg, #ecfdf5, #fff)" }}>
      <div className="flex items-center gap-2 mb-3">
        <Inbox size={18} className="text-emerald-700" />
        <h2 className="font-bold text-lg">Class invitations</h2>
        <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-semibold">
          {items.length} pending
        </span>
      </div>
      <ul className="divide-y" style={{ borderColor: "var(--color-border)" }}>
        {items.map((i) => (
          <li key={i.class_id} className="py-3 flex flex-wrap items-start gap-3">
            <div className="flex-1 min-w-[240px]">
              <div className="font-semibold flex items-center gap-1.5">
                <BookOpenCheck size={14} className="text-emerald-700" />
                {i.class_name}
                <span className="text-[10px] uppercase tracking-wide font-bold ml-1 px-2 py-0.5 rounded-full"
                  style={{ background: i.role === "primary" ? "#dbeafe" : "#ede9fe", color: i.role === "primary" ? "#1e3a8a" : "#5b21b6" }}>
                  {i.role === "primary" ? "Primary" : "Co-teacher"}
                </span>
              </div>
              <div className="text-xs muted mt-0.5">
                {i.school_name} · invited by {i.invited_by_name}
                {i.subject ? ` · subject: ${i.subject}` : ""}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                className="btn btn-primary text-xs inline-flex items-center gap-1.5"
                disabled={busy === i.class_id + "accept"}
                onClick={() => respond(i.class_id, "accept")}
              >
                <CheckCircle2 size={12} /> Accept
              </button>
              <button
                className="btn btn-secondary text-xs inline-flex items-center gap-1.5"
                disabled={busy === i.class_id + "decline"}
                onClick={() => respond(i.class_id, "decline")}
              >
                <XCircle size={12} /> Decline
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
