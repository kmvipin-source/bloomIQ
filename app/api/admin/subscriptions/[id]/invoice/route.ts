import { NextResponse } from "next/server";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/admin/subscriptions/[id]/invoice
 *
 * Generates a GST-compliant Indian tax invoice PDF for the given
 * subscription. Used by the platform admin for B2B school deals where
 * the school pays via NEFT against an invoice rather than self-serve
 * Razorpay.
 *
 * Vendor details (BloomIQ's own GSTIN, address, bank account) come
 * from env vars. Customer details come from the school row. Line item
 * uses subscription.override_price_paise if set, otherwise computes
 * plans.per_student_price_paise × current student count.
 *
 * Auth: platform admin only.
 *
 * Required env vars:
 *   INVOICE_VENDOR_NAME      e.g. "BloomIQ Pvt Ltd"
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
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: me } = await sb
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .single();
    if (!me?.platform_admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
      .select("id, name")
      .eq("id", sub.school_id)
      .single();
    if (!school) return NextResponse.json({ error: "School not found" }, { status: 404 });

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
    let invoiceNumber = sub.invoice_number;
    if (!invoiceNumber) {
      const year = new Date().getFullYear();
      const { count: priorCount } = await admin
        .from("subscriptions")
        .select("id", { count: "exact", head: true })
        .like("invoice_number", `BLM/${year}/%`);
      const seq = String((priorCount ?? 0) + 1).padStart(4, "0");
      invoiceNumber = `BLM/${year}/${seq}`;
      await admin.from("subscriptions").update({ invoice_number: invoiceNumber }).eq("id", subscriptionId);
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
    // Note: school address + GSTIN aren't stored yet — call this out so
    // finance knows to fill them in manually before sending.
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text("(School address + GSTIN to be added manually if applicable)", 14, y + 27);
    doc.setTextColor(0);

    // Line item table — uses jspdf-autotable for a clean grid.
    const seatLabel = sub.contracted_students != null
      ? `${seatCount} contracted seats`
      : `${seatCount} students`;
    const lineDescription = sub.override_price_paise
      ? `${plan?.label || "BloomIQ subscription"} — annual subscription, ${seatLabel} (negotiated rate)`
      : `${plan?.label || "BloomIQ subscription"} — ${seatLabel} × ₹${rs((plan?.per_student_price_paise ?? 0))}`;

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
    // Default to IGST since we don't have customer state. A future
    // school.state field would let us split into CGST + SGST.
    doc.text("IGST @ 18%", labelX, ty);
    doc.text(`₹${rs(taxPaise)}`, totalsX, ty, { align: "right" });
    ty += 8;
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
