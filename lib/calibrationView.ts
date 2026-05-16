// ZCORIQ — Client-safe interpretation helpers for question calibration.
// These are the SAME thresholds as lib/calibration.ts but live in their own
// file so the bank UI (a client component) can import them without dragging
// supabaseAdmin into the browser bundle.

export function interpretDifficulty(d: number | null | undefined): "easy" | "medium" | "hard" | "unknown" {
  if (d === null || d === undefined || Number.isNaN(d)) return "unknown";
  if (d >= 0.75) return "easy";
  if (d >= 0.40) return "medium";
  return "hard";
}

export function interpretDiscrimination(r: number | null | undefined): "good" | "weak" | "broken" | "unknown" {
  if (r === null || r === undefined || Number.isNaN(r)) return "unknown";
  if (r >= 0.30) return "good";
  if (r >= 0.10) return "weak";
  return "broken";
}

export const MIN_CALIBRATION_ATTEMPTS = 20;

// Render-friendly meta for difficulty badge.
export function difficultyBadgeMeta(d: number | null | undefined): {
  label: string;
  className: string;
} | null {
  const cat = interpretDifficulty(d);
  if (cat === "unknown") return null;
  if (cat === "easy") {
    return { label: "Easy", className: "bg-emerald-100 text-emerald-800 border border-emerald-300" };
  }
  if (cat === "medium") {
    return { label: "Medium", className: "bg-amber-100 text-amber-800 border border-amber-300" };
  }
  return { label: "Hard", className: "bg-red-100 text-red-800 border border-red-300" };
}

// Render-friendly meta for discrimination badge. We use plain icon characters
// rather than lucide icons so this stays a pure value module.
export function discriminationBadgeMeta(r: number | null | undefined): {
  label: string;
  icon: string;
  className: string;
} | null {
  const cat = interpretDiscrimination(r);
  if (cat === "unknown") return null;
  if (cat === "good") {
    return { label: "Good", icon: "OK", className: "bg-emerald-100 text-emerald-800 border border-emerald-300" };
  }
  if (cat === "weak") {
    return { label: "Weak", icon: "!", className: "bg-amber-100 text-amber-800 border border-amber-300" };
  }
  return { label: "Broken", icon: "X", className: "bg-red-100 text-red-800 border border-red-300" };
}

// "2 days ago" / "just now" — small dependency-free formatter for tooltip.
export function relativeFromNow(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diffMs = Date.now() - t;
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 45) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const yr = Math.round(mo / 12);
  return `${yr} year${yr === 1 ? "" : "s"} ago`;
}
