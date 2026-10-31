/**
 * PaymetrustGateway — the Paymetrust implementation of the generic {@link PaymentGateway} and, per ledger
 * D5, the SOLE real provider (Paymetrust is settled: usable sandbox + sub-PaiementPro pricing).
 *
 * Responsibilities mirror the nigako-payments doctrine — the gateway does pay-in + payout + status +
 * notification-auth ONLY; the settlement state machine (what a SUCCESS does to an order/wallet) stays
 * PER-APP. Rail: hosted-redirect pay-in (like legacy PaiementPro) + hosted/direct transfer payout.
 *
 * Webhook auth is a PER-TRANSACTION `notify_token` issued at pay-in (NOT a global HMAC): it is surfaced
 * as `PayInResult.providerToken`, persisted by the app, and replayed into `verifyWebhook(..., { token })`.
 *
 * Spec: `pi-spi-workspace/paymetrust-sandbox-spike/COPIED_API_SPEC.md`. Sandbox-pending quirks are flagged
 * inline as `ASSUMPTION(A#)` and tracked in `nigako-meta/GO_LIVE_LEDGER.md` §4 — reconcile when a sandbox
 * account lands (B6). Money is XOF whole francs as `bigint` (never ÷100); the HTTP amount is a JSON number.
 */
import { timingSafeEqual } from 'crypto';
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
  WebhookEvent,
  WebhookExpectation,
} from './types';

/** Countries we map operator codes for today (XOF UEMOA set; CI is the launch country). */
export type PaymetrustCountry = 'CI' | 'BF' | 'ML' | 'SN' | 'TG' | 'BJ' | 'NE';

export interface PaymetrustConfig {
  /** API base incl. version. Default = sandbox. Prod: `https://api.paymetrust.net/v1`. */
  baseUrl?: string;
  /** `api_key` from the dashboard (one account per country). */
  apiKey: string;
  /** `api_password` from the dashboard. */
  apiPassword: string;
  /** The account's country — fixes the operator-code suffix (and is implied by the token). Default `CI`. */
  country?: PaymetrustCountry;
  /** Server-owned webhook URL Paymetrust POSTs the settlement notification to. NEVER taken from a client. */
  notifyUrl: string;
  /** Fail-closed on an unauthenticated webhook when true. */
  production?: boolean;
  /** Injectable fetch (tests / non-global runtimes); falls back to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = 'https://api.sandbox.paymetrust.net/v1';

/**
 * Neutral channel → Paymetrust operator code, keyed by country.
 * ASSUMPTION(A2): CI uses the `_CI`-suffixed codes (`OM_CI`…); the top pay-in doc example shows a bare
 * `OM`, the payment-methods table shows `OM_CI` — we follow the table. DJAMO/CARD/BANK are not Paymetrust
 * mobile-money rails → unmapped (throws).
 */
const CHANNEL_CODES: Record<PaymetrustCountry, Partial<Record<TransactionChannel, string>>> = {
  CI: { ORANGE_MONEY: 'OM_CI', MTN_MOMO: 'MTN_CI', MOOV_MONEY: 'MOOV_CI', WAVE: 'WAVE_CI' },
  BF: { ORANGE_MONEY: 'OM_BF', MOOV_MONEY: 'MOOV_BF', WAVE: 'WAVE_BF' },
  ML: { ORANGE_MONEY: 'OM_ML', MOOV_MONEY: 'MOOV_ML' },
  SN: { ORANGE_MONEY: 'OM_SN', WAVE: 'WAVE_SN' },
  TG: { MOOV_MONEY: 'MOOV_TG' },
  BJ: { MOOV_MONEY: 'MOOV_BJ', MTN_MOMO: 'MTN_BJ' },
  NE: { MOOV_MONEY: 'MOOV_NE' },
};

/**
 * Map Paymetrust `code`/`status` → canonical {@link TransactionStatus}.
 * ASSUMPTION(A4): trust the numeric `code` over `status` (the notification example shows a numeric
 * `status`, while the status-code table uses string `SUCCESS`/`FAILED` — inconsistent). Codes from the
 * spec's status-code table.
 */
function mapStatus(code?: number, status?: string): TransactionStatus {
  switch (code) {
    case 100:
      return 'SUCCEEDED';
    case 2003:
    case 2008:
      return 'EXPIRED';
    case 2315:
      return 'CANCELLED';
    case -1:
    case 2004:
    case 2005:
    case 2010:
    case 2302:
    case 2303:
    case 2306:
    case 2307:
    case 2308:
    case 2309:
    case 2310:
    case 2312:
    case 2313:
    case 2318:
    case 2319:
    case 2321:
      return 'FAILED';
    case 200:
    case 2001:
    case 2002:
      return 'PENDING';
    default:
      break;
  }
  const s = (status ?? '').toUpperCase();
  if (s === 'SUCCESS' || s === 'COMPLETED' || s === 'OK') return 'SUCCEEDED';
  if (s === 'FAILED') return 'FAILED';
  if (s === 'EXPIRED') return 'EXPIRED';
  if (s === 'CANCELLED' || s === 'CANCELED') return 'CANCELLED';
  return 'PENDING';
}

/** Split a single display name into Paymetrust's first/last fields (last falls back to first). */
function splitName(name: string): { client_first_name?: string; client_last_name?: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  const [first, ...rest] = parts;
  return { client_first_name: first, client_last_name: rest.join(' ') || first };
}

/** Constant-time string compare that never throws on a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function assertAmount(amount: bigint): void {
  if (typeof amount !== 'bigint') throw new Error('amount must be a bigint (XOF whole francs)');
  if (amount <= 0n) throw new Error('amount must be a positive XOF bigint');
  // The domain amount is bigint; the HTTP payload is a JSON number — guard the safe-int range.
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('amount exceeds safe integer range');
}

function assertRef(reference: string): void {
  if (typeof reference !== 'string' || reference.length < 1 || reference.length > 30) {
    throw new Error('reference must be 1..30 chars (Paymetrust merchant_transaction_id limit = idempotency key)');
  }
}

interface TokenCache {
  token: string;
  expiresAt: number; // epoch ms
}

export class PaymetrustGateway implements PaymentGateway {
  private tokenCache: TokenCache | null = null;
  private readonly baseUrl: string;
  private readonly country: PaymetrustCountry;
  private readonly doFetch: typeof fetch;

  constructor(private readonly cfg: PaymetrustConfig) {
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.country = cfg.country ?? 'CI';
    // Wrap global fetch so it keeps its `globalThis` receiver (avoids "Illegal invocation").
    this.doFetch = cfg.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  }

  private channelCode(channel: TransactionChannel): string {
    const code = CHANNEL_CODES[this.country]?.[channel];
    if (!code) throw new Error(`Paymetrust: channel ${channel} not available in ${this.country}`);
    return code;
  }

  // ── Auth ────────────────────────────────────────────────────────────────────
  /** Bearer token via POST /oauth/login {api_key, api_password}, cached until ~60s before expiry. */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) return this.tokenCache.token;
    const res = await this.doFetch(`${this.baseUrl}/oauth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ api_key: this.cfg.apiKey, api_password: this.cfg.apiPassword }),
    });
    if (!res.ok) throw new Error(`Paymetrust oauth/login failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    this.tokenCache = { token: json.access_token, expiresAt: now + (json.expires_in ?? 86_400) * 1000 };
    return json.access_token;
  }

  /** Authenticated-request helper (Bearer auth — the only pillar; no x-api-key/mTLS here). */
  private async authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getAccessToken();
    return this.doFetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
  }

  // ── Collection (hosted-redirect pay-in) ───────────────────────────────────────
  async payIn(params: PayInParams): Promise<PayInResult> {
    assertRef(params.reference);
    assertAmount(params.amount);
    const method = this.channelCode(params.channel);
    if (!params.description) throw new Error('description is required (Paymetrust `designation`)');
    const phone = params.payer?.phone;
    if (!phone) throw new Error('payer.phone is required (Paymetrust `client_phone_number`)');

    const payload: Record<string, unknown> = {
      currency: 'XOF',
      payment_method: method,
      merchant_transaction_id: params.reference,
      amount: Number(params.amount),
      lang: 'fr',
      designation: params.description,
      client_phone_number: phone,
      success_url: params.successUrl,
      failed_url: params.failureUrl,
      notify_url: this.cfg.notifyUrl, // server-owned — NEVER taken from the client
      // ASSUMPTION(A6): client_email/first/last are doc-"required"; we send them when present and omit
      // otherwise — the sandbox will confirm whether they are hard-required.
      ...(params.payer?.name ? splitName(params.payer.name) : {}),
      ...(params.payer?.email ? { client_email: params.payer.email } : {}),
    };

    // ASSUMPTION(A1): pay-in path is POST /payment with NO country segment (the account token fixes the
    //   country) — the spike used `/payment/{country}`, likely stale.
    // ASSUMPTION(A3): the separate `channel` field (PUSH/OTP/QRCODE, default PUSH) is omitted for a
    //   standard hosted-redirect pay-in (every doc example omits it despite the table marking it required).
    const res = await this.authedFetch('/payment', { method: 'POST', body: JSON.stringify(payload) });
    const raw = (await res.json().catch(() => ({}))) as {
      code?: number;
      status?: string;
      payment_token?: string;
      transaction_id?: string;
      payment_url?: string;
      notify_token?: string;
    };

    return {
      reference: params.reference,
      providerRef: raw.transaction_id,
      providerToken: raw.notify_token, // ⚠️ persist on the order — verifyWebhook matches against it
      status: mapStatus(raw.code, raw.status),
      redirectUrl: raw.payment_url,
      raw,
    };
  }

  // ── Disbursement (transfer / payout / refund-as-payout) ────────────────────────
  async payOut(params: PayOutParams): Promise<PayOutResult> {
    assertRef(params.reference);
    assertAmount(params.amount);
    const method = this.channelCode(params.channel);
    const phone = params.payee?.phone;
    if (!phone) throw new Error('payee.phone is required (Paymetrust transfer `phone_number`)');

    const payload: Record<string, unknown> = {
      currency: 'XOF',
      merchant_transaction_id: params.reference,
      phone_number: phone,
      amount: Number(params.amount),
      payment_method: method,
      // ASSUMPTION(A8): `reason` is a string (the param table says "Integer" but the examples pass text).
      reason: params.reason ?? 'Transfer',
      notify_url: this.cfg.notifyUrl,
    };
    const res = await this.authedFetch('/transfer', { method: 'POST', body: JSON.stringify(payload) });
    const raw = (await res.json().catch(() => ({}))) as { code?: number; status?: string; transaction_id?: string };
    // ASSUMPTION(A8): a transfer may resolve SYNCHRONOUSLY (code 100 SUCCESS) or return 2002 PENDING +
    //   an async notification — callers must handle both (and always poll getStatus as a fallback).
    return { reference: params.reference, providerRef: raw.transaction_id, status: mapStatus(raw.code, raw.status), raw };
  }

  // ── Status (poll fallback — the webhook is the real signal) ────────────────────
  async getStatus(reference: string, providerRef?: string): Promise<StatusResult> {
    // ASSUMPTION(A1/A5): GET /payment/{handle} accepts payment_token | transaction_id |
    //   merchant_transaction_id; we poll by providerRef when we have it, else by the reference.
    const handle = providerRef ?? reference;
    const res = await this.authedFetch(`/payment/${encodeURIComponent(handle)}`);
    const raw = (await res.json().catch(() => ({}))) as {
      code?: number;
      status?: string;
      payment_status?: string;
      transaction_id?: string;
    };
    return {
      status: mapStatus(raw.code, raw.status ?? raw.payment_status),
      providerRef: raw.transaction_id ?? providerRef,
      raw,
    };
  }

  // ── Notification verification (the proof of payment) ───────────────────────────
  /**
   * Authenticate an inbound Paymetrust notification. Paymetrust POSTs
   * `{ code, status, notify_token, merchant_transaction_id, transaction_id }` on a FINAL status.
   * Authenticity = the inbound `notify_token` equals the one returned at pay-in (stored on the record and
   * passed here as `expected.token`). No expected token ⇒ accept-all in dev, fail-closed in production.
   * Paymetrust has no signature header, so `headers` is unused.
   */
  verifyWebhook(rawBody: string, _headers: Record<string, string | undefined>, expected?: WebhookExpectation): VerifyResult {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return { verified: false };
    }
    if (!expected?.token) {
      if (this.cfg.production) return { verified: false }; // fail-closed in prod without the stored token
      // dev: accept-all (no stored token to match against)
    } else {
      const inbound = body.notify_token;
      if (typeof inbound !== 'string' || !safeEqual(inbound, expected.token)) return { verified: false };
    }
    const event: WebhookEvent = {
      // ASSUMPTION: pay-in vs payout is indistinguishable from the notification body; the app resolves it
      //   from the record its `reference` decodes to. We default to PAYIN.
      kind: 'PAYIN',
      status: mapStatus(
        typeof body.code === 'number' ? body.code : undefined,
        typeof body.status === 'string' ? body.status : undefined,
      ),
      reference: typeof body.merchant_transaction_id === 'string' ? body.merchant_transaction_id : undefined,
      providerRef: typeof body.transaction_id === 'string' ? body.transaction_id : undefined,
      // amount/channel are NOT in the Paymetrust notification — the consumer MUST poll getStatus for the
      // authoritative figures (per the "always reconcile" rule).
      raw: body,
    };
    return { verified: true, event };
  }
}
