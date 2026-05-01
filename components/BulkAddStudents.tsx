"use client";

import { useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Users, X, Download, Printer, Loader2, CheckCircle2, AlertTriangle, XCircle, RefreshCw, Copy } from "lucide-react";

type PreviewMatch = {
  id: string;
  full_name: string | null;
  username: string | null;
  inThisClass: boolean;
};
type PreviewRow = {
  index: number;
  raw: string;
  fullName: string;
  rollNumber: string | null;
  status: "ready" | "duplicate" | "duplicate-in-this-class" | "duplicate-in-paste" | "invalid";
  reason?: string;
  suggestedUsername: string;
  suggestedPassword: string;
  matches: PreviewMatch[];
};

type Action = "create" | "use_existing" | "skip";
type EditableRow = PreviewRow & {
  username: string;
  password: string;
  action: Action;
  existingId?: string | null;
  rollEdit: string;
};

type Outcome = {
  index: number;
  fullName: string;
  username: string | null;
  password: string | null;
  status: "created" | "added-existing" | "skipped" | "failed";
  reason?: string;
};

const USERNAME_CHARS = "abcdefghijkmnpqrstuvwxyz23456789";
const PASSWORD_CHARS = "abcdefghijkmnpqrstuvwxyz23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function rand(chars: string, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
const newUsername = () => "student." + rand(USERNAME_CHARS, 5);
const newPassword = () => rand(PASSWORD_CHARS, 8);

/**
 * BulkAddStudents - paste names, preview with dup checks, commit, then
 * download / print credentials.
 *
 * UX notes after first round of feedback:
 *   - Passwords show as visible code in the preview (not a cramped input).
 *     A small refresh icon regenerates a single password if the teacher
 *     wants something easier to dictate.
 *   - The results stage leads with a big primary "Download CSV" button so
 *     no one has to hunt for it after commit.
 *   - A red banner reminds the user that the auto-generated passwords are
 *     only shown once and to save them before closing.
 */
export default function BulkAddStudents({
  classId,
  className,
  onClose,
  onCreated,
}: {
  classId: string;
  className: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [stage, setStage] = useState<"paste" | "preview" | "results">("paste");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const dialogBodyRef = useRef<HTMLDivElement | null>(null);

  const namesToSubmit = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  async function preview() {
    setErr(null);
    if (namesToSubmit.length === 0) {
      setErr("Paste at least one name (one per line).");
      return;
    }
    if (namesToSubmit.length > 200) {
      setErr("That's a lot. Please split into batches of 200 or fewer.");
      return;
    }
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired - sign in again.");
      const r = await fetch("/api/admin/students/bulk-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ class_id: classId, names: namesToSubmit }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      const previewed = (j.rows as PreviewRow[]) || [];
      const editable: EditableRow[] = previewed.map((p) => ({
        ...p,
        username: p.suggestedUsername,
        password: p.suggestedPassword,
        action:
          p.status === "ready" ? "create"
          : p.status === "duplicate" ? "create"
          : p.status === "duplicate-in-this-class" ? "skip"
          : p.status === "duplicate-in-paste" ? "skip"
          : "skip",
        existingId: p.matches[0]?.id || null,
        rollEdit: p.rollNumber || "",
      }));
      setRows(editable);
      setStage("preview");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  }

  // Scroll the dialog body to the top whenever we move into the results
  // stage so the yellow "save these passwords" banner + download buttons
  // are guaranteed to be the first thing the teacher sees.
  useEffect(() => {
    if (stage === "results" && dialogBodyRef.current) {
      dialogBodyRef.current.scrollTop = 0;
    }
  }, [stage]);

  function setRow(idx: number, patch: Partial<EditableRow>) {
    setRows((rs) => rs.map((r) => (r.index === idx ? { ...r, ...patch } : r)));
  }

  async function commit() {
    setErr(null);
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired - sign in again.");
      const payload = rows.map((r) => ({
        index: r.index,
        fullName: r.fullName,
        username: r.username,
        password: r.password,
        action: r.action,
        existingId: r.existingId,
        rollNumber: r.rollEdit.trim() || null,
      }));
      const r = await fetch("/api/admin/students/bulk-create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ class_id: classId, rows: payload }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setOutcomes((j.outcomes as Outcome[]) || []);
      setStage("results");
      // NOTE: do NOT call onCreated() here. The parent's load() flips a
      // loading flag that re-renders the page as a spinner, which unmounts
      // THIS dialog mid-flow and wipes the credential download buttons.
      // We defer the parent reload until the user clicks Done in results.
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  function finishResults() {
    onCreated();
    onClose();
  }

  const counts = {
    create: rows.filter((r) => r.action === "create").length,
    useExisting: rows.filter((r) => r.action === "use_existing").length,
    skip: rows.filter((r) => r.action === "skip").length,
  };

  const credentialRows = outcomes.filter((o) => o.status === "created");

  function csvEscape(s: string): string {
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }
  function downloadCsv() {
    const header = "Full name,Username,Password\n";
    const body = credentialRows
      .map((o) => [o.fullName, o.username || "", o.password || ""].map(csvEscape).join(","))
      .join("\n");
    const blob = new Blob([header + body + "\n"], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${className.replace(/[^a-z0-9]+/gi, "_")}_credentials.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function printCards() {
    const w = window.open("", "_blank", "noopener,noreferrer,width=820,height=900");
    if (!w) {
      alert("Pop-up blocked. Allow pop-ups for this site to print credentials, or use Download CSV instead.");
      return;
    }
    const cardsHtml = credentialRows.map((o) => `
      <div class="card">
        <div class="cls">${escapeHtml(className)}</div>
        <div class="name">${escapeHtml(o.fullName)}</div>
        <div class="row"><span class="lbl">Username</span><code>${escapeHtml(o.username || "")}</code></div>
        <div class="row"><span class="lbl">Password</span><code>${escapeHtml(o.password || "")}</code></div>
        <div class="hint">Sign in at the Student tab on the BloomIQ login page.</div>
      </div>
    `).join("");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Student credentials - ${escapeHtml(className)}</title><style>
      body { font-family: -apple-system, system-ui, sans-serif; padding: 1rem; background: #fff; color: #111; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .card { border: 1.5px dashed #94a3b8; border-radius: 10px; padding: 14px 16px; page-break-inside: avoid; }
      .cls { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #475569; font-weight: 700; }
      .name { font-size: 18px; font-weight: 700; margin: 4px 0 10px; }
      .row { display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 14px; }
      .lbl { color: #64748b; min-width: 70px; }
      code { font-family: ui-monospace, "SF Mono", Menlo, monospace; background: #f1f5f9; padding: 2px 8px; border-radius: 4px; font-size: 13px; }
      .hint { font-size: 11px; color: #64748b; margin-top: 8px; }
      @media print { @page { margin: 12mm; } }
    </style></head><body><div class="grid">${cardsHtml}</div><script>window.onload = function(){ setTimeout(function(){ window.print(); }, 80); }<\/script></body></html>`);
    w.document.close();
  }

  function copyText(t: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(t).catch(() => {});
      setCopyToast("Copied");
      setTimeout(() => setCopyToast(null), 1200);
    }
  }
  function copyAllCredentials() {
    const lines = ["Full name\tUsername\tPassword"];
    credentialRows.forEach((o) => lines.push(`${o.fullName}\t${o.username || ""}\t${o.password || ""}`));
    copyText(lines.join("\n"));
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
      <div ref={dialogBodyRef} className="w-full max-w-3xl max-h-[92vh] overflow-y-auto bg-white rounded-xl shadow-xl border border-slate-200">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <Users size={18} /> Bulk add students
            <span className="text-xs font-normal muted">- {className}</span>
          </div>
          <button className="btn btn-ghost p-1" onClick={() => { if (stage === "results") onCreated(); onClose(); }} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="p-5">
          {err && (
            <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>
          )}
          {copyToast && (
            <div className="mb-3 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-1 rounded-lg inline-block">{copyToast}</div>
          )}

          {stage === "paste" && (
            <>
              <p className="text-sm muted mb-2">
                Paste one student per line. Roll number is optional — separate it from the name with a comma, tab, or pipe (<code className="px-1 text-[11px] bg-slate-100 rounded">Priya Sharma, 12</code>). We&rsquo;ll auto-generate a username + password for each and check for duplicates before creating anything.
              </p>
              <textarea
                className="input font-mono text-sm"
                rows={10}
                placeholder={"Priya Sharma, 12\nAnand Kumar, 13\nJoseph Lee\n..."}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="mt-2 text-xs muted">{namesToSubmit.length} name{namesToSubmit.length === 1 ? "" : "s"} pasted</div>
              <div className="mt-4 flex justify-end gap-2">
                <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" onClick={preview} disabled={busy || namesToSubmit.length === 0}>
                  {busy ? <><Loader2 size={14} className="animate-spin" /> Checking...</> : <>Preview {namesToSubmit.length || ""}</>}
                </button>
              </div>
            </>
          )}

          {stage === "preview" && (
            <>
              <div className="mb-3 text-sm flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={14} /> {counts.create} new</span>
                <span className="inline-flex items-center gap-1 text-sky-700">{counts.useExisting} reuse existing</span>
                <span className="inline-flex items-center gap-1 muted"><XCircle size={14} /> {counts.skip} skip</span>
                <span className="muted">- review usernames, passwords, and duplicates below</span>
              </div>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-[10px] uppercase muted">
                    <tr>
                      <th className="px-2 py-2 text-left w-8">#</th>
                      <th className="px-2 py-2 text-left">Name</th>
                      <th className="px-2 py-2 text-left w-20">Roll</th>
                      <th className="px-2 py-2 text-left">Username</th>
                      <th className="px-2 py-2 text-left">Password</th>
                      <th className="px-2 py-2 text-left w-32">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((r) => (
                      <tr key={r.index} className={r.status === "invalid" ? "bg-red-50/50" : r.status === "duplicate-in-this-class" ? "bg-sky-50/50" : r.status === "duplicate" ? "bg-amber-50/50" : ""}>
                        <td className="px-2 py-2 muted align-top">{r.index + 1}</td>
                        <td className="px-2 py-2 align-top">
                          <div className="font-medium">{r.fullName || <span className="muted italic">(empty)</span>}</div>
                          {r.status === "duplicate-in-this-class" && (
                            <div className="text-[10px] text-sky-800 inline-flex items-center gap-1"><AlertTriangle size={10} /> Already in this class - skipped</div>
                          )}
                          {r.status === "duplicate" && (
                            <div className="text-[10px] text-amber-800 inline-flex items-center gap-1">
                              <AlertTriangle size={10} /> Looks like {r.matches[0]?.full_name} ({r.matches[0]?.username || "no username"})
                            </div>
                          )}
                          {r.status === "duplicate-in-paste" && (
                            <div className="text-[10px] muted">{r.reason}</div>
                          )}
                          {r.status === "invalid" && (
                            <div className="text-[10px] text-red-700">{r.reason}</div>
                          )}
                        </td>
                        <td className="px-2 py-2 align-top">
                          <input
                            className="input text-xs font-mono"
                            style={{ width: 72 }}
                            value={r.rollEdit}
                            onChange={(e) => setRow(r.index, { rollEdit: e.target.value.replace(/[^A-Za-z0-9]/g, "") })}
                            pattern="[A-Za-z0-9]+"
                            placeholder="—"
                          />
                        </td>
                        <td className="px-2 py-2 align-top">
                          {r.action === "create" ? (
                            <div className="flex items-center gap-1">
                              <code className="font-mono text-[12px] bg-slate-100 rounded px-2 py-1 select-all whitespace-nowrap">
                                {r.username}
                              </code>
                              <button
                                className="btn btn-ghost p-1"
                                title="Generate a new username"
                                onClick={() => setRow(r.index, { username: newUsername() })}
                              >
                                <RefreshCw size={11} />
                              </button>
                            </div>
                          ) : (
                            <span className="muted text-[11px]">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 align-top">
                          {r.action === "create" ? (
                            <div className="flex items-center gap-1">
                              <code className="font-mono text-[12px] bg-slate-100 rounded px-2 py-1 select-all whitespace-nowrap">
                                {r.password}
                              </code>
                              <button
                                className="btn btn-ghost p-1"
                                title="Generate a new password"
                                onClick={() => setRow(r.index, { password: newPassword() })}
                              >
                                <RefreshCw size={11} />
                              </button>
                            </div>
                          ) : (
                            <span className="muted text-[11px]">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 align-top">
                          <select
                            className="select text-xs"
                            value={r.action}
                            onChange={(e) => setRow(r.index, { action: e.target.value as Action })}
                            disabled={r.status === "invalid"}
                          >
                            <option value="create">Create new</option>
                            {r.matches.length > 0 && (
                              <option value="use_existing">Reuse existing</option>
                            )}
                            <option value="skip">Skip</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 text-[11px] muted">
                Tip: click any username or password to select-all and copy. Use the <RefreshCw size={10} className="inline" /> button to regenerate one.
              </div>
              <div className="mt-4 flex justify-between items-center gap-2 flex-wrap">
                <button className="btn btn-ghost" onClick={() => setStage("paste")} disabled={busy}>← Edit names</button>
                <div className="flex gap-2">
                  <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
                  <button className="btn btn-primary" onClick={commit} disabled={busy || (counts.create + counts.useExisting === 0)}>
                    {busy ? <><Loader2 size={14} className="animate-spin" /> Creating...</> : <>Create {counts.create + counts.useExisting} student{counts.create + counts.useExisting === 1 ? "" : "s"}</>}
                  </button>
                </div>
              </div>
            </>
          )}

          {stage === "results" && (
            <>
              <div className="mb-3">
                <div className="text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-sm">
                  Done. Created {outcomes.filter((o) => o.status === "created").length}, reused {outcomes.filter((o) => o.status === "added-existing").length}, skipped {outcomes.filter((o) => o.status === "skipped").length}, failed {outcomes.filter((o) => o.status === "failed").length}.
                </div>
              </div>

              {credentialRows.length === 0 && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 mb-4 text-sm text-slate-700">
                  No new student accounts were created in this batch, so there are no passwords to save. Check the failures section below if you expected new accounts.
                </div>
              )}

              {credentialRows.length > 0 && (
                <>
                  <div className="rounded-lg border-2 border-amber-300 bg-amber-50 px-4 py-3 mb-4">
                    <div className="text-sm font-bold text-amber-900 mb-1">⚠ Save these passwords now</div>
                    <div className="text-xs text-amber-900/80 mb-3">
                      The auto-generated passwords are shown only this once. Download them, print cards, or copy them somewhere safe before closing this dialog. (You can always reset a password later from the class roster, but the original won&rsquo;t come back.)
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button className="btn btn-primary" onClick={downloadCsv}>
                        <Download size={14} /> Download CSV
                      </button>
                      <button className="btn btn-secondary" onClick={printCards}>
                        <Printer size={14} /> Print cards
                      </button>
                      <button className="btn btn-secondary" onClick={copyAllCredentials}>
                        <Copy size={14} /> Copy all
                      </button>
                    </div>
                  </div>

                  <div className="text-sm font-semibold mb-2">Credentials for new students</div>
                  <div className="overflow-x-auto rounded-lg border border-slate-200 mb-3">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 text-[10px] uppercase muted">
                        <tr>
                          <th className="px-3 py-2 text-left">Name</th>
                          <th className="px-3 py-2 text-left">Username</th>
                          <th className="px-3 py-2 text-left">Password</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {credentialRows.map((o) => (
                          <tr key={o.index}>
                            <td className="px-3 py-2 font-medium">{o.fullName}</td>
                            <td className="px-3 py-2">
                              <code
                                className="font-mono text-[12px] bg-slate-100 rounded px-2 py-1 cursor-pointer select-all"
                                onClick={() => copyText(o.username || "")}
                                title="Click to copy"
                              >
                                {o.username}
                              </code>
                            </td>
                            <td className="px-3 py-2">
                              <code
                                className="font-mono text-[12px] bg-slate-100 rounded px-2 py-1 cursor-pointer select-all"
                                onClick={() => copyText(o.password || "")}
                                title="Click to copy"
                              >
                                {o.password}
                              </code>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {outcomes.some((o) => o.status === "failed") && (
                <div className="mt-2">
                  <div className="text-sm font-semibold text-red-700 mb-1">Failures</div>
                  <ul className="text-xs text-red-800 list-disc pl-5">
                    {outcomes.filter((o) => o.status === "failed").map((o) => (
                      <li key={o.index}>{o.fullName || `(row ${o.index + 1})`} - {o.reason || "unknown error"}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-4 flex justify-end">
                <button className="btn btn-primary" onClick={finishResults}>Done</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" : "&#39;"
  ));
}
