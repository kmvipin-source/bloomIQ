"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Building2, Mail, UserRound, Send, CheckCircle2, Clock, Copy, Trash2, Settings, Calendar, AlertCircle } from "lucide-react";

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
  current_plan_id: string | null;
  current_plan_label: string | null;
  current_plan_tier: string | null;
  // Plan expiry — driven by subscriptions.expires_at on the school's
  // active subscription. expiry_status is derived server-side using the
  // same active/expiring/expired buckets every other admin surface uses.
  expires_at: string | null;
  expiry_status: "active" | "expiring" | "expired" | null;
};

type SchoolPlanOption = {
  id: string;
  slug: string;
  tier: string;
  label: string;
};

export default function OnboardSchoolPage() {
  const [schoolName, setSchoolName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminFullName, setAdminFullName] = useState("");
  // Optional plan binding at onboard time. "" = pick later (admin can
  // assign from the recent-onboardings dropdown afterwards).
  const [formPlanId, setFormPlanId] = useState<string>("");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ school_name: string; admin_email: string; join_code: string; bound_plan_label: string | null } | null>(null);

  const [list, setList] = useState<OnboardedSchool[]>([]);
  const [planOptions, setPlanOptions] = useState<SchoolPlanOption[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listErr, setListErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState<string | null>(null);
  // Per-school "set plan" busy state, keyed by school id.
  const [planBusy, setPlanBusy] = useState<Record<string, boolean>>({});
  const [planErr, setPlanErr] = useState<string | null>(null);

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
      setPlanOptions(j.available_school_plans || []);
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "Could not load onboardings.");
    } finally {
      setListLoading(false);
    }
  }

  async function deleteSchool(schoolId: string, schoolName: string) {
    if (!confirm(
      `Permanently delete "${schoolName}"?\n\n` +
      `This removes the school + every class + the school's subscription.\n` +
      `Teacher and student accounts survive but get unlinked from the school.\n\n` +
      `This cannot be undone.`,
    )) return;
    setDeleteBusy(schoolId);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const r = await fetch(`/api/admin/schools/${schoolId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Delete failed");
      setList((curr) => curr.filter((s) => s.id !== schoolId));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleteBusy(null);
    }
  }

  async function setSchoolPlan(schoolId: string, planId: string) {
    setPlanErr(null);
    // Plan changes affect billing. Confirm before firing the API
    // call — a stray click on the dropdown shouldn't silently
    // re-bill or shift a school onto a different tier. Operators who
    // need bulk speed can still use the per-school admin console.
    const school = list.find((s) => s.id === schoolId);
    const fromLabel = school?.current_plan_label || "no plan";
    const toLabel = planId
      ? (planOptions.find((p) => p.id === planId)?.label || "selected plan")
      : "no plan";
    if (fromLabel !== toLabel) {
      const ok = window.confirm(
        `Change plan for "${school?.name || schoolId}" from "${fromLabel}" to "${toLabel}"?`
      );
      if (!ok) {
        await loadList(); // reset dropdown to current value
        return;
      }
    }
    setPlanBusy((prev) => ({ ...prev, [schoolId]: true }));
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const r = await fetch(`/api/admin/schools/${schoolId}/set-plan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ plan_id: planId || null }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Could not set plan.");
      await loadList();
    } catch (e) {
      setPlanErr(e instanceof Error ? e.message : "Could not set plan.");
    } finally {
      setPlanBusy((prev) => ({ ...prev, [schoolId]: false }));
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
          plan_id: formPlanId || null,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Onboard failed.");
      setSuccess({
        school_name: j.school_name,
        admin_email: j.admin_email,
        join_code: j.join_code,
        bound_plan_label: j.bound_plan?.label ?? null,
      });
      // Reset form for the next school.
      setSchoolName(""); setAdminEmail(""); setAdminFullName(""); setFormPlanId("");
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

  // Format an ISO date as a short, India-friendly day-month-year string.
  function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
  }

  // Days from today to the given ISO date. Negative = expired.
  function daysUntil(iso: string | null): number | null {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return null;
    return Math.round((t - Date.now()) / (24 * 60 * 60 * 1000));
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

          {/* Optional school plan binding. If left as "Pick later", the
              platform admin can assign a plan from the inline dropdown
              in the recent-onboardings list below. */}
          <div>
            <label className="label">School plan <span className="muted text-xs">(optional)</span></label>
            <select
              className="input"
              value={formPlanId}
              onChange={(e) => setFormPlanId(e.target.value)}
              disabled={busy}
            >
              <option value="">— Pick later —</option>
              {planOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="text-xs muted mt-1">
              Sets which features the school&apos;s students unlock. You can change this later
              from the dropdown in the list below.
            </p>
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
              {success.bound_plan_label && (
                <div className="text-xs">
                  Bound to plan: <strong>{success.bound_plan_label}</strong>
                </div>
              )}
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
                <th className="px-4 py-3 text-left">Plan</th>
                <th className="px-4 py-3 text-left">Expires</th>
                <th className="px-4 py-3 text-left">Join code</th>
                <th className="px-4 py-3 text-left">Invited</th>
                <th className="px-4 py-3 text-right">Action</th>
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
                    {/* Inline plan picker — change selection to bind the school's
                        subscription to a different active plan version. */}
                    <div className="flex items-center gap-1.5">
                      <select
                        className="text-xs rounded border border-slate-200 px-2 py-1 bg-white"
                        value={s.current_plan_id || ""}
                        disabled={!!planBusy[s.id]}
                        onChange={(e) => setSchoolPlan(s.id, e.target.value)}
                      >
                        <option value="">— No plan —</option>
                        {planOptions.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                      {planBusy[s.id] && <span className="spinner" />}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap">
                    {/* Plan expiry. Three-bucket tone:
                        active   = >30d away (green)
                        expiring = ≤30d away (amber, with countdown)
                        expired  = past (red)
                        none     = no plan / no expiry yet (muted dash) */}
                    {(() => {
                      const days = daysUntil(s.expires_at);
                      if (s.expiry_status === "expired") {
                        return (
                          <span className="inline-flex items-center gap-1 font-semibold text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
                            <AlertCircle size={12} /> Expired {fmtDate(s.expires_at)}
                          </span>
                        );
                      }
                      if (s.expiry_status === "expiring" && days != null) {
                        return (
                          <span
                            className="inline-flex items-center gap-1 font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5"
                            title={`Expires ${fmtDate(s.expires_at)}`}
                          >
                            <Calendar size={12} /> Expires in {days}d
                          </span>
                        );
                      }
                      if (s.expiry_status === "active") {
                        return (
                          <span
                            className="inline-flex items-center gap-1 font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5"
                            title={days != null ? `${days} days remaining` : undefined}
                          >
                            <CheckCircle2 size={12} /> {fmtDate(s.expires_at)}
                          </span>
                        );
                      }
                      return <span className="muted">—</span>;
                    })()}
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
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      {/* Manage = per-school admin page: negotiated price,
                          invoice download, mark NEFT received. The inline
                          plan picker above stays — common case. The deeper
                          B2B controls live behind this link. */}
                      <Link
                        href={`/admin/schools/${s.id}`}
                        className="btn btn-ghost text-xs inline-flex items-center gap-1"
                        title="Negotiated price, invoice, mark NEFT received"
                      >
                        <Settings size={14} /> Manage
                      </Link>
                      <button
                        type="button"
                        className="btn btn-ghost text-red-600 text-xs inline-flex items-center gap-1"
                        onClick={() => deleteSchool(s.id, s.name)}
                        disabled={deleteBusy === s.id}
                        title="Delete school + cascade"
                      >
                        {deleteBusy === s.id ? <span className="spinner" /> : <Trash2 size={14} />} Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {planErr && (
            <div className="px-4 py-2 text-sm text-red-700 bg-red-50 border-t border-red-200">{planErr}</div>
          )}
        </div>
      )}

    </div>
  );
}
