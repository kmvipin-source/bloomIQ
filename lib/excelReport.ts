import ExcelJS from "exceljs";

export type SheetSection = {
  /** Sheet name (max 31 chars). */
  name: string;
  /** Optional title row above the table. */
  title?: string;
  /** Optional subtitle / generated-on stamp. */
  subtitle?: string;
  /** Header row labels. */
  headers: string[];
  /** Data rows — same column order as headers. */
  rows: (string | number | null | undefined)[][];
  /** Pixel-ish widths per column. Defaults to auto-fit. */
  widths?: number[];
};

const BRAND_FILL = "FF059669";       // emerald-600
const BRAND_FILL_SOFT = "FFD1FAE5";   // emerald-100
const HEADER_TEXT = "FFFFFFFF";
const SUBTLE = "FFF1F5F9";           // slate-100
const BORDER = "FFE2E8F0";           // slate-200

function autoWidth(headers: string[], rows: (string | number | null | undefined)[][]) {
  return headers.map((h, i) => {
    let max = String(h).length;
    for (const r of rows) {
      const v = r[i];
      const len = v == null ? 0 : String(v).length;
      if (len > max) max = len;
    }
    return Math.min(60, Math.max(10, max + 2));
  });
}

/**
 * Render a single sheet inside the workbook. Title, headers, and zebra
 * banding all get applied here so callers only pass data + headers.
 */
export function addSheet(wb: ExcelJS.Workbook, section: SheetSection): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(section.name.slice(0, 31), {
    views: [{ state: "frozen", ySplit: section.title ? (section.subtitle ? 4 : 3) : 1 }],
  });

  const widths = section.widths ?? autoWidth(section.headers, section.rows);
  ws.columns = widths.map((w) => ({ width: w }));

  let rowIdx = 1;
  if (section.title) {
    const titleRow = ws.getRow(rowIdx++);
    titleRow.getCell(1).value = section.title;
    titleRow.getCell(1).font = { bold: true, size: 16, color: { argb: "FF0F172A" } };
    titleRow.height = 22;
    ws.mergeCells(rowIdx - 1, 1, rowIdx - 1, section.headers.length);
  }
  if (section.subtitle) {
    const subRow = ws.getRow(rowIdx++);
    subRow.getCell(1).value = section.subtitle;
    subRow.getCell(1).font = { italic: true, size: 10, color: { argb: "FF64748B" } };
    ws.mergeCells(rowIdx - 1, 1, rowIdx - 1, section.headers.length);
  }
  if (section.title || section.subtitle) {
    rowIdx++;
  }

  // Header row.
  const headerRow = ws.getRow(rowIdx++);
  section.headers.forEach((h, i) => {
    const c = headerRow.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: HEADER_TEXT }, size: 11 };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND_FILL } };
    c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    c.border = {
      top: { style: "thin", color: { argb: BORDER } },
      bottom: { style: "medium", color: { argb: BRAND_FILL } },
      left: { style: "thin", color: { argb: BORDER } },
      right: { style: "thin", color: { argb: BORDER } },
    };
  });
  headerRow.height = 24;

  // Data rows.
  section.rows.forEach((r, ri) => {
    const dataRow = ws.getRow(rowIdx++);
    r.forEach((v, ci) => {
      const c = dataRow.getCell(ci + 1);
      c.value = v ?? "";
      c.alignment = {
        vertical: "middle",
        horizontal: typeof v === "number" ? "right" : "left",
        wrapText: true,
      };
      c.border = {
        top: { style: "hair", color: { argb: BORDER } },
        bottom: { style: "hair", color: { argb: BORDER } },
        left: { style: "hair", color: { argb: BORDER } },
        right: { style: "hair", color: { argb: BORDER } },
      };
      if (ri % 2 === 1) {
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SUBTLE } };
      }
    });
    dataRow.height = 18;
  });

  // Auto-filter on the header row.
  ws.autoFilter = {
    from: { row: rowIdx - section.rows.length - 1, column: 1 },
    to: { row: rowIdx - 1, column: section.headers.length },
  };

  return ws;
}

/** Convert an array of records to {headers, rows} preserving key order. */
export function recordsToTable<T extends Record<string, unknown>>(records: T[]): { headers: string[]; rows: (string | number | null | undefined)[][] } {
  if (!records.length) return { headers: [], rows: [] };
  const headers = Object.keys(records[0]);
  const rows = records.map((r) => headers.map((h) => {
    const v = r[h];
    if (v == null) return "";
    if (typeof v === "number" || typeof v === "string") return v;
    return String(v);
  }));
  return { headers, rows };
}

export async function downloadWorkbook(wb: ExcelJS.Workbook, filename: string) {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function newWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ZCORIQ";
  wb.created = new Date();
  return wb;
}
