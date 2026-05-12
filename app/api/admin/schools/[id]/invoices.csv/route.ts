import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/admin/schools/[id]/invoices.csv  (D16 — finance export)
 *
 * Streams a CSV of every billing cycle for one school — the current live
 * subscription row PLUS every archived past cycle. Designed for the
 * platform admin's finance reconciliation flow: download → diff against
 * bank statement → mark anything missing.
 *
 * Schema (one row per cycle, most-recent first):
 *   invoice_number, cycle_started_at, cycle_expires_at,
 *   contracted_students, plan_slug, override_price_paise, override_reason,
 *   override_reason_type, payment_method, payment_received_at,
 *   payment_recorded_at, po_number, contract_years, is_archived
 *
 * Auth: platform_admin only.
 */

type RouteContext = { params: Promise<{ id: string }> };

// Minimal RFC-4180 escape — wrap in quotes if the value has a comma, quote,
// or newline; double any embedded quotes. Cheap, safe, no dependency.
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

export async function GET(req: Request, ctx: RouteContext) {
  const token = getBearer(req);
  if (!token) return new Response("Unauthorized", { status: 401 });
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { data: prof } = await sb
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!prof?.platform_admin) return new Response("Forbidden", { status: 403 });

  const { id: schoolId } = await ctx.params;
  if (!schoolId) return new Response("school id is required", { status: 400 });

  const admin = supabaseAdmin();

  const { data: school } = await admin
    .from("schools")
    .select("id, name")
    .eq("id", schoolId)
    .maybeSingle();
  if (!school) return new Response("School not found", { status: 404 });

  // Live subscription row (the current open cycle).
  type LiveRow = {
    invoice_number: string | null;
    started_at: string | null;
    expires_at: string | null;
    contracted_students: number | null;
    plan_id: string | null;
    override_price_paise: number | null;
    override_reason: string | null;
    override_reason_type: string | null;
    payment_method: string | null;
    payment_received_at: string | null;
    payment_recorded_at: string | null;
    po_number: string | null;
    contract_years: number | null;
  };
  const { data: liveRaw } = await admin
    .from("subscriptions")
    .select(
      "invoice_number, started_at, expires_at, contracted_students, plan_id, " +
      "override_price_paise, override_reason, override_reason_type, " +
      "payment_method, payment_received_at, payment_recorded_at, " +
      "po_number, contract_years"
    )
    .eq("school_id", schoolId)
    .maybeSingle();
  const live = (liveRaw as unknown as LiveRow | null) ?? null;

  // Past cycles.
  type PastRow = {
    invoice_number: string | null;
    cycle_started_at: string | null;
    cycle_expires_at: string | null;
    contracted_students: number | null;
    plan_id: string | null;
    override_price_paise: number | null;
    override_reason: string | null;
    payment_method: string | null;
    payment_received_at: string | null;
    archived_at: string;
  };
  const { data: pastRaw } = await admin
    .from("subscription_invoice_archive")
    .select(
      "invoice_number, cycle_started_at, cycle_expires_at, contracted_students, " +
      "plan_id, override_price_paise, override_reason, " +
      "payment_method, payment_received_at, archived_at"
    )
    .eq("school_id", schoolId)
    .order("archived_at", { ascending: false });
  const past = (pastRaw as unknown as PastRow[] | null) ?? [];

  // Resolve plan slugs in one query. The archive can reference plans the
  // school is no longer on, so we have to look up every distinct plan_id.
  const planIds = new Set<string>();
  if (live?.plan_id) planIds.add(live.plan_id);
  for (const p of past) if (p.plan_id) planIds.add(p.plan_id);
  const planSlugById = new Map<string, string>();
  if (planIds.size > 0) {
    const { data: plans } = await admin
      .from("plans")
      .select("id, slug")
      .in("id", Array.from(planIds));
    for (const pl of (plans ?? []) as { id: string; slug: string | null }[]) {
      if (pl.slug) planSlugById.set(pl.id, pl.slug);
    }
  }

  const header = [
    "invoice_number",
    "cycle_started_at",
    "cycle_expires_at",
    "contracted_students",
    "plan_slug",
    "override_price_paise",
    "override_reason",
    "override_reason_type",
    "payment_method",
    "payment_received_at",
    "payment_recorded_at",
    "po_number",
    "contract_years",
    "is_archived",
  ];
  const rows: string[] = [csvRow(header)];

  // Live cycle first (most-recent in spirit).
  if (live) {
    rows.push(
      csvRow([
        live.invoice_number,
        live.started_at,
        live.expires_at,
        live.contracted_students,
        live.plan_id ? planSlugById.get(live.plan_id) ?? "" : "",
        live.override_price_paise,
        live.override_reason,
        live.override_reason_type,
        live.payment_method,
        live.payment_received_at,
        live.payment_recorded_at,
        live.po_number,
        live.contract_years,
        "false",
      ])
    );
  }
  // Then archived cycles (most-recent first from query).
  for (const p of past) {
    rows.push(
      csvRow([
        p.invoice_number,
        p.cycle_started_at,
        p.cycle_expires_at,
        p.contracted_students,
        p.plan_id ? planSlugById.get(p.plan_id) ?? "" : "",
        p.override_price_paise,
        p.override_reason,
        "",                       // override_reason_type isn't on the archive table
        p.payment_method,
        p.payment_received_at,
        "",                       // payment_recorded_at isn't on the archive table
        "",                       // po_number isn't on the archive table
        "",                       // contract_years isn't on the archive table
        "true",
      ])
    );
  }

  // Filename: bloomiq-invoices-{schoolName-slug}-{YYYY-MM-DD}.csv
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = (school as { name: string }).name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "school";
  const filename = `bloomiq-invoices-${slug}-${stamp}.csv`;

  // CRLF line terminators per RFC-4180.
  const body = rows.join("\r\n") + "\r\n";

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
