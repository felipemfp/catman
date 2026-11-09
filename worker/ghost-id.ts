// Kept out of index.ts: workerd treats every named export of the main module as an entrypoint.
export const TTL_SECONDS = 2592000; // 30 days
const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 8-char base62 from crypto.getRandomValues with rejection sampling (no modulo bias). */
export function newGhostId(): string {
  let out = '';
  const buf = new Uint8Array(16);
  while (out.length < 8) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 248 && out.length < 8) out += ID_ALPHABET[b % 62];
    }
  }
  return out;
}
