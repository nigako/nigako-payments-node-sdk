/**
 * FakeGateway — a provider-shaped stand-in implementing {@link PaymentGateway} with NO real backend and
 * NO money/data cost, as close to a real redirect provider as possible. Selected in dev/QA via the app's
 * provider factory (`PAYMENTS_PROVIDER=fake`); products never know it's fake.
 *
 *  - `payIn`  → mints a signed token, returns a `redirectUrl` to `nigako-pay-fake-web` (the hosted page).
 *  - `payOut` → mints a signed token; a payout has no user redirect, so the resolve link rides in `raw`.
 *  - `getStatus` → polls `nigako-pay-fake-api` (ephemeral in-memory status; PENDING until resolved).
 *  - `verifyWebhook` → the SAME HMAC check a real provider webhook gets (so the product path is exercised).
 *
 * The outcome is chosen by a human clicking a button on the fake page (or a scripted POST to fake-api),
 * which makes fake-api sign + fire the server-to-server webhook back to the product `-api`. Validation is
 * strict at every hop — presence of params/fields is asserted exactly as a live environment would.
 */
import { PaymentNotConfiguredError } from '../payment-gateway';
import { signToken, type TokenPayload } from './token';
import { parseWebhookEvent, SIGNATURE_HEADER, verifyWebhookSignature } from './webhook';
import type {
  PayInParams,
  PayInResult,
  PayOutParams,
  PayOutResult,
  PaymentGateway,
  StatusResult,
  TransactionChannel,
  TransactionStatus,
  VerifyResult,
} from './types';
import { TRANSACTION_CHANNELS } from './types';

export interface FakeGatewayConfig {
  /** Base URL of `nigako-pay-fake-web` (the hosted page). e.g. http://localhost:3022 */
  fakeWebBaseUrl?: string;
  /** Base URL of `nigako-pay-fake-api` (status + fire). e.g. http://localhost:3021 */
  fakeApiBaseUrl?: string;
  /** The product `-api`'s webhook endpoint — where fake-api fires the signed notification. */
  notificationUrl?: string;
  /** Shared dev secret: signs the redirect token AND the outbound webhook (both ends use it). */
  secret?: string;
  /** Fail closed when true and no secret is set (mirrors the other gateways). */
  production?: boolean;
  /** Injectable fetch (tests); resolves `globalThis.fetch` lazily otherwise. */
  fetchImpl?: typeof fetch;
}

function assertChannel(channel: unknown): asserts channel is TransactionChannel {
  if (!TRANSACTION_CHANNELS.includes(channel as TransactionChannel)) {
    throw new Error(`invalid channel "${String(channel)}"`);
  }
}

function assertAmount(amount: unknown): asserts amount is bigint {
  if (typeof amount !== 'bigint') throw new Error('amount must be a bigint (XOF whole francs)');
  if (amount <= 0n) throw new Error('amount must be a positive XOF bigint');
}

function assertRef(reference: unknown): asserts reference is string {
  if (typeof reference !== 'string' || reference.length === 0) throw new Error('reference is required');
}

export class FakeGateway implements PaymentGateway {
  private readonly cfg: FakeGatewayConfig;

  constructor(config: FakeGatewayConfig = {}) {
    this.cfg = config;
  }

  private requireConfig(): Required<Pick<FakeGatewayConfig, 'fakeWebBaseUrl' | 'notificationUrl' | 'secret'>> {
    const { fakeWebBaseUrl, notificationUrl, secret } = this.cfg;
    const missing = [
      !fakeWebBaseUrl && 'fakeWebBaseUrl',
      !notificationUrl && 'notificationUrl',
      !secret && 'secret',
    ].filter(Boolean);
    if (missing.length) {
      throw new PaymentNotConfiguredError(`FakeGateway not configured (missing: ${missing.join(', ')}).`);
    }
    return { fakeWebBaseUrl: fakeWebBaseUrl!, notificationUrl: notificationUrl!, secret: secret! };
  }

  private pageUrl(token: string, base: string): string {
    return `${base.replace(/\/$/, '')}/pay?t=${encodeURIComponent(token)}`;
  }

  async payIn(params: PayInParams): Promise<PayInResult> {
    assertRef(params.reference);
    assertAmount(params.amount);
    assertChannel(params.channel);
    const { fakeWebBaseUrl, notificationUrl, secret } = this.requireConfig();
    const payload: TokenPayload = {
      kind: 'PAYIN',
      reference: params.reference,
      amount: params.amount.toString(),
      channel: params.channel,
      notificationUrl,
      successUrl: params.successUrl,
      failureUrl: params.failureUrl,
      description: params.description,
      payer: params.payer,
    };
    const token = signToken(payload, secret);
    return {
      reference: params.reference,
      status: 'PENDING',
      redirectUrl: this.pageUrl(token, fakeWebBaseUrl),
      raw: { token },
    };
  }

  async payOut(params: PayOutParams): Promise<PayOutResult> {
    assertRef(params.reference);
    assertAmount(params.amount);
    assertChannel(params.channel);
    if (!params.payee || (!params.payee.phone && !params.payee.alias)) {
      throw new Error('payOut requires a payee (phone or alias)');
    }
    const { fakeWebBaseUrl, notificationUrl, secret } = this.requireConfig();
    const payload: TokenPayload = {
      kind: 'PAYOUT',
      reference: params.reference,
      amount: params.amount.toString(),
      channel: params.channel,
      notificationUrl,
      payee: params.payee,
      reason: params.reason,
    };
    const token = signToken(payload, secret);
    // A payout has no payer-facing redirect; expose a resolve link (for a tester) in raw.
    return {
      reference: params.reference,
      status: 'PENDING',
      raw: { token, resolveUrl: this.pageUrl(token, fakeWebBaseUrl) },
    };
  }

  async getStatus(reference: string, providerRef?: string): Promise<StatusResult> {
    assertRef(reference);
    if (!this.cfg.fakeApiBaseUrl) {
      throw new PaymentNotConfiguredError('FakeGateway.getStatus needs fakeApiBaseUrl.');
    }
    const doFetch = this.cfg.fetchImpl ?? globalThis.fetch;
    const url = `${this.cfg.fakeApiBaseUrl.replace(/\/$/, '')}/status/${encodeURIComponent(reference)}`;
    try {
      const res = await doFetch(url, { headers: { Accept: 'application/json' } });
      const raw = (await res.json().catch(() => ({}))) as { status?: TransactionStatus };
      return { status: raw.status ?? 'PENDING', providerRef, raw };
    } catch (err) {
      // Unknown ⇒ still pending (consistent with a real poll that hasn't settled).
      return { status: 'PENDING', providerRef, raw: { error: String(err) } };
    }
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): VerifyResult {
    const lower: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(headers ?? {})) lower[k.toLowerCase()] = v;
    const signature = lower[SIGNATURE_HEADER];
    const secret = this.cfg.secret;
    if (!secret) {
      // No secret: accept-all in dev, fail-closed in production (same policy as the other gateways).
      if (this.cfg.production) return { verified: false };
      return { verified: true, event: parseWebhookEvent(rawBody) };
    }
    if (!verifyWebhookSignature(rawBody, signature, secret)) return { verified: false };
    return { verified: true, event: parseWebhookEvent(rawBody) };
  }
}
