/** Generate a random uppercase quiz code, e.g. "K7QX2P". */
export function generateQuizCode(len = 6): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // unambiguous
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function formatSeconds(s: number): string {
  if (s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export function pct(num: number, den: number): number {
  if (!den) return 0;
  return Math.round((num / den) * 100);
}
