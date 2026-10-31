/**
 * Reference codec — compact a record UUID into a provider-safe `reference` and back.
 *
 * Why: a hyphenated UUID is 36 chars (32 hex), but provider reference fields cap at ~30 (Paymetrust 30,
 * Jèko ~30, PI-SPI 35). A UUID is 128 bits = 16 bytes → **base62 = 22 chars**, pure alphanumeric
 * (`0-9A-Za-z`, no `-`/`_` that a provider might reject), fixed-width so leading-zero bytes round-trip
 * losslessly. This keeps the gateway `reference` derivable 1:1 from your order/payout UID with **no
 * new column** on your domain tables — encode on `payIn`/`payOut`, decode on the webhook.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = 62n;
const REF_LENGTH = 22; // ceil(128 / log2(62)) = 22
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Compact a canonical UUID (hyphenated) into a 22-char base62 `reference`. */
export function encodeRef(uuid: string): string {
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) {
    throw new Error(`encodeRef: not a canonical UUID: ${String(uuid)}`);
  }
  const hex = uuid.replace(/-/g, '');
  let n = BigInt('0x' + hex); // 128-bit, big-endian
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % BASE)] + out;
    n = n / BASE;
  }
  return out.padStart(REF_LENGTH, ALPHABET[0]); // left-pad with '0' to fixed width
}

/** Expand a 22-char base62 `reference` back into the canonical UUID it encodes. */
export function decodeRef(ref: string): string {
  if (typeof ref !== 'string' || ref.length !== REF_LENGTH) {
    throw new Error(`decodeRef: expected a ${REF_LENGTH}-char reference, got ${String(ref)}`);
  }
  let n = 0n;
  for (const ch of ref) {
    const d = ALPHABET.indexOf(ch);
    if (d < 0) throw new Error(`decodeRef: invalid base62 char ${JSON.stringify(ch)}`);
    n = n * BASE + BigInt(d);
  }
  let hex = n.toString(16);
  if (hex.length > 32) throw new Error('decodeRef: value exceeds 128 bits');
  hex = hex.padStart(32, '0'); // restore leading-zero bytes
  return (
    hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20, 32)
  );
}

/** True if `ref` is a well-formed 22-char base62 reference. */
export function isRef(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.length === REF_LENGTH && [...ref].every((c) => ALPHABET.includes(c));
}
