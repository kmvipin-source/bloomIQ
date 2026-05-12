/** Generate a random uppercase quiz code, e.g. "K7QX2P".
 *
 * Uses Web Crypto when available (browser + Node 19+) so the codes
 * are non-predictable; falls back to Math.random in old runtimes.
 * Codes are 6 chars × 31 symbols ≈ 887M values — enough that an
 * attacker can't easily enumerate, but only if the source is strong.
 */
export function generateQuizCode(len = 6): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // unambiguous
  let out = "";
  const g = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (g?.getRandomValues) {
    const buf = new Uint32Array(len);
    g.getRandomValues(buf);
    for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
    return out;
  }
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
