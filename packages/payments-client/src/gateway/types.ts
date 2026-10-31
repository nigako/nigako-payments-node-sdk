/**
 * Next-generation, provider-agnostic payment-gateway contract (`@nigako/payments-client/gateway`).
 *
 * Status (2026-10-31): FINALIZED against the chosen provider **Paymetrust** — the sole real
 * implementation (see `PaymetrustGateway`). Paymetrust is settled for its usable sandbox + sub-PaiementPro
 * pricing (ledger D5). The remaining unknowns are sandbox-pending quirks tracked as assumptions A1–A8 in
 * `nigako-meta/GO_LIVE_LEDGER.md` §4 — they affect the adapter's wire-mapping, not these neutral shapes.
 * The standalone FakeGateway emulator is REDUNDANT (ledger D5); the in-process `FakeGateway` class remains
 * only as a consumer-side test double. See this package's GATEWAY.md + pi-spi DECISION-LOG.
 *
 * This supersedes the legacy `PaymentGateway` (initPayin / signNotificationToken / verifyNotification)
 * that PaiementPro implements — it is introduced on a **separate subpath** so existing consumers keep
 * working while providers migrate. Design rationale + the full decision trail live in
 * `pi-spi-workspace` (DECISION-LOG / PISPI-ADAPTER) and in this package's `GATEWAY.md`.
 *
 * Four operations every provider implements: `payIn` (collect), `payOut` (disburse — a refund is a
 * payout to the original payer), `getStatus` (poll — ALWAYS run as a reconciliation fallback, some
 * providers send no webhook on failure), and `verifyWebhook` (authenticate + normalize a notification).
 *
 * Money is **XOF whole francs as `bigint`** — never ÷100 in the domain; adapters handle any provider
 * minor-unit quirk (e.g. Jèko's ×100) at their own wire boundary.
 */

/** XOF whole francs. Integer, bigint, never divided by 100 in the domain. */
export type Xof = bigint;

/** Canonical lifecycle status, mapped by each adapter from its provider's vocabulary. */
export type TransactionStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';

/**
 * Neutral payment rail. Closed enum (string-literal union); each adapter maps it to its own code
 * (e.g. `ORANGE_MONEY` → PaiementPro `OMCIV2` / Paymetrust `OM_CI` / Jèko `orange`). Country is context
 * (the provider account), not part of the channel. Adding an operator = an enum addition + an SDK release.
 */
export type TransactionChannel =
  | 'ORANGE_MONEY'
  | 'MTN_MOMO'
  | 'MOOV_MONEY'
  | 'WAVE'
  | 'DJAMO'
  | 'CARD'
  | 'BANK';

/** All channel values, for runtime validation / UI iteration. */
export const TRANSACTION_CHANNELS: readonly TransactionChannel[] = [
  'ORANGE_MONEY',
  'MTN_MOMO',
  'MOOV_MONEY',
  'WAVE',
  'DJAMO',
  'CARD',
  'BANK',
];

/** A payer or payee identity. Which fields matter is provider/rail-dependent. */
export interface Party {
  phone?: string;
  alias?: string;
  name?: string;
  email?: string;
}

/**
 * Start a collection (pull money from a payer).
 * `reference` is the caller's idempotency + correlation key — the compacted record UUID
 * (`encodeRef(order.uid)`, 22 chars). The provider echoes it back on the webhook; the app decodes it
 * (`decodeRef`) to recover the order. No gateway-specific column on your domain tables.
 */
export interface PayInParams {
  reference: string;
  amount: Xof;
  channel: TransactionChannel;
  payer?: Party;
  /** Redirect providers send the browser/webview here after the outcome (may be app deep-links). */
  successUrl?: string;
  failureUrl?: string;
  description?: string;
}

/** Reply to `payIn`. `redirectUrl` present for redirect providers; `qr` present for QR mode. */
export interface PayInResult {
  reference: string;
  providerRef?: string;
  /**
   * A per-transaction secret the PROVIDER issues at pay-in that authenticates its later webhook
   * (Paymetrust's `notify_token`). The app MUST persist it on the record and pass it back as
   * `verifyWebhook(..., { token })`. Absent for providers that sign webhooks with a global HMAC.
   */
  providerToken?: string;
  status: TransactionStatus;
  redirectUrl?: string;
  qr?: string;
  raw: unknown;
}

/**
 * Push money to a payee (disburse). A **refund is a payout to the original payer** for an app-decided
 * amount (e.g. collected − withheld fee) — NOT a provider reversal. The gateway is stateless, so the
 * APP resolves the payee + amount (it holds the payin record) and calls this; the gateway only executes.
 * `reference` is the payout record's own compacted UUID (distinct from the payin's).
 */
export interface PayOutParams {
  reference: string;
  amount: Xof;
  channel: TransactionChannel;
  payee: Party;
  reason?: string;
}

/** Reply to `payOut`. */
export interface PayOutResult {
  reference: string;
  providerRef?: string;
  status: TransactionStatus;
  raw: unknown;
}

/** Reply to `getStatus`. */
export interface StatusResult {
  status: TransactionStatus;
  providerRef?: string;
  raw: unknown;
}

/**
 * Normalized inbound notification — the product NEVER parses provider JSON. `kind` tells the app which
 * record the `reference` decodes into (an order for PAYIN, a payout record for PAYOUT).
 */
export interface WebhookEvent {
  kind: 'PAYIN' | 'PAYOUT';
  status: TransactionStatus;
  reference?: string;
  providerRef?: string;
  amount?: Xof;
  fees?: Xof;
  channel?: TransactionChannel;
  occurredAt?: string;
  raw: unknown;
}

/** Result of `verifyWebhook`: fail-closed on a bad signature, else the normalized event. */
export type VerifyResult = { verified: false } | { verified: true; event: WebhookEvent };

/**
 * Optional per-transaction context for {@link PaymentGateway.verifyWebhook}. Providers that authenticate
 * a webhook with a global HMAC (over the raw body) ignore it; providers that issue a PER-TRANSACTION
 * token at pay-in (Paymetrust's `notify_token`, returned as `PayInResult.providerToken`) require the
 * stored token here — load it from the record the webhook's `reference` decodes to. Absent + production ⇒
 * fail-closed.
 */
export interface WebhookExpectation {
  token?: string;
}

/**
 * What every next-gen payment provider implements.
 *
 * Rule for consumers (replaces a per-provider "webhookOnFailure" flag): **always run a reconciliation
 * poll / pending-timeout via `getStatus` — never rely on the webhook alone** (some providers, e.g. Jèko,
 * send no webhook on a failed pay-in).
 */
export interface PaymentGateway {
  payIn(params: PayInParams): Promise<PayInResult>;
  payOut(params: PayOutParams): Promise<PayOutResult>;
  getStatus(reference: string, providerRef?: string): Promise<StatusResult>;
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    expected?: WebhookExpectation,
  ): VerifyResult;
}
