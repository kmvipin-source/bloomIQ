/**
 * Generate a 6-character upper-case alphanumeric code for online tests.
 * Avoids visually ambiguous characters (0/O, 1/I/L) so students can read it
 * off a board without confusion.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateOnlineCode(): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}
