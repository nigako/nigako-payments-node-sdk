# @nigako/payments-client

The stateless **PaiementPro** core shared by every Nigako `-api` — pay-in init + the self-signed
callback token. Framework-agnostic (no NestJS), XOF. Refund / disbursement / wallet and the payment
**state machine** are **per-app** and are *not* in this package. See the **`nigako-payments` skill`**.

> **New (v0.3): the provider-agnostic gateway contract** — `payIn` / `payOut` / `getStatus` /
> `verifyWebhook`, canonical `TransactionStatus`/`TransactionChannel`, `bigint` XOF, base62 `reference`
> codec, and the **`FakeGateway`** dev/QA provider. Imported from the subpath
> **`@nigako/payments-client/gateway`**; the legacy PaiementPro surface above is unchanged. This is the
> go-forward contract all future providers (Paymetrust/Jèko/PI-SPI) implement. **See `GATEWAY.md`.**

## Install

```
npm install @nigako/payments-client
```

## Use

```ts
import { PaiementProGateway, PaiementProChannel } from '@nigako/payments-client';

const gateway = new PaiementProGateway({
  merchantId: process.env.PAIEMENTPRO_MERCHANT_ID, // unset → initPayin throws PaymentNotConfiguredError
  secretKey: process.env.PAIEMENTPRO_SECRET_KEY,   // unset → callback signing off (accept-all except prod)
  production: process.env.NODE_ENV === 'production',
});

// 1) Init a pay-in (the client opens `url`); NEVER send an amount from the client.
const token = gateway.signNotificationToken(booking.uid); // embed in the notify URL path
const { url, success } = await gateway.initPayin({
  amount: booking.total,            // XOF whole francs
  channel: PaiementProChannel.WAVECI,
  description: `Réservation ${booking.reference}`,
  referenceNumber: booking.uid,
  notificationUrl: `${PUBLIC_API_URL}/v1/payments/paiement-pro/notify/${booking.uid}/${token}`,
  returnUrl: clientReturnUrl,
});

// 2) On the server-to-server notification (the ONLY proof of payment), verify then settle idempotently.
if (!gateway.verifyNotification(booking.uid, tokenFromPath)) throw Unauthorized;
```

**Wiring in a NestJS `-api`:** provide it via a factory that reads `ConfigService`, and map
`PaymentNotConfiguredError` → `ServiceUnavailableException`:

```ts
{
  provide: PaiementProGateway,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => new PaiementProGateway({
    merchantId: config.get('PAIEMENTPRO_MERCHANT_ID'),
    secretKey: config.get('PAIEMENTPRO_SECRET_KEY'),
    production: config.get('NODE_ENV') === 'production',
    logger: (m) => new Logger('PaiementPro').error(m),
  }),
}
```

## API

- `new PaiementProGateway(config)` — `{ merchantId?, secretKey?, production?, fetchImpl?, logger? }`.
  `fetchImpl` is resolved **at call time** when omitted, so a global `fetch` stub installed after
  construction (e.g. a test that boots the DI container first) is honoured.
- `initPayin(params) → Promise<{ url, success, providerReference? }>` — throws `PaymentNotConfiguredError`
  if no merchant id; a transport/gateway failure resolves to `{ url: null, success: false }`.
  `providerReference` carries PaiementPro's `sessionId` on success (when present) — persist it as a gateway
  ref. `customerPhoneNumber` is normalised `+`→`00` (PaiementPro's local international prefix).
- `signNotificationToken(reference) → string | null` · `verifyNotification(reference, token?) → boolean`
  (constant-time; accept-all without a secret except in production).
- `resolveInitUrl(useSandbox?)`, `PaiementProChannel` (WAVECI/MOMOCI/OMCIV2/FLOOZ) — **PaiementPro's**
  rails (provider-specific).
- **Generic contract**: `PaiementProGateway implements PaymentGateway` (`{ initPayin, signNotificationToken,
  verifyNotification }`). The generic `PayInParams.channel` is an opaque **`string`** — a future provider
  implements the same `PaymentGateway` with its own rail codes. Import `PaymentGateway`/`PayInParams` to
  type against the interface rather than the PaiementPro class.

## Invariants

Server-to-server notification is the **only** proof of payment (browser return is cosmetic); the callback
token is an access gate, so keep settlement **idempotent**; money is **XOF `bigint`**; the secret **never**
leaves the server.
