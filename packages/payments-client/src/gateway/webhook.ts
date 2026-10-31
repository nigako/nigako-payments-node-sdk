/**
 * Webhook signing + normalization — shared by both ends so they never drift: the signer (fake-api, and
 * one day the real provider adapters' inbound verify) and the verifier (`PaymentGateway.verifyWebhook`).
 *
 * The signature is `HMAC-SHA256(rawBody, secret)` (hex), carried in the `x-nigako-signature` header and
 * computed over the RAW bytes (never the re-serialized JSON). Amounts cross the wire as decimal strings
 * (bigint-safe) and are rehydrated to `Xof` (bigint) in the normalized event.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import type { TransactionChannel, TransactionStatus, WebhookEvent } from './types';
import { TRANSACTION_CHANNELS } from './types';

export const SIGNATURE_HEADER = 'x-nigako-signature';

const STATUSES: readonly TransactionStatus[] = ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'];

/** The on-wire webhook body shape (amounts as decimal strings). */
export interface WebhookBody {
  kind: 'PAYIN' | 'PAYOUT';
  status: TransactionStatus;
  reference: string;
  providerRef?: string;
  amount?: string;
  fees?: string;
  channel?: TransactionChannel;
  occurredAt?: string;
}

/** HMAC-SHA256 hex of the raw body. */
export function signWebhookBody(rawBody: string, secret: string): string {
  if (!secret) throw new Error('signWebhookBody: secret is required');
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** Constant-time signature check. */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/** Serialize a webhook body to the exact JSON string that will be signed + sent. */
export function buildWebhookBody(body: WebhookBody): string {
  if (body.kind !== 'PAYIN' && body.kind !== 'PAYOUT') throw new Error(`invalid kind "${String(body.kind)}"`);
  if (!STATUSES.includes(body.status)) throw new Error(`invalid status "${String(body.status)}"`);
  if (!body.reference) throw new Error('webhook body missing reference');
  return JSON.stringify(body);
}

/**
 * Parse + validate a raw webhook body into a normalized {@link WebhookEvent}. Asserts the required
 * fields (kind, status, reference) and rehydrates amount/fees to bigint. Throws on a malformed body.
 */
export function parseWebhookEvent(rawBody: string): WebhookEvent {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new Error('webhook body is not valid JSON');
  }
  if (o.kind !== 'PAYIN' && o.kind !== 'PAYOUT') throw new Error(`webhook invalid kind "${String(o.kind)}"`);
  if (!STATUSES.includes(o.status as TransactionStatus)) throw new Error(`webhook invalid status "${String(o.status)}"`);
  if (!o.reference || typeof o.reference !== 'string') throw new Error('webhook missing reference');
  const toXof = (v: unknown): bigint | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!/^\d+$/.test(String(v))) throw new Error(`webhook invalid amount "${String(v)}"`);
    return BigInt(String(v));
  };
  const channel =
    o.channel === undefined ? undefined : TRANSACTION_CHANNELS.includes(o.channel as TransactionChannel)
      ? (o.channel as TransactionChannel)
      : (() => { throw new Error(`webhook invalid channel "${String(o.channel)}"`); })();
  return {
    kind: o.kind,
    status: o.status as TransactionStatus,
    reference: o.reference,
    providerRef: typeof o.providerRef === 'string' ? o.providerRef : undefined,
    amount: toXof(o.amount),
    fees: toXof(o.fees),
    channel,
    occurredAt: typeof o.occurredAt === 'string' ? o.occurredAt : undefined,
    raw: o,
  };
}
