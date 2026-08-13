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
 * What the caller hands `initPayin`. Customer fields are pre-formatted by the caller (name split, phone
 * `+`→`00`); empty optionals are omitted from the request. `amount` is XOF whole francs.
 */
export interface PaiementProInitParams {
  amount: number;
  /** Mobile-money rail (see `PaiementProChannel`). */
  channel: string;
  description: string;
  /** The caller's order/booking **uid** — echoed back on the notification. */
  referenceNumber: string;
  /** The caller's authoritative server-to-server settlement URL (with the signed callback token). */
  notificationUrl: string;
  /** Where PaiementPro redirects the user's browser after payment (cosmetic; not the settlement path). */
  returnUrl: string;
  customerEmail?: string | null;
  customerFirstName?: string | null;
  customerLastName?: string | null;
  customerPhoneNumber?: string | null;
  /** Route this single pay-in to the PaiementPro **sandbox** endpoint (same merchant id, test mode). */
  useSandbox?: boolean;
}

/** The pay-in init reply. `url` is the hosted-payment page the client opens; `null` when init failed. */
export interface PaiementProInitResult {
  url: string | null;
  success: boolean;
}

/** Thrown by `initPayin` when the gateway has no merchant id (map to a 503 in your API). */
export class PaiementProNotConfiguredError extends Error {
  constructor(message = 'PaiementPro is not configured (no merchant id).') {
    super(message);
    this.name = 'PaiementProNotConfiguredError';
  }
}
