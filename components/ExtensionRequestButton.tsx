"use client";

import { useState } from "react";
import { Send, Clock, CheckCircle2, XCircle, AlarmClock } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";

/**
 * <ExtensionRequestButton />
 *
 * Inline affordance on each upcoming-assignment card on the school
 * student dashboard. Lets a student who knows in advance they can't
 * meet the due date ask their teacher for an extension BEFORE the
 * deadline. This is the pre-due counterpart to MissedAssignments,
 * which handles requests AFTER the deadline.
 *
 * Both flows write to the same quiz_retake_requests table and are
 * decided by the same teacher in TeacherRetakeRequests — the shape is
 * identical, only the trigger context differs.
 *
 * States:
 *   - No prior request, due in future → "Request extension" button
 *   - Existing pending request          → muted "Extension requested" pill
 *   - Approved/denied                   → small icon + decision note
 *
 * Independent students never see this — they have no assigned tests.
 */

export type ExtensionRequest = {
  id: string;
  status: "pending" | "approved" | "denied";
  decision_note: string | null;
} | null;

export default function ExtensionRequestButton({
  assignmentId,
  existingRequest,
  onSubmitted,
}: {
  assignmentId: string;
  existingRequest: ExtensionRequest;
  /** Parent re-fetches the assignment list when the student successfully submits. */
  onSubmitted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // If there's already a request for this assignment, show its current
  // state instead of the "Request extension" button.
  if (existingRequest) {
    if (existingRequest.status === "pending") {
      return (
        <span className="text-[11px] muted inline-flex items-center gap-1">
          <Clock size={11} /> Extension requested
        </span>
      );
    }
    if (existingRequest.status === "approved") {
      return (
        <span
          className="text-[11px] inline-flex items-center gap-1 font-medium"
          title={existingRequest.decision_note || undefined}
          style={{ color: "var(--brand-700, #047857)" }}
        >
          <CheckCircle2 size={11} /> Extension approved
        </span>
      );
    }
    return (
      <span
        className="text-[11px] text-red-700 inline-flex items-center gap-1 font-medium"
        title={existingRequest.decision_note || undefined}
      >
        <XCircle size={11} /> Extension denied
      </span>
    );
  }

  // Open form — small inline note + submit.
  if (open) {
    return (
      <div className="basis-full mt-2 flex items-start gap-2 flex-wrap">
        <textarea
          className="input flex-1 text-xs"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Reason (optional) — e.g. school trip, medical appointment, family commitment"
        />
        <button
          type="button"
          className="btn btn-primary text-xs inline-flex items-center gap-1"
          onClick={async () => {
            setBusy(true);
            try {
              const sb = supabaseBrowser();
              const { data: { session } } = await sb.auth.getSession();
              if (!session) throw new Error("Session expired.");
              const r = await fetch("/api/student/retake-request", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${session.access_token}`,
                },
                body: JSON.stringify({ assignment_id: assignmentId, note: note.trim() }),
              });
              const j = await r.json();
              if (!r.ok) throw new Error(j?.error || "Request failed");
              toast.success("Extension request sent to your teacher.");
              setOpen(false);
              setNote("");
              onSubmitted?.();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Failed");
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
        >
          {busy ? <span className="spinner" /> : <Send size={12} />} Send
        </button>
        <button
          type="button"
          className="btn btn-ghost text-xs"
          onClick={() => { setOpen(false); setNote(""); }}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    );
  }

  // Default — small inline link.
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="text-[11px] muted hover:text-emerald-700 inline-flex items-center gap-1"
    >
      <AlarmClock size={11} /> Request extension
    </button>
  );
}
