/**
 * The **generic**, provider-agnostic payment-gateway contract. PaiementPro is the current
 * implementation ({@link PaiementProGateway}); another aggregator would implement this **same**
 * interface with its **own** rail codes — so `channel` is an opaque `string` here, never a fixed enum.
 * Money is XOF whole francs.
 */
export interface PayInParams {
  amount: number;
  /** The provider's mobile-money rail code (e.g. a `PaiementProChannel` value) — opaque to this layer. */
  channel: string;
  description: string;
  /** The caller's order/booking **uid** — echoed back on the notification. */
  referenceNumber: string;
  /** The caller's authoritative server-to-server settlement URL (with the signed callback token). */
  notificationUrl: string;
  /** Where the provider redirects the user's browser after payment (cosmetic; not the settlement path). */
  returnUrl: string;
  customerEmail?: string | null;
  customerFirstName?: string | null;
  customerLastName?: string | null;
  customerPhoneNumber?: string | null;
  /** Route this single pay-in to the provider's **sandbox** endpoint (test mode). */
  useSandbox?: boolean;
}

/** The pay-in init reply. `url` is the hosted-payment page the client opens; `null` when init failed. */
export interface PayInResult {
  url: string | null;
  success: boolean;
  /** The provider's own reference for this pay-in (PaiementPro's `sessionId`), when it returns one —
   * useful to persist as a gateway ref. Optional and absent on failure; ignore it if you don't need it. */
  providerReference?: string;
}

/**
 * What every payment provider implements. The self-signed **callback token** (path-segment HMAC) is the
 * portable way we authenticate a provider's server-to-server notification — the *only* proof of payment.
 */
export interface PaymentGateway {
  initPayin(params: PayInParams): Promise<PayInResult>;
  signNotificationToken(reference: string): string | null;
  verifyNotification(reference: string, token?: string): boolean;
}

/** Thrown by `initPayin` when the gateway has no credentials configured (map to a 503 in your API). */
export class PaymentNotConfiguredError extends Error {
  constructor(message = 'Payment gateway is not configured.') {
    super(message);
    this.name = 'PaymentNotConfiguredError';
  }
}
