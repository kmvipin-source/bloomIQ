"use client";

// Bridge page that turns the Bearer-only /api/admin/subscriptions/[id]/invoice
// route into something a platform admin can reach by clicking a normal link.
//
// The API route requires `Authorization: Bearer <access_token>` — a plain
// `<a href>` can't carry that header, so navigating to the API URL directly
// 401s. This page fetches the PDF in the browser (where the token is in
// supabase-js' session storage), wraps it in a blob URL, and embeds it.
//
// Usage:
//   <Link href={`/admin/subscriptions/${subscriptionId}/invoice`}>Invoice PDF</Link>

import { use as usePromise, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Loader2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";

type PageProps = { params: Promise<{ id: string }> };

export default function InvoiceViewerPage(props: PageProps) {
  const { id } = usePromise(props.params);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState<string>("invoice.pdf");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    (async () => {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) {
        setErr("Sign in as platform admin to view invoices.");
        return;
      }
      const r = await fetch(`/api/admin/subscriptions/${id}/invoice`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j.error || `Invoice request failed (${r.status}).`);
        return;
      }
      // Pull filename from content-disposition so download keeps the
      // canonical BLM/YYYY/NNNN.pdf name.
      const cd = r.headers.get("content-disposition") || "";
      const m = cd.match(/filename="?([^";]+)"?/);
      if (m) setFilename(m[1]);
      const blob = await r.blob();
      createdUrl = URL.createObjectURL(blob);
      if (!cancelled) setBlobUrl(createdUrl);
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [id]);

  return (
    <div className="max-w-5xl mx-auto fade-in p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <Link href="/admin/dashboard" className="text-sm text-emerald-700 inline-flex items-center gap-1">
          <ArrowLeft size={14} /> Back to admin dashboard
        </Link>
        {blobUrl && (
          <a
            href={blobUrl}
            download={filename}
            className="btn btn-primary text-sm"
          >
            <Download size={14} /> Download {filename}
          </a>
        )}
      </div>

      {err && (
        <div className="card text-sm text-red-700 bg-red-50 border border-red-200">{err}</div>
      )}

      {!err && !blobUrl && (
        <div className="card grid place-items-center py-20">
          <Loader2 size={24} className="animate-spin muted" />
          <p className="text-sm muted mt-2">Generating invoice…</p>
        </div>
      )}

      {blobUrl && (
        // Embed the PDF in an iframe so the browser's native PDF viewer
        // renders it inline. Fallback for browsers without a built-in
        // viewer is the Download link above.
        <iframe
          src={blobUrl}
          title="Tax invoice"
          className="w-full rounded-lg border border-slate-200"
          style={{ height: "calc(100vh - 8rem)" }}
        />
      )}
    </div>
  );
}
