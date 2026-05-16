import { NextResponse } from "next/server";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";

export const runtime = "nodejs";

/**
 * GET /api/admin/subscriptions/[id]/invoice
 *
 * Generates a GST-compliant Indian tax invoice PDF for the given
 * subscription. Used by the platform admin for B2B school deals where
 * the school pays via NEFT against an invoice rather than self-serve
 * Razorpay.
 *
 * Vendor details (ZCORIQ's own GSTIN, address, bank account) come
 * from env vars. Customer details come from the school row. Line item
 * uses subscription.override_price_paise if set, otherwise computes
 * plans.per_student_price_paise × current student count.
 *
 * Auth: platform admin only.
 *
 * Required env vars:
 *   INVOICE_VENDOR_NAME      e.g. "ZCORIQ Pvt Ltd"
 *   INVOICE_VENDOR_GSTIN     e.g. "27AAACB1234F1Z5"
 *   INVOICE_VENDOR_ADDRESS   multi-line, \n-separated
 *   INVOICE_VENDOR_STATE     e.g. "Maharashtra" (for IGST vs CGST+SGST split)
 *   INVOICE_BANK_NAME, INVOICE_BANK_ACCOUNT, INVOICE_BANK_IFSC
 *
 * GST rate is 18% on SaaS in India. Split as 9% CGST + 9% SGST when
 * vendor and customer are in the same state; otherwise 18% IGST. We
 * only have the school's name, not address/state, so for now we
 * default to IGST. A future migration can add school.state and
 * school.gstin for proper tax determination.
 */

type RouteContext = { params: Promise<{ id: string }> };

const GST_RATE = 0.18;

function rs(paise: number): string {
  return (paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    // F171 fix (QA): inline platform_admin check → shared helper.
    // F22 single-session iat enforcement comes along for free.
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;

    const { id: subscriptionId } = await ctx.params;
    const admin = supabaseAdmin();

    type SubRow = {
      id: string;
      plan_id: string | null;
      school_id: string | null;
      expires_at: string | null;
      override_price_paise: number | null;
      invoice_number: string | null;
      payment_received_at: string | null;
      contracted_students: number | null;
    };
    const { data: subRaw } = await admin
      .from("subscriptions")
      .select("id, plan_id, school_id, expires_at, override_price_paise, invoice_number, payment_received_at, contracted_students")
      .eq("id", subscriptionId)
      .maybeSingle();
    const sub = (subRaw as unknown as SubRow | null) ?? null;
    if (!sub || !sub.school_id) {
      return NextResponse.json({ error: "Subscription not found or not school-bound" }, { status: 404 });
    }

    const { data: school } = await admin
      .from("schools")
      .select("id, name, state, gstin")
      .eq("id", sub.school_id)
      .single();
    if (!school) return NextResponse.json({ error: "School not found" }, { status: 404 });

    // D12: school is interstate (vs vendor) → IGST 18%. Same state → CGST+SGST 9%+9%.
    // schools.state may be null for legacy rows; fall back to IGST (the safer
    // default — if same-state should have been used, the school will catch it
    // on the invoice and we issue a corrective).
    const schoolStateRaw = (school as { state?: string | null }).state || null;
    const schoolGstin = (school as { gstin?: string | null }).gstin || null;
    const sameState =
      schoolStateRaw !== null &&
      schoolStateRaw.trim().toLowerCase() ===
        (process.env.INVOICE_VENDOR_STATE || "Karnataka").trim().toLowerCase();

    type PlanRow = { label: string | null; per_student_price_paise: number | null; period_days: number | null };
    let plan: PlanRow | null = null;
    if (sub.plan_id) {
      const { data: p } = await admin
        .from("plans")
        .select("label, per_student_price_paise, period_days")
        .eq("id", sub.plan_id)
        .maybeSingle();
      plan = (p as unknown as PlanRow | null) ?? null;
    }

    // Actual signed-in student count (used as a fallback when no
    // contracted_students is set — matches old behavior). Contracted
    // takes precedence: that's the seat count the school agreed to.
    const { count: actualStudents } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("school_id", sub.school_id)
      .eq("role", "student");
    const seatCount = sub.contracted_students ?? actualStudents ?? 0;

    // Determine the line-item amount: override beats formula.
    const computedPaise = (plan?.per_student_price_paise ?? 0) * seatCount;
    const subtotalPaise = sub.override_price_paise ?? computedPaise;
    if (subtotalPaise <= 0) {
      return NextResponse.json(
        { error: "Cannot generate invoice: no plan price or override set." },
        { status: 400 }
      );
    }

    // GST math.
    const taxPaise = Math.round(subtotalPaise * GST_RATE);
    const totalPaise = subtotalPaise + taxPaise;

    // Vendor details from env. Fail loudly with a 500 if mis-configured
    // so the admin sees the gap rather than a half-baked PDF.
    const vendorName    = process.env.INVOICE_VENDOR_NAME;
    const vendorGSTIN   = process.env.INVOICE_VENDOR_GSTIN;
    const vendorAddress = process.env.INVOICE_VENDOR_ADDRESS;
    const vendorState   = process.env.INVOICE_VENDOR_STATE || "Karnataka";
    const bankName      = process.env.INVOICE_BANK_NAME;
    const bankAccount   = process.env.INVOICE_BANK_ACCOUNT;
    const bankIFSC      = process.env.INVOICE_BANK_IFSC;
    if (!vendorName || !vendorGSTIN || !vendorAddress || !bankName || !bankAccount || !bankIFSC) {
      return NextResponse.json(
        {
          error: "Invoice vendor details not configured. Set INVOICE_VENDOR_NAME, INVOICE_VENDOR_GSTIN, INVOICE_VENDOR_ADDRESS, INVOICE_BANK_NAME, INVOICE_BANK_ACCOUNT, INVOICE_BANK_IFSC in .env.local.",
        },
        { status: 500 }
      );
    }

    // Generate or reuse invoice number. If one isn't on the row yet,
    // create a stable BLM/YYYY/NNNN number and persist it so re-fetches
    // show the same number.
    //
    // Numbering correctness:
    //   - Counts BOTH live subscriptions AND archived invoices for the
    //     year. start_renewal nulls the live invoice_number after
    //     copying the cycle into subscription_invoice_archive, so a
    //     count of the live table alone would reset to 1 and produce
    //     a duplicate (GST-illegal).
    //   - Wrapped in a retry loop that catches Postgres unique-violation
    //     (code 23505 on subscriptions_invoice_number_key from
    //     migration 62) for the case where two admins generate invoices
    //     in the same second.
    let invoiceNumber = sub.invoice_number;
    if (!invoiceNumber) {
      const year = new Date().getFullYear();
      const prefix = `BLM/${year}/`;
      // Parse-and-max-plus-one: matches mark-paid's allocator. A pure
      // count+1 over both tables drifts when archived rows have been
      // hard-deleted, when a stub row was created without an
      // invoice_number, or when the live row was renumbered manually —
      // any of those produces a count lower than the true high-water
      // mark and a colliding allocation. Parsing the suffix is the
      // only correct read.
      const re = new RegExp(`^BLM/${year}/(\\d+)$`);
      const collected: number[] = [];
      const [{ data: liveRows }, { data: archRows }] = await Promise.all([
        admin.from("subscriptions").select("invoice_number").ilike("invoice_number", `${prefix}%`),
        admin.from("subscription_invoice_archive").select("invoice_number").ilike("invoice_number", `${prefix}%`),
      ]);
      for (const r of [...(liveRows ?? []), ...(archRows ?? [])]) {
        const inv = (r as { invoice_number: string | null }).invoice_number;
        const m = inv ? re.exec(inv) : null;
        if (m) collected.push(parseInt(m[1], 10));
      }
      let nextSeq = (collected.length > 0 ? Math.max(...collected) : 0) + 1;
      let assigned: string | null = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = `BLM/${year}/${String(nextSeq).padStart(4, "0")}`;
        const { error: updErr } = await admin
          .from("subscriptions")
          .update({ invoice_number: candidate })
          .eq("id", subscriptionId);
        if (!updErr) { assigned = candidate; break; }
        // Postgres unique-violation. Bump and retry.
        const code = (updErr as { code?: string }).code;
        if (code !== "23505") {
          return NextResponse.json({ error: `Could not allocate invoice number: ${updErr.message}` }, { status: 500 });
        }
        nextSeq += 1;
      }
      if (!assigned) {
        return NextResponse.json({ error: "Could not allocate a unique invoice number after 10 attempts." }, { status: 500 });
      }
      invoiceNumber = assigned;
    }

    const issuedOn = new Date().toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
    const dueOn = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toLocaleDateString("en-IN", {
      year: "numeric", month: "short", day: "numeric",
    });

    // ── Build the PDF ──
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();

    doc.setFontSize(20);
    doc.setFont("helvetica", "bold");
    doc.text("TAX INVOICE", pageWidth / 2, 18, { align: "center" });

    // Vendor block — top left
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text(vendorName, 14, 32);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const vendorLines = vendorAddress.split(/\\n|\n/);
    let y = 38;
    for (const line of vendorLines) {
      doc.text(line, 14, y);
      y += 4;
    }
    doc.text(`GSTIN: ${vendorGSTIN}`, 14, y);
    doc.text(`State: ${vendorState}`, 14, y + 4);

    // Invoice meta — top right
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(`Invoice #: ${invoiceNumber}`, pageWidth - 14, 32, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(`Issued: ${issuedOn}`, pageWidth - 14, 38, { align: "right" });
    doc.text(`Due: ${dueOn}`, pageWidth - 14, 42, { align: "right" });

    // Bill-to block
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("Bill to:", 14, y + 16);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text(school.name, 14, y + 22);
    doc.setFontSize(9);
    let billY = y + 27;
    if (schoolStateRaw) {
      doc.text(`State: ${schoolStateRaw}`, 14, billY);
      billY += 4;
    }
    if (schoolGstin) {
      doc.text(`GSTIN: ${schoolGstin}`, 14, billY);
      billY += 4;
    }
    if (!schoolStateRaw || !schoolGstin) {
      doc.setTextColor(120);
      doc.text(
        "(" + [!schoolStateRaw && "state", !schoolGstin && "GSTIN"].filter(Boolean).join(" and ") + " missing — please add via /admin/schools)",
        14, billY
      );
      doc.setTextColor(0);
    }

    // Line item table — uses jspdf-autotable for a clean grid.
    // Skip the seat tail when there's no real seat number to print —
    // either a brand-new school with no contracted seats and no signups
    // yet, or an override-only deal where the seat count isn't part of
    // the line item.
    const hasSeatNumber = seatCount > 0;
    const seatLabel = hasSeatNumber
      ? (sub.contracted_students != null ? `${seatCount} contracted seats` : `${seatCount} students`)
      : null;
    const planLabel = plan?.label || "ZCORIQ subscription";
    const lineDescription = sub.override_price_paise
      ? (seatLabel ? `${planLabel} — annual subscription, ${seatLabel} (negotiated rate)` : `${planLabel} — annual subscription (negotiated rate)`)
      : (seatLabel ? `${planLabel} — ${seatLabel} × ₹${rs((plan?.per_student_price_paise ?? 0))}` : `${planLabel} — annual subscription`);

    autoTable(doc, {
      startY: y + 38,
      head: [["#", "Description", "HSN/SAC", "Amount (₹)"]],
      body: [
        ["1", lineDescription, "998313", rs(subtotalPaise)],
      ],
      headStyles: { fillColor: [4, 120, 87], textColor: 255 },
      styles: { fontSize: 9 },
      columnStyles: { 3: { halign: "right" } },
    });

    // Tax + totals — right-aligned summary block.
    const finalY = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 100;
    let ty = finalY + 8;
    const totalsX = pageWidth - 14;
    const labelX = pageWidth - 70;
    doc.setFontSize(10);
    doc.text("Subtotal", labelX, ty);
    doc.text(`₹${rs(subtotalPaise)}`, totalsX, ty, { align: "right" });
    ty += 6;
    if (sameState) {
      // D12: same-state — split into CGST + SGST at 9% each.
      const halfPaise = Math.round(taxPaise / 2);
      doc.text("CGST @ 9%", labelX, ty);
      doc.text(`₹${rs(halfPaise)}`, totalsX, ty, { align: "right" });
      ty += 6;
      doc.text("SGST @ 9%", labelX, ty);
      doc.text(`₹${rs(taxPaise - halfPaise)}`, totalsX, ty, { align: "right" });
      ty += 8;
    } else {
      // Interstate or state unknown → IGST 18% (safer default; corrective
      // issued if school flags same-state and we get state filled in later).
      doc.text("IGST @ 18%", labelX, ty);
      doc.text(`₹${rs(taxPaise)}`, totalsX, ty, { align: "right" });
      ty += 8;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Total payable", labelX, ty);
    doc.text(`₹${rs(totalPaise)}`, totalsX, ty, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);

    // Payment instructions block.
    ty += 16;
    doc.setFont("helvetica", "bold");
    doc.text("Payment instructions", 14, ty);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    ty += 6;
    doc.text(`Bank: ${bankName}`, 14, ty);
    ty += 4;
    doc.text(`A/C No: ${bankAccount}`, 14, ty);
    ty += 4;
    doc.text(`IFSC: ${bankIFSC}`, 14, ty);
    ty += 4;
    doc.text(`Reference (mandatory): ${invoiceNumber}`, 14, ty);
    ty += 8;
    doc.setTextColor(120);
    doc.text(
      "Subject to the jurisdiction of the courts of " + vendorState + ". E. & O. E.",
      14,
      ty
    );
    doc.setTextColor(0);

    // Signature box, bottom right.
    const sigY = doc.internal.pageSize.getHeight() - 30;
    doc.setFontSize(9);
    doc.text("Authorised signatory", pageWidth - 14, sigY, { align: "right" });
    doc.setDrawColor(180);
    doc.line(pageWidth - 60, sigY - 3, pageWidth - 14, sigY - 3);

    const arrayBuffer = doc.output("arraybuffer");
    return new NextResponse(arrayBuffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${invoiceNumber.replace(/\//g, "-")}.pdf"`,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Invoice generation failed" },
      { status: 500 }
    );
  }
}
