/**
 * Redirect-token codec. On `payIn`/`payOut` the FakeGateway mints a signed token carrying everything the
 * fake hosted-page + fake-api need (reference, amount, channel, parties, the product's own webhook URL,
 * return URLs). It rides in the fake `redirectUrl` as `?t=<token>`.
 *
 * Format: `base64url(JSON) + "." + HMAC-SHA256(base64url(JSON), secret)` (hex). The payload segment is
 * readable without the secret (the browser page decodes it to DISPLAY details); `verifyToken` checks the
 * signature **and asserts every required field is present** before anyone acts on it.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { TRANSACTION_CHANNELS, type Party, type TransactionChannel } from './types';

export interface TokenPayload {
  kind: 'PAYIN' | 'PAYOUT';
  reference: string;
  /** XOF whole francs as a decimal string (bigint-safe on the wire). */
  amount: string;
  channel: TransactionChannel;
  /** The product -api's webhook endpoint — where fake-api fires the signed notification. */
  notificationUrl: string;
  successUrl?: string;
  failureUrl?: string;
  description?: string;
  payer?: Party;
  payee?: Party;
  reason?: string;
}

const REQUIRED: readonly (keyof TokenPayload)[] = ['kind', 'reference', 'amount', 'channel', 'notificationUrl'];

function hmacHex(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

/** Assert a decoded object is a well-formed TokenPayload (presence + value validation). Throws if not. */
export function assertTokenPayload(p: unknown): asserts p is TokenPayload {
  if (!p || typeof p !== 'object') throw new Error('token payload is not an object');
  const o = p as Record<string, unknown>;
  for (const k of REQUIRED) {
    if (o[k] === undefined || o[k] === null || o[k] === '') throw new Error(`token payload missing "${k}"`);
  }
  if (o.kind !== 'PAYIN' && o.kind !== 'PAYOUT') throw new Error(`token payload invalid kind "${String(o.kind)}"`);
  if (!TRANSACTION_CHANNELS.includes(o.channel as TransactionChannel)) {
    throw new Error(`token payload invalid channel "${String(o.channel)}"`);
  }
  if (!/^\d+$/.test(String(o.amount))) throw new Error(`token payload invalid amount "${String(o.amount)}"`);
  if (typeof o.notificationUrl !== 'string' || !/^https?:\/\//.test(o.notificationUrl)) {
    throw new Error('token payload notificationUrl must be an http(s) URL');
  }
}

/** Sign a payload into a token. Validates the payload before signing (fail-fast on a bad mint). */
export function signToken(payload: TokenPayload, secret: string): string {
  assertTokenPayload(payload);
  if (!secret) throw new Error('signToken: secret is required');
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmacHex(body, secret)}`;
}

/**
 * Verify a token's signature AND payload. Returns the validated payload, or `null` if the token is
 * malformed, the signature fails, or a required field is missing (fail-closed — never trust a passthrough).
 */
export function verifyToken(token: string | undefined, secret: string): TokenPayload | null {
  if (!token || typeof token !== 'string' || !secret) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmacHex(body, secret);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  try {
    assertTokenPayload(parsed);
  } catch {
    return null;
  }
  return parsed;
}

/**
 * Decode a token's payload **without** verifying the signature — for DISPLAY only (the hosted page).
 * Still asserts the required fields exist (consistency: assert presence even when we only passthrough).
 * Throws on a missing/malformed param so the page can show an explicit error, like a real page would.
 */
export function decodeTokenView(token: string | undefined): TokenPayload {
  if (!token || typeof token !== 'string') throw new Error('missing token');
  const dot = token.lastIndexOf('.');
  if (dot <= 0) throw new Error('malformed token');
  const parsed = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8'));
  assertTokenPayload(parsed);
  return parsed;
}
