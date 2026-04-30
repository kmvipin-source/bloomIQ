"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ShieldCheck, UserPlus, Trash2, Mail, Clock, AlertCircle, Copy, Check, Link as LinkIcon, ShieldAlert } from "lucide-react";

/**
 * /admin/team
 *
 * Manage who has platform_admin access. The first admin is bootstrapped via
 * SQL once; from there, this page is the source of truth — any platform
 * admin can grant the flag to colleagues by email or revoke it.
 *
 * Guardrails (enforced server-side too):
 *   - You can't revoke your own access (avoids accidental self-lockout).
 *   - You can't revoke the last remaining admin (avoids total lockout).
 */

type AdminRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  granted_at: string | null;
  granted_by_id: string | null;
  granted_by_name: string | null;
  is_bootstrap: boolean;
};

export default function AdminTeamPage() {
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [granting, setGranting] = useState(false);
  const [grantErr, setGrantErr] = useState<string | null>(null);
  const [grantOk, setGrantOk] = useState<string | null>(null);

  // Holds the one-time sign-in link returned by the grant API for new
  // (or dormant) accounts. We render a dedicated "share this link"
  // panel so the granting admin can paste it into Slack / WhatsApp.
  // Properties of the link: single-use, ~1 hour expiry, never reveals
  // a reusable secret. Plaintext passwords never exist anywhere in
  // this flow.
  const [invite, setInvite] = useState<{
    email: string;
    sign_in_link: string;
    created_new: boolean;
  } | null>(null);
  const [copied, setCopied] = useState<"email" | "link" | "share" | null>(null);

  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeErr, setRevokeErr] = useState<string | null>(null);

  // Per-row "Send sign-in link" — used to issue a fresh single-use link
  // to an existing admin. Useful for the zombie-confirmed case (admin
  // exists in auth.users but doesn't have a working password) and as a
  // general "they forgot, give them a way back in" affordance.
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [linkErr, setLinkErr] = useState<string | null>(null);

  function copyTo(text: string, key: "email" | "link" | "share") {
    try {
      navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* clipboard blocked */ }
  }

  async function load() {
    setLoading(true);
    setLoadErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const r = await fetch("/api/admin/team", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Could not load admins.");
      setAdmins(j.admins || []);
      setMeId(j.current_user_id || null);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Could not load admins.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function grant(e: React.FormEvent) {
    e.preventDefault();
    setGrantErr(null);
    setGrantOk(null);
    setGranting(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const r = await fetch("/api/admin/team", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ email, full_name: fullName }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Grant failed.");

      if (j.sign_in_link) {
        // New (or dormant) account — show the one-time sign-in link.
        // Suppress the generic toast so the link panel is the success
        // state and the admin can't miss it.
        setInvite({
          email: j.email,
          sign_in_link: j.sign_in_link,
          created_new: !!j.created_new,
        });
        setGrantOk(null);
      } else {
        setGrantOk(`Granted admin to ${j.email}.`);
        setInvite(null);
      }
      setEmail(""); setFullName("");
      load();
    } catch (e) {
      setGrantErr(e instanceof Error ? e.message : "Grant failed.");
    } finally {
      setGranting(false);
    }
  }

  async function sendSignInLink(userId: string, email: string) {
    setLinkErr(null);
    setLinkingId(userId);
    setInvite(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const r = await fetch("/api/admin/team/sign-in-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ user_id: userId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Could not generate link.");
      setInvite({
        email: j.email || email,
        sign_in_link: j.sign_in_link,
        // We label these as "fresh link" — the account already exists,
        // we're just minting a new way in.
        created_new: false,
      });
      // Scroll the panel into view in case the table is long.
      setTimeout(() => {
        const el = document.getElementById("invite-link-panel");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 50);
    } catch (e) {
      setLinkErr(e instanceof Error ? e.message : "Could not generate link.");
    } finally {
      setLinkingId(null);
    }
  }

  async function revoke(userId: string, label: string) {
    if (!confirm(`Revoke admin access from ${label}?`)) return;
    setRevokeErr(null);
    setRevokingId(userId);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const r = await fetch("/api/admin/team", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ user_id: userId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Revoke failed.");
      load();
    } catch (e) {
      setRevokeErr(e instanceof Error ? e.message : "Revoke failed.");
    } finally {
      setRevokingId(null);
    }
  }

  const canRevokeAnyone = admins.length > 1;

  return (
    <div className="fade-in">
      <h1 className="h1 flex items-center gap-2 mb-1"><ShieldCheck size={28} /> Admin team</h1>
      <p className="muted text-sm mb-6">
        Anyone listed here can access /admin/* — including this page. Granting and revoking
        happens immediately.
      </p>

      <div className="card max-w-xl">
        <h2 className="font-semibold flex items-center gap-2 mb-1"><UserPlus size={16} /> Add an admin</h2>
        <p className="text-xs muted mb-4">
          If the email already has a BloomIQ account, the flag flips on right away.
          If not, we&apos;ll generate a single-use sign-in link for you to share —
          your colleague clicks it once and chooses their own password.
        </p>
        <form onSubmit={grant} className="space-y-3">
          <div>
            <label className="label flex items-center gap-1.5"><Mail size={14} /> Email</label>
            <input
              className="input"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@bloomiq.app"
              disabled={granting}
            />
          </div>
          <div>
            <label className="label">Full name <span className="muted text-xs">(optional, used only for new accounts)</span></label>
            <input
              className="input"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Priya Singh"
              disabled={granting}
            />
          </div>
          {grantErr && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 shrink-0" /> {grantErr}
            </div>
          )}
          {grantOk && (
            <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg space-y-2">
              <div>{grantOk}</div>
              <div className="text-xs muted">
                If they can&apos;t sign in (e.g., a leftover stale invite from before),
                use <strong>Send sign-in link</strong> next to their row below to
                issue them a fresh single-use link.
              </div></div>
          )}
          <button type="submit" className="btn btn-primary w-full" disabled={granting || !email}>
            {granting ? <><span className="spinner" /> Granting…</> : <><UserPlus size={14} /> Grant admin access</>}
          </button>
        </form>
      </div>

      {/* Sign-in link panel — appears after a successful grant for a
          new (or dormant) account. The link is single-use, expires
          quickly, and lets the recipient set their own password. We
          deliberately don't show any password — there isn't one to
          share. The link itself is the credential, and it's safer than
          a password because it's short-lived and one-shot. */}
      {invite && (
        <div
          id="invite-link-panel"
          className="card max-w-xl mt-4 fade-in"
          style={{
            borderColor: "var(--brand-300)",
            boxShadow: "var(--shadow-brand)",
          }}
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold flex items-center gap-2">
              <LinkIcon size={16} style={{ color: "var(--brand-600)" }} />
              {invite.created_new ? "Account created" : "Fresh link generated"} — share to sign in
            </h2>
            <button
              type="button"
              onClick={() => setInvite(null)}
              className="text-xs muted hover:underline"
            >
              Dismiss
            </button>
          </div>
          <p className="text-xs muted mb-4">
            Send this link to <strong>{invite.email}</strong> via Slack / WhatsApp / SMS.
            They click it once, then choose their own password. <strong>You never see
            their password.</strong>
          </p>

          <div className="space-y-3">
            <CopyField
              label="Sign-in link"
              value={invite.sign_in_link}
              monospace
              copied={copied === "link"}
              onCopy={() => copyTo(invite.sign_in_link, "link")}
            />
          </div>

          <button
            type="button"
            onClick={() =>
              copyTo(
                `Hi! You've been added as a BloomIQ admin. Click this link to sign in (single-use, expires in ~1 hour):\n${invite.sign_in_link}\n\nYou'll be asked to set your own password right after. Welcome to the team!`,
                "share"
              )
            }
            className="btn btn-secondary w-full mt-4"
          >
            {copied === "share" ? <><Check size={14} /> Copied share message</> : <><Copy size={14} /> Copy ready-to-paste share message</>}
          </button>

          <div
            className="mt-4 px-3 py-2 rounded-lg text-[11px] flex items-start gap-2"
            style={{
              background: "var(--color-warn-soft)",
              color: "var(--color-warn)",
              border: "1px solid var(--color-border)",
            }}
          >
            <ShieldAlert size={13} className="mt-0.5 shrink-0" />
            <div>
              <strong>Security:</strong> the link is single-use and expires in about an hour.
              Anyone with the link can claim this admin account, so don&apos;t post it in public
              channels. If it expires before they click, just revoke + re-add to get a new link.
            </div>
          </div>
        </div>
      )}

      <h2 className="h2 mt-10 mb-3 flex items-center gap-2"><ShieldCheck size={20} /> Current admins</h2>

      {loading ? (
        <div className="card text-center py-8"><span className="spinner" /></div>
      ) : loadErr ? (
        <div className="card text-sm text-red-700 bg-red-50 border-red-200">{loadErr}</div>
      ) : admins.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">No admins yet — that&apos;s impossible if you&apos;re seeing this page.</div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase muted">
              <tr>
                <th className="px-4 py-3 text-left">Person</th>
                <th className="px-4 py-3 text-left">Email</th>
                <th className="px-4 py-3 text-left">Granted</th>
                <th className="px-4 py-3 text-left">By</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {admins.map((a) => {
                const isMe = a.id === meId;
                const blockedReason = isMe
                  ? "You can't revoke yourself."
                  : !canRevokeAnyone
                  ? "Can't revoke the last admin — add another first."
                  : null;
                return (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium">
                      {a.full_name || "(unnamed)"}
                      {isMe && (
                        <span className="ml-2 text-[10px] uppercase font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">You</span>
                      )}
                    </td>
                    <td className="px-4 py-3 break-all">{a.email || "—"}</td>
                    <td className="px-4 py-3 text-xs muted whitespace-nowrap">
                      {a.is_bootstrap ? (
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold text-slate-700 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5">
                          <Clock size={10} /> Bootstrap
                        </span>
                      ) : a.granted_at ? (
                        new Date(a.granted_at).toLocaleDateString()
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs muted">{a.granted_by_name || (a.is_bootstrap ? "SQL bootstrap" : "—")}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          className="btn btn-ghost disabled:opacity-40 disabled:cursor-not-allowed"
                          style={{ color: "var(--brand-700)" }}
                          title="Generate a fresh single-use sign-in link to share"
                          disabled={linkingId === a.id || !a.email}
                          onClick={() => sendSignInLink(a.id, a.email || "")}
                        >
                          {linkingId === a.id ? <span className="spinner" /> : <><LinkIcon size={14} /> Send link</>}
                        </button>
                        <button
                          className="btn btn-ghost text-red-700 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
                          title={blockedReason || "Revoke admin access"}
                          disabled={!!blockedReason || revokingId === a.id}
                          onClick={() => revoke(a.id, a.email || a.full_name || "this admin")}
                        >
                          {revokingId === a.id ? <span className="spinner" /> : <><Trash2 size={14} /> Revoke</>}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {linkErr && (
        <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {linkErr}
        </div>
      )}
      {revokeErr && (
        <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {revokeErr}
        </div>
      )}

      <div className="card mt-6 bg-slate-50 border-slate-200 text-xs muted leading-relaxed">
        <strong className="text-slate-800">One-time bootstrap:</strong> the very first admin must be flipped on via SQL because there&apos;s no admin yet to grant from this page. Run this once, then manage everyone else here:
        <pre className="mt-2 text-[11px] bg-white border border-slate-200 rounded p-2 overflow-x-auto">{`update public.profiles
set platform_admin = true
where id = (select id from auth.users where email = 'YOU@yourdomain.com');`}</pre>
      </div>
    </div>
  );
}

/**
 * One labelled row with a value + a copy-to-clipboard button. Used in
 * the sign-in link panel above. The value sits in a soft-tinted box so
 * it visually reads as "this is what you copy".
 */
function CopyField({
  label,
  value,
  monospace,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="text-xs font-semibold mb-1" style={{ color: "var(--color-fg-soft)" }}>
        {label}
      </div>
      <div className="flex items-center gap-2">
        <div
          className="flex-1 px-3 py-2 rounded-lg text-xs select-all overflow-x-auto whitespace-nowrap"
          style={{
            background: "var(--color-bg-soft)",
            border: "1px solid var(--color-border)",
            fontFamily: monospace
              ? "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
              : undefined,
          }}
        >
          {value}
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="btn btn-secondary"
          style={{ padding: "0.5rem 0.7rem" }}
          aria-label={`Copy ${label.toLowerCase()}`}
          title={`Copy ${label.toLowerCase()}`}
        >
          {copied ? <Check size={14} style={{ color: "var(--color-success)" }} /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}
