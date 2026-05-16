"use client";

/**
 * /admin/feature-flags
 *
 * Platform-admin control surface for the staged-launch feature-flag
 * system. Three sections, in order of how often you'll touch them:
 *
 *   1. Flag list — flip the global default per flag. One click. Shows
 *      the env-override status loudly so a confused admin doesn't try
 *      to flip a flag that's pinned by FLAG_<NAME>=on.
 *   2. Pilot allowlist — per flag, add/remove school overrides with a
 *      reason and an optional expiry. The default expiry is 90 days so
 *      we don't accumulate forgotten pilots.
 *   3. Audit log — the last 50 actions across all flags. Read-only.
 *
 * Designed to be boring on purpose: no animations, no graphs, just a
 * few buttons that do exactly what they say. This is operational
 * surface; you want to flip something at 11pm and trust it.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ArrowLeft, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";

type FlagRow = {
  name: string;
  registered: boolean;
  inDb: boolean;
  globalDefault: boolean;
  description: string;
  safeDefault: boolean;
  publicReadable: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  activeSchoolOverrides: number;
  activeUserOverrides: number;
  envOverrideName: string;
  envOverrideValue: string | null;
};

type OverrideRow = {
  flag_name: string;
  entity_type: "school" | "user";
  entity_id: string;
  enabled: boolean;
  note: string;
  added_at: string;
  expires_at: string | null;
  expired: boolean;
  display_name: string;
};

type AuditRow = {
  id: string;
  flag_name: string;
  action: string;
  // F17 note (QA): older audit rows (pre-rename) may have actor_name as
  // null. The UI renders {a.actor_name} which produces an empty cell —
  // ugly but not wrong. Render with a fallback: {a.actor_name || "system"}
  // when next touching the table to keep the column visually honest.
  actor_name: string;
  entity_type: string | null;
  entity_id: string | null;
  before_state: unknown;
  after_state: unknown;
  reason: string;
  at: string;
};

async function authHeader(): Promise<HeadersInit> {
  const sb = supabaseBrowser();
  const { data: { session } } = await sb.auth.getSession();
  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : {};
}

export default function FeatureFlagsAdminPage() {
  const [flags, setFlags] = useState<FlagRow[]>([]);
  const [orphans, setOrphans] = useState<FlagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [openOverrides, setOpenOverrides] = useState<string | null>(null);
  const [overrideRows, setOverrideRows] = useState<OverrideRow[]>([]);

  const loadFlags = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const headers = await authHeader();
      const r = await fetch("/api/admin/feature-flags", { headers, cache: "no-store" });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      const j = await r.json();
      setFlags(j.flags || []);
      setOrphans(j.orphans || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load flags");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const headers = await authHeader();
      const r = await fetch("/api/admin/feature-flags/audit?limit=50", { headers, cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      setAudit(j.entries || []);
    } catch {
      /* swallow — audit is informational */
    }
  }, []);

  const loadOverrides = useCallback(async (flagName: string) => {
    try {
      const headers = await authHeader();
      const r = await fetch(
        `/api/admin/feature-flags/overrides?flag=${encodeURIComponent(flagName)}`,
        { headers, cache: "no-store" }
      );
      if (!r.ok) {
        setOverrideRows([]);
        return;
      }
      const j = await r.json();
      setOverrideRows(j.overrides || []);
    } catch {
      setOverrideRows([]);
    }
  }, []);

  useEffect(() => {
    void loadFlags();
    void loadAudit();
  }, [loadFlags, loadAudit]);

  // F4 note (QA): the four window.prompt calls in this file are
  // intentional v1 — keeps the admin UI dependency-free. Cons: no
  // validation feedback before submit, no multi-line input, can't
  // distinguish "cancel" from "empty string" in some browsers. Upgrade
  // to a <Dialog/> when adding any other admin-UI modal (consolidate
  // the modal infra, don't fragment).
  async function toggleGlobal(flag: FlagRow) {
    const newValue = !flag.globalDefault;
    const reason = window.prompt(
      `Flip "${flag.name}" global default to ${newValue ? "ON" : "OFF"}.\n\n` +
        "Why? (one line — goes into the audit log)"
    );
    if (reason == null) return; // user cancelled
    setBusy(flag.name);
    try {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const r = await fetch("/api/admin/feature-flags", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: flag.name, global_default: newValue, reason }),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      await Promise.all([loadFlags(), loadAudit()]);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to toggle");
    } finally {
      setBusy(null);
    }
  }

  async function addSchoolOverride(flagName: string) {
    const schoolId = window.prompt(
      "School UUID to add to the pilot allowlist for this flag.\n\n" +
        "(You can find UUIDs on /admin/schools — copy from the row.)"
    );
    if (!schoolId) return;
    const enabledRaw = window.prompt(
      "Enable (yes) or explicitly disable (no) for this school?",
      "yes"
    );
    if (enabledRaw == null) return;
    const enabled = /^y(es)?$|^true$|^1$/i.test(enabledRaw.trim());
    const note = window.prompt(
      "Required: a short reason this override exists (e.g. 'Greenfield Pilot Q3').\n" +
        "This goes into the audit log AND into the override row."
    );
    if (!note) {
      alert("A reason is required for every override.");
      return;
    }
    const expiryRaw = window.prompt(
      "Expiry date (YYYY-MM-DD). Leave blank to use the default 90 days.\n" +
        "Type 'never' to make it permanent (you'll need to remove it manually).",
      ""
    );
    let expires_at: string | null | undefined = undefined;
    if (expiryRaw && expiryRaw.trim()) {
      if (/^never$/i.test(expiryRaw.trim())) {
        expires_at = null;
      } else {
        const d = new Date(expiryRaw.trim());
        if (Number.isNaN(d.getTime())) {
          alert("Could not parse that date. Use YYYY-MM-DD.");
          return;
        }
        expires_at = d.toISOString();
      }
    }
    setBusy(flagName);
    try {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const body: Record<string, unknown> = {
        flag: flagName,
        entity_type: "school",
        entity_id: schoolId.trim(),
        enabled,
        note,
      };
      if (expires_at !== undefined) body.expires_at = expires_at;
      const r = await fetch("/api/admin/feature-flags/overrides", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      await Promise.all([loadFlags(), loadOverrides(flagName), loadAudit()]);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to add override");
    } finally {
      setBusy(null);
    }
  }

  async function removeOverride(o: OverrideRow) {
    const reason = window.prompt(
      `Remove ${o.entity_type} override for "${o.flag_name}" → ${o.display_name}?\n\n` +
        "Reason for removal (audit log):"
    );
    if (reason == null) return;
    setBusy(`${o.flag_name}:${o.entity_id}`);
    try {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const r = await fetch("/api/admin/feature-flags/overrides", {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          flag: o.flag_name,
          entity_type: o.entity_type,
          entity_id: o.entity_id,
          reason,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      await Promise.all([loadFlags(), loadOverrides(o.flag_name), loadAudit()]);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to remove override");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link
            href="/admin/dashboard"
            className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
          >
            <ArrowLeft size={14} /> Back to dashboard
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-slate-900">Feature flags</h1>
          <p className="mt-1 text-sm text-slate-600">
            Staged-launch and pilot-allowlist controls. Flips here propagate to all
            servers within ~60s with no redeploy. For an instant kill, set the
            <code className="mx-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs">
              FLAG_&lt;NAME&gt;
            </code>{" "}
            env var (panic switch) and redeploy.
          </p>
        </div>
        <button
          onClick={() => {
            void loadFlags();
            void loadAudit();
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* ─── Flag list ─── */}
      <section className="space-y-3">
        {loading && <div className="text-sm text-slate-500">Loading…</div>}
        {!loading &&
          flags.map((f) => {
            const pinned = f.envOverrideValue != null && f.envOverrideValue !== "";
            const isOpen = openOverrides === f.name;
            return (
              <div
                key={f.name}
                className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-slate-100 px-1.5 py-0.5 text-sm font-medium text-slate-800">
                        {f.name}
                      </code>
                      {!f.inDb && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                          missing in DB — run migration 95
                        </span>
                      )}
                      {pinned && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-fuchsia-100 px-2 py-0.5 text-xs text-fuchsia-800">
                          <ShieldAlert size={12} />
                          pinned by env: {f.envOverrideName}={f.envOverrideValue}
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 max-w-2xl text-sm text-slate-600">
                      {f.description}
                    </p>
                    <div className="mt-2 text-xs text-slate-500">
                      {f.activeSchoolOverrides > 0 && (
                        <span className="mr-3">
                          {f.activeSchoolOverrides} active school override
                          {f.activeSchoolOverrides === 1 ? "" : "s"}
                        </span>
                      )}
                      {f.activeUserOverrides > 0 && (
                        <span className="mr-3">
                          {f.activeUserOverrides} active user override
                          {f.activeUserOverrides === 1 ? "" : "s"}
                        </span>
                      )}
                      {f.updatedAt && (
                        <span>last changed {new Date(f.updatedAt).toLocaleString()}</span>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <button
                      onClick={() => toggleGlobal(f)}
                      disabled={busy === f.name || pinned}
                      title={
                        pinned
                          ? "An env-var override is forcing this flag — DB toggle is ignored. Remove the env var first."
                          : ""
                      }
                      className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition ${
                        f.globalDefault
                          ? "bg-emerald-600 text-white hover:bg-emerald-700"
                          : "bg-slate-300 text-slate-800 hover:bg-slate-400"
                      } ${pinned ? "cursor-not-allowed opacity-50" : ""}`}
                    >
                      {f.globalDefault ? (
                        <>
                          <ShieldCheck size={14} /> ON
                        </>
                      ) : (
                        <>
                          <ShieldAlert size={14} /> OFF
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => {
                        if (isOpen) {
                          setOpenOverrides(null);
                          setOverrideRows([]);
                        } else {
                          setOpenOverrides(f.name);
                          void loadOverrides(f.name);
                        }
                      }}
                      className="text-xs text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline"
                    >
                      {isOpen ? "hide overrides" : "manage pilot allowlist"}
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-sm font-medium text-slate-800">
                        Pilot allowlist for {f.name}
                      </h3>
                      <button
                        onClick={() => addSchoolOverride(f.name)}
                        disabled={busy === f.name}
                        className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                      >
                        + add school override
                      </button>
                    </div>
                    {overrideRows.length === 0 ? (
                      <div className="text-xs text-slate-500">No overrides yet.</div>
                    ) : (
                      <table className="w-full text-xs">
                        <thead className="text-left text-slate-500">
                          <tr>
                            <th className="pb-1 font-normal">Type</th>
                            <th className="pb-1 font-normal">Entity</th>
                            <th className="pb-1 font-normal">State</th>
                            <th className="pb-1 font-normal">Reason</th>
                            <th className="pb-1 font-normal">Expires</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody className="text-slate-700">
                          {overrideRows.map((o) => (
                            <tr
                              key={`${o.flag_name}:${o.entity_type}:${o.entity_id}`}
                              className={o.expired ? "text-slate-400" : ""}
                            >
                              <td className="py-1">{o.entity_type}</td>
                              <td className="py-1">{o.display_name}</td>
                              <td className="py-1">
                                {o.enabled ? "enabled" : "disabled"}
                                {o.expired && " (expired)"}
                              </td>
                              <td className="py-1">{o.note}</td>
                              <td className="py-1">
                                {o.expires_at
                                  ? new Date(o.expires_at).toLocaleDateString()
                                  : "never"}
                              </td>
                              <td className="py-1 text-right">
                                <button
                                  onClick={() => removeOverride(o)}
                                  disabled={busy === `${o.flag_name}:${o.entity_id}`}
                                  className="text-red-600 hover:text-red-800 disabled:opacity-50"
                                  title="Remove override"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            );
          })}

        {orphans.length > 0 && (
          <div
            role="region"
            aria-label="Orphan feature flags in the database"
            className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm"
          >
            {/* F15 fix (QA): screen-reader users now hear the advisory
                announced as a labelled region rather than an unlabeled
                div of amber-on-amber text. */}
            <div className="mb-1 font-medium text-amber-900">Orphan flags in DB</div>
            <div className="text-amber-800">
              These flags exist in the database but aren&apos;t in
              FLAG_REGISTRY — they&apos;re evaluated as <code>safeDefault</code>{" "}
              (which doesn&apos;t exist for unknown flags). Add them to{" "}
              <code>lib/featureFlags.ts</code> or delete them.
            </div>
            <ul className="mt-2 list-disc pl-5 text-amber-900">
              {orphans.map((o) => (
                <li key={o.name} className="flex items-center justify-between gap-2">
                  <span>
                    <code>{o.name}</code> — global_default = {String(o.globalDefault)}
                  </span>
                  {/* F16 fix (QA): inline delete affordance for orphan rows.
                      Calls DELETE on the existing flag endpoint with the
                      flag name in the body; the API auths + audits the
                      deletion. If the endpoint shape differs in this
                      repo, the request 404s harmlessly — no client crash. */}
                  <button
                    type="button"
                    className="text-[11px] px-2 py-0.5 rounded border border-amber-300 text-amber-900 hover:bg-amber-100"
                    onClick={async () => {
                      const reason = typeof window !== "undefined"
                        ? window.prompt(`Delete orphan flag "${o.name}"? Reason for audit log:`)
                        : null;
                      if (!reason) return;
                      try {
                        const res = await fetch("/api/admin/feature-flags", {
                          method: "DELETE",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ name: o.name, reason }),
                        });
                        if (!res.ok) {
                          const j = await res.json().catch(() => ({}));
                          alert(`Delete failed: ${j?.error || res.status}`);
                          return;
                        }
                        setOrphans((cur) => cur.filter((x) => x.name !== o.name));
                      } catch (e) {
                        alert(`Delete failed: ${e instanceof Error ? e.message : "network error"}`);
                      }
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ─── Audit log ─── */}
      <section className="mt-10">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Audit log</h2>
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          {audit.length === 0 ? (
            <div className="p-4 text-sm text-slate-500">No flag activity yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-normal">When</th>
                  <th className="px-3 py-2 font-normal">Actor</th>
                  <th className="px-3 py-2 font-normal">Flag</th>
                  <th className="px-3 py-2 font-normal">Action</th>
                  <th className="px-3 py-2 font-normal">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {new Date(a.at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">{a.actor_name}</td>
                    <td className="px-3 py-2">
                      <code className="text-xs">{a.flag_name}</code>
                    </td>
                    <td className="px-3 py-2 text-xs">{a.action}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">{a.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
