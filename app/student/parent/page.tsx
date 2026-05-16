"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  Users, ArrowLeft, Sparkles, Copy, Check, Trash2, Loader2, Eye, MessageCircle,
} from "lucide-react";

// =============================================================================
// PARENT-LINK MANAGER — student-side. Generates magic-link URLs the student
// can share with parents via WhatsApp/email so parents see a read-only
// dashboard without ever creating an account.
// =============================================================================

type Invite = {
  id: string;
  token: string;
  parent_label: string | null;
  parent_email: string | null;
  revoked_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  created_at: string;
};

export default function ParentLinksPage() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Form state
  const [parentLabel, setParentLabel] = useState("");
  const [parentEmail, setParentEmail] = useState("");
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    void load();
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { setLoading(false); return; }
    const r = await fetch("/api/parent/invite", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const j = await r.json();
    if (r.ok) setInvites(j.invites || []);
    setLoading(false);
  }

  async function create() {
    setErr(null);
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      const r = await fetch("/api/parent/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          parent_label: parentLabel.trim() || null,
          parent_email: parentEmail.trim() || null,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Create failed");
      setParentLabel("");
      setParentEmail("");
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!window.confirm("Revoke this link? The parent will no longer be able to view your dashboard with it.")) return;
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return;
      await fetch("/api/parent/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ revoke: true, id }),
      });
      void load();
    } finally {
      setBusy(false);
    }
  }

  function fullLink(token: string): string {
    return `${origin}/parent/${token}`;
  }

  async function copy(invite: Invite) {
    try {
      await navigator.clipboard.writeText(fullLink(invite.token));
      setCopiedId(invite.id);
      window.setTimeout(() => setCopiedId(null), 1500);
    } catch { /* clipboard might be blocked — user can still see + copy manually */ }
  }

  function whatsAppShare(invite: Invite): string {
    const text = encodeURIComponent(
      `Here's my ZCORIQ progress — you can check anytime, no signup needed:\n${fullLink(invite.token)}`
    );
    return `https://wa.me/?text=${text}`;
  }

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
        <ArrowLeft size={14} /> Back to dashboard
      </Link>

      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-pink-100 text-pink-700 p-3 shrink-0">
          <Users size={22} />
        </div>
        <div className="flex-1">
          <h1 className="h1">Share with a parent</h1>
          <p className="muted mt-1">
            Generate a link to share with your parent over WhatsApp or email. They&apos;ll see your weekly
            progress, Bloom-level mastery, and recent test scores — no signup, nothing to install. Revoke anytime.
          </p>
        </div>
      </div>

      {/* Create form */}
      <div className="card mt-6 space-y-3">
        <h2 className="font-semibold text-base">Create a new link</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Label <span className="muted text-xs font-normal">(optional)</span></label>
            <input className="input" placeholder="e.g. Mom" value={parentLabel} onChange={(e) => setParentLabel(e.target.value)} maxLength={40} />
          </div>
          <div>
            <label className="label">Parent&apos;s email <span className="muted text-xs font-normal">(optional, just so you remember)</span></label>
            <input className="input" type="email" placeholder="parent@example.com" value={parentEmail} onChange={(e) => setParentEmail(e.target.value)} maxLength={200} />
          </div>
        </div>
        {err && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>
        )}
        <button type="button" className="btn btn-primary" onClick={create} disabled={busy}>
          {busy ? <><Loader2 className="animate-spin" size={16} /> Creating…</> : <><Sparkles size={16} /> Create link</>}
        </button>
        <p className="text-xs muted">
          Anyone with this link can view your dashboard read-only — keep it private. You can revoke a link instantly.
        </p>
      </div>

      <h2 className="h2 mt-10 mb-3">Your links</h2>
      {loading ? (
        <div className="grid place-items-center py-10"><div className="spinner" /></div>
      ) : invites.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">No links yet — create one above.</div>
      ) : (
        <div className="space-y-3">
          {invites.map((inv) => {
            const link = fullLink(inv.token);
            const revoked = !!inv.revoked_at;
            return (
              <div key={inv.id} className={`card ${revoked ? "opacity-60" : ""}`}>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold">
                      {inv.parent_label || "Parent link"}
                      {revoked && <span className="ml-2 badge badge-rejected">Revoked</span>}
                    </div>
                    {inv.parent_email && <div className="text-xs muted mt-0.5">{inv.parent_email}</div>}
                    <div className="text-xs muted mt-1 flex items-center gap-2 flex-wrap">
                      <span className="inline-flex items-center gap-1">
                        <Eye size={11} /> {inv.view_count} view{inv.view_count === 1 ? "" : "s"}
                      </span>
                      {inv.last_viewed_at && (
                        <span>· last opened {new Date(inv.last_viewed_at).toLocaleDateString()}</span>
                      )}
                      <span>· created {new Date(inv.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>

                {!revoked && (
                  <>
                    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-mono text-slate-700 break-all">
                      {link}
                    </div>
                    <div className="mt-3 flex gap-2 flex-wrap">
                      <button type="button" className="btn btn-secondary" onClick={() => copy(inv)}>
                        {copiedId === inv.id ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy link</>}
                      </button>
                      <a className="btn btn-secondary" href={whatsAppShare(inv)} target="_blank" rel="noreferrer">
                        <MessageCircle size={14} /> Share on WhatsApp
                      </a>
                      <button type="button" className="btn btn-ghost text-red-700 ml-auto" onClick={() => revoke(inv.id)} disabled={busy}>
                        <Trash2 size={14} /> Revoke
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
