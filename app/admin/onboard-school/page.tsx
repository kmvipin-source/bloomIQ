"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Building2, Mail, UserRound, Send, CheckCircle2, Clock, Copy } from "lucide-react";

/**
 * /admin/onboard-school
 *
 * Internal page for BloomIQ staff to onboard a paying school. Behind the
 * scenes calls /api/admin/onboard-school which creates the schools row and
 * fires a Supabase invite email to the Admin Head.
 *
 * Manual workflow today:
 *   1. School pays (offline / "Talk to us").
 *   2. Operator visits this page, fills in school name + Admin Head's name
 *      and email, hits "Send invite".
 *   3. Admin Head gets an email with a one-click "Accept invite" link.
 *   4. Clicking the link opens a Supabase-hosted set-password screen, then
 *      drops them into /school with the school already named for them.
 *
 * The list below the form shows the last 50 onboardings with their status
 * (pending = invite sent but not yet clicked, accepted = Admin Head has
 * confirmed and logged in at least once).
 */

type OnboardedSchool = {
  id: string;
  name: string;
  join_code: string | null;
  admin_email: string | null;
  invited_at: string | null;
  accepted_at: string | null;
  status: "pending" | "accepted";
};

export default function OnboardSchoolPage() {
  const [schoolName, setSchoolName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminFullName, setAdminFullName] = useState("");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ school_name: string; admin_email: string; join_code: string } | null>(null);

  const [list, setList] = useState<OnboardedSchool[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listErr, setListErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function loadList() {
    setListLoading(true);
    setListErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const r = await fetch("/api/admin/onboard-school", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Could not load onboardings.");
      setList(j.schools || []);
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "Could not load onboardings.");
    } finally {
      setListLoading(false);
    }
  }

  useEffect(() => { loadList(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSuccess(null);
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const r = await fetch("/api/admin/onboard-school", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          school_name: schoolName,
          admin_email: adminEmail,
          admin_full_name: adminFullName,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Onboard failed.");
      setSuccess({
        school_name: j.school_name,
        admin_email: j.admin_email,
        join_code: j.join_code,
      });
      // Reset form for the next school.
      setSchoolName(""); setAdminEmail(""); setAdminFullName("");
      loadList();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Onboard failed.");
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="fade-in">
      <h1 className="h1 flex items-center gap-2 mb-1"><Building2 size={28} /> Onboard a school</h1>
      <p className="muted text-sm mb-6">
        Creates the school in BloomIQ and emails the Admin Head an invite link to set their password.
      </p>

      <div className="card max-w-xl">
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label flex items-center gap-1.5"><Building2 size={14} /> School name</label>
            <input
              className="input"
              required
              autoFocus
              value={schoolName}
              onChange={(e) => setSchoolName(e.target.value)}
              placeholder="Greenwood International School"
              disabled={busy}
            />
            <p className="text-xs muted mt-1">The Admin Head can rename this later from their dashboard.</p>
          </div>

          <div>
            <label className="label flex items-center gap-1.5"><UserRound size={14} /> Admin Head full name</label>
            <input
              className="input"
              required
              value={adminFullName}
              onChange={(e) => setAdminFullName(e.target.value)}
              placeholder="e.g. Mrs. Anjali Sharma"
              disabled={busy}
            />
          </div>

          <div>
            <label className="label flex items-center gap-1.5"><Mail size={14} /> Admin Head email</label>
            <input
              className="input"
              type="email"
              required
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              placeholder="principal@greenwood.edu.in"
              disabled={busy}
            />
            <p className="text-xs muted mt-1">The invite link is sent here. They click it to set a password.</p>
          </div>

          {err && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>
          )}
          {success && (
            <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg space-y-1">
              <div className="font-semibold flex items-center gap-1"><CheckCircle2 size={14} /> Invite sent</div>
              <div>
                <strong>{success.school_name}</strong> created. Invite emailed to <strong>{success.admin_email}</strong>.
              </div>
              <div className="text-xs">
                School join code: <code className="font-mono font-bold">{success.join_code}</code> — they can share this with teachers from their dashboard.
              </div>
            </div>
          )}

          <button type="submit" className="btn btn-primary w-full" disabled={busy}>
            {busy ? <><span className="spinner" /> Sending invite…</> : <><Send size={14} /> Send invite</>}
          </button>
        </form>
      </div>

      <h2 className="h2 mt-10 mb-3 flex items-center gap-2"><Clock size={20} /> Recent onboardings</h2>

      {listLoading ? (
        <div className="card text-center py-8"><span className="spinner" /></div>
      ) : listErr ? (
        <div className="card text-sm text-red-700 bg-red-50 border-red-200">{listErr}</div>
      ) : list.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">No schools onboarded yet.</div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase muted">
              <tr>
                <th className="px-4 py-3 text-left">School</th>
                <th className="px-4 py-3 text-left">Admin email</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Join code</th>
                <th className="px-4 py-3 text-left">Invited</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium">{s.name}</td>
                  <td className="px-4 py-3 break-all">{s.admin_email || "—"}</td>
                  <td className="px-4 py-3">
                    {s.status === "accepted" ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                        <CheckCircle2 size={12} /> Accepted
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                        <Clock size={12} /> Pending
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {s.join_code ? (
                      <span className="inline-flex items-center gap-1">
                        <code className="font-mono">{s.join_code}</code>
                        <button
                          type="button"
                          className="btn btn-ghost p-1"
                          onClick={() => copy(s.join_code!)}
                          title="Copy"
                        >
                          <Copy size={12} />
                        </button>
                        {copied === s.join_code && <span className="text-xs text-emerald-700">Copied</span>}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs muted whitespace-nowrap">
                    {s.invited_at ? new Date(s.invited_at).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}
