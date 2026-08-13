import { createHmac, timingSafeEqual } from 'crypto';
import { PayInParams, PayInResult, PaymentGateway, PaymentNotConfiguredError } from './payment-gateway';

// PaiementPro's payin-init endpoint differs between environments (host + path). One merchant account;
// the caller's reviewer/demo allow-list decides sandbox per pay-in — there is no global mode flag.
const PAYIN_INIT_URL_PRODUCTION =
  'https://www.paiementpro.net/webservice/onlinepayment/js/initialize/initialize.php';
const PAYIN_INIT_URL_SANDBOX =
  'https://sandbox.paiementpro.net/webservice/onlinepayment/init/curl-init.php';
// ISO-4217 numeric for XOF (FCFA).
const COUNTRY_CURRENCY_CODE_XOF = '952';

/** How to construct a {@link PaiementProGateway}. All fields optional so "unset = disabled" holds. */
export interface PaiementProConfig {
  /** PaiementPro merchant account id (same for sandbox + production). Unset → `initPayin` throws. */
  merchantId?: string;
  /** HMAC secret for the self-signed callback token. Unset → signing disabled (accept-all except prod). */
  secretKey?: string;
  /** When true, `verifyNotification` **fails closed** if no secret is configured (production safety). */
  production?: boolean;
  /** Injectable `fetch` (defaults to the global). Pass a fake in tests / a pinned impl if desired. */
  fetchImpl?: typeof fetch;
  /** Optional error sink (the package logs nothing itself) — wire your framework logger here. */
  logger?: (message: string) => void;
}

/**
 * PaiementPro implementation of {@link PaymentGateway} — the **stateless core** shared by every Nigako
 * `-api`. Rail codes are {@link PaiementProChannel} (provider-specific). Two jobs:
 *
 *  - **Pay-in init** (`initPayin`): POST the order to the env-selected endpoint; PaiementPro returns
 *    `{ url, success }` where `url` is the hosted-payment page the client opens.
 *  - **Callback token** (`signNotificationToken` / `verifyNotification`): the self-signed HMAC token we
 *    embed as a **path segment** of the `notificationURL` we register. Because PaiementPro POSTs the
 *    outcome to the *exact* URL we registered, the echoed token authenticates the callback.
 *
 * Framework-agnostic and side-effect-free beyond the `fetch` call. Settlement, the payment state
 * machine, refunds and disbursement are **per-app** and live in the consuming API, not here.
 */
export class PaiementProGateway implements PaymentGateway {
  private readonly merchantId?: string;
  private readonly secretKey?: string;
  private readonly production: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: (message: string) => void;

  constructor(config: PaiementProConfig = {}) {
    this.merchantId = config.merchantId || undefined;
    this.secretKey = config.secretKey || undefined;
    this.production = config.production ?? false;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.logger = config.logger;
  }

  /** Sandbox vs production endpoint (same merchant id — the reviewer seam is the only selector). */
  resolveInitUrl(useSandbox?: boolean): string {
    return useSandbox ? PAYIN_INIT_URL_SANDBOX : PAYIN_INIT_URL_PRODUCTION;
  }

  /**
   * Initialise a pay-in and return `{ url, success }`. Throws {@link PaymentNotConfiguredError} only
   * when unconfigured (no merchant id); a gateway/transport failure resolves to `{ url: null, success:
   * false }` so the caller always gets a structured outcome.
   */
  async initPayin(params: PayInParams): Promise<PayInResult> {
    if (!this.merchantId) {
      throw new PaymentNotConfiguredError('PaiementPro is not configured (no merchant id).');
    }
    const initUrl = this.resolveInitUrl(params.useSandbox);
    const payload: Record<string, unknown> = {
      initUrl,
      merchantId: this.merchantId,
      amount: params.amount,
      channel: params.channel,
      countryCurrencyCode: COUNTRY_CURRENCY_CODE_XOF,
      description: params.description,
      referenceNumber: params.referenceNumber,
      notificationURL: params.notificationUrl,
      returnURL: params.returnUrl,
    };
    if (params.customerEmail) payload.customerEmail = params.customerEmail;
    if (params.customerFirstName) payload.customerFirstName = params.customerFirstName;
    // Note: PaiementPro spells this `customerLastname` (lowercase 'n').
    if (params.customerLastName) payload.customerLastname = params.customerLastName;
    if (params.customerPhoneNumber) payload.customerPhoneNumber = params.customerPhoneNumber;

    try {
      const res = await this.fetchImpl(initUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const raw = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }
      if (!res.ok || body.success !== true || !body.url) {
        this.logger?.(`PaiementPro init rejected (HTTP ${res.status}): ${raw.slice(0, 500)}`);
        return { url: null, success: false };
      }
      return { url: body.url as string, success: true };
    } catch (err) {
      this.logger?.(`PaiementPro init request error: ${String(err)}`);
      return { url: null, success: false };
    }
  }

  /**
   * The self-signed callback token: `HMAC-SHA256(secretKey, reference)` (hex). Embed it as a path
   * segment of the `notificationURL` you register (`…/notify/{reference}/{token}`). Returns `null` when
   * no secret is configured (signing disabled — local/test); register a plain, unsigned URL then.
   *
   * NB it's an **access gate**, not a content signature — static per order, it does not bind
   * amount/outcome. Keep settlement idempotent (a replay is then a no-op).
   */
  signNotificationToken(reference: string): string | null {
    if (!this.secretKey) return null;
    return createHmac('sha256', this.secretKey).update(reference).digest('hex');
  }

  /**
   * Authenticate a notification callback before any state change.
   * - No secret → **accept-all** (local/test), except **reject in production** (fail-closed).
   * - Secret set → the echoed `token` must be present and equal to `HMAC-SHA256(secret, reference)`;
   *   compared constant-time (`timingSafeEqual`), with a length guard.
   */
  verifyNotification(reference: string, token?: string): boolean {
    if (!this.secretKey) {
      return !this.production;
    }
    if (!token) return false;
    const expected = createHmac('sha256', this.secretKey).update(reference).digest('hex');
    if (token.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  }
}
