# `@nigako/payments-client/gateway` — the provider-agnostic payment contract

> ⚠️ **PROVISIONAL SKELETON — not a frozen contract (2026-10-17).** The method **names**
> (`payIn/payOut/getStatus/verifyWebhook`) and their neutral vocabulary are settled, but the exact
> **parameters are provisional** and will be finalized from **real Paymetrust sandbox discovery** — we
> have not yet verified any real provider's API. Strategy (DECISION-LOG 2026-10-17): **one real provider
> (Paymetrust, provisional — sandbox is a hard gate) + a fake that emulates it**, so `fake ↔ real` is a
> config toggle; we are **not** forcing a generic multi-provider abstraction, and params are **not**
> pre-shaped to PI-SPI (its model can't carry what a redirect provider needs, and we can't test it). Build
> on this skeleton for dev/QA, but expect the params to change once we have the sandbox. Do not treat as stable.

The next-generation gateway contract every Nigako payment provider will implement. Introduced on
a **separate subpath** (`@nigako/payments-client/gateway`) alongside the legacy PaiementPro surface at the
package root, so existing consumers (souom-ci-api et al.) are unaffected while providers migrate.

> Decision trail: `pi-spi-workspace/DECISION-LOG.md` + `PISPI-ADAPTER.md`. This contract was scrutinised
> and locked over a design session (2026-10-16/17); it supersedes the legacy `initPayin /
> signNotificationToken / verifyNotification` interface, which stays until PaiementPro is fully retired.

## The four operations

```ts
interface PaymentGateway {
  payIn(params: PayInParams): Promise<PayInResult>;        // collect from a payer
  payOut(params: PayOutParams): Promise<PayOutResult>;      // disburse to a payee (a refund IS this)
  getStatus(reference, providerRef?): Promise<StatusResult>; // poll — ALWAYS run as reconciliation
  verifyWebhook(rawBody, headers): VerifyResult;            // authenticate + normalize a notification
}
```

- **`payIn`** pulls money. Returns `PENDING` + a `redirectUrl` (redirect providers) or `qr`, or just
  `PENDING` (request-to-pay). The caller redirects / shows a pending screen accordingly (branch on the
  presence of `redirectUrl`/`qr` — there is no `capabilities` flag).
- **`payOut`** pushes money to a supplied `payee`. **A refund is a payout to the original payer** for an
  app-decided amount (e.g. collected − withheld fee) — NOT a provider reversal. The gateway is
  **stateless**: it can't resolve "who paid order X", so the **app** supplies `payee` + `amount`.
- **`getStatus`** polls. **Consumer rule (replaces a per-provider `webhookOnFailure` flag): always run a
  reconciliation poll / pending-timeout — never rely on the webhook alone.** Some providers (e.g. Jèko)
  send no webhook on a failed pay-in.
- **`verifyWebhook`** returns `{ verified: false }` (fail-closed) or `{ verified: true, event }` — a
  **normalized** `WebhookEvent`, so products never parse provider JSON.

## Canonical types

- **Money** is `Xof = bigint` (XOF whole francs, never ÷100 in the domain). Adapters handle any provider
  minor-unit quirk (e.g. Jèko's ×100) at their own wire boundary. On the wire, amounts are decimal strings.
- **`TransactionStatus`** = `PENDING | SUCCEEDED | FAILED | CANCELLED | EXPIRED` — adapters map their
  provider's vocabulary onto this.
- **`TransactionChannel`** (closed enum) = `ORANGE_MONEY | MTN_MOMO | MOOV_MONEY | WAVE | DJAMO | CARD |
  BANK`. Neutral; each adapter maps it to its own code (e.g. `ORANGE_MONEY` → PaiementPro `OMCIV2` /
  Paymetrust `OM_CI` / Jèko `orange`). Country is context (the provider account), not the channel. Which
  subset a provider supports is a static per-adapter list (for the UI), not a runtime capability object.
- **`WebhookEvent`** = `{ kind: 'PAYIN'|'PAYOUT', status, reference?, providerRef?, amount?, fees?,
  channel?, occurredAt?, raw }`. `kind` tells the app which record `reference` decodes into.

## `reference` — the correlation + idempotency key (no schema coupling)

`reference` is the **compacted record UUID**: `encodeRef(order.uid)` (payin) / `encodeRef(payout.uid)`
(payout). A UUID is 36 chars but providers cap references at ~30, so `encodeRef` base62-encodes the 16
bytes to **22 chars** (pure alphanumeric, fixed-width, lossless). The provider echoes it on the webhook;
the app `decodeRef`s it back to the UID and looks the record up **by its existing primary key** — no
gateway-specific column on your domain tables.

```ts
import { encodeRef, decodeRef } from '@nigako/payments-client/gateway';
const reference = encodeRef(order.uid);           // 22-char base62, send to the provider
const orderUid  = decodeRef(event.reference);     // on the webhook, recover the UID
```

## Webhook

`verifyWebhook` checks `HMAC-SHA256(rawBody, secret)` (hex) from the `x-nigako-signature` header
(constant-time), then normalizes. Helpers `signWebhookBody` / `verifyWebhookSignature` /
`buildWebhookBody` / `parseWebhookEvent` are exported so signer and verifier never drift. **Validation is
strict at every hop** — presence of fields is asserted even for passthrough values (consistency with a
live environment): a malformed token/body/field is rejected, never trusted.

## Providers

- **`FakeGateway`** (shipped here) — a dev/QA stand-in with no real backend and no money/data cost. `payIn`
  mints a signed redirect token → `nigako-pay-fake-web`; a human (or a scripted POST) chooses the outcome;
  `nigako-pay-fake-api` signs + fires the real server-to-server webhook back to the product `-api`, so the
  product's `verifyWebhook` + settlement path runs identically to production. Select via
  `PAYMENTS_PROVIDER=fake`.
  > ⚠️ **The fake is CONDITIONAL and currently PARKED (2026-10-17).** It's only worth running when the
  > chosen provider's own sandbox is inadequate. **PaiementPro** (any-number sandbox) never needed it;
  > **Jèko** (no sandbox) did; **Paymetrust** (our pick) has a *workable* sandbox (deterministic payment
  > pass/fail numbers; transfer test number), so for Paymetrust you should **develop against its sandbox
  > (manual) + stub `fetch` at the adapter boundary (automated)** — the way `paiement-pro.gateway` is
  > tested. The `fake-api`/`fake-web` are built, green, and reusable, but **not invested in further**;
  > resurrect only for a gap the sandbox can't cover (arbitrary edge cases/timeouts/error codes, pre-account
  > UX dev, offline demo). See pi-spi `DECISION-LOG` (2026-10-17).
- **PaiementPro** (legacy, package root) — the old contract; being retired.
- **Paymetrust** — the chosen provider. Its **full contract is now known from the official docs**
  (`docs.paymetrust.com`, captured in `pi-spi-workspace/paymetrust-sandbox-spike/COPIED_API_SPEC.md`): auth
  `POST /v1/oauth/login`; pay-in `POST /v1/payment` (country from `account_key`; **`amount` = whole XOF, not
  cents**; `channel` PUSH/OTP/QRCODE + `payment_method` OM_CI/MOOV_CI/MTN_CI/WAVE_CI; `payment_url` +
  `must_be_redirected`; `direct_pay` inline); status `GET /v1/payment/{payment_token|transaction_id|
  merchant_transaction_id}`; payout `POST /v1/transfer` (sync or async); full status enum; **PI-SPI
  absent**. **Webhook-auth RESOLVED = option 3 (vendor-prescribed):** notification is a minimal
  `{code,status,notify_token,merchant_transaction_id,transaction_id}` authenticated by `notify_token`
  match (no signature), and the docs say confirm the final status via `getStatus` → treat the webhook as an
  untrusted **nudge**, confirm via an authenticated `getStatus` pull (by `merchant_transaction_id`). Not
  yet coded — pending a sandbox account for **pricing + creds + live-quirk confirmation** (bare `OM` vs
  `OM_CI`); develop against the Paymetrust **sandbox** + `fetch`-stub (no fake needed, see above).
- **Jèko / PI-SPI** — researched as spikes in `pi-spi-workspace`, not shipped: Jèko is out (no sandbox);
  PI-SPI is the licence-gated future (direct participant). Port only after real, verified access.


## ⚠️ Refinements this introduces to the `nigako-payments` skill

Flag when updating the cross-workspace skill (the skill still describes the legacy shape):
1. **Refund is a `payOut`**, not a reversal — the gateway *executes* a push to a payee; the app *decides*
   amount/eligibility/ledger. (The skill's "refunds are per-app" meant the decision; the provider call
   belongs behind the interface.)
2. **The gateway is stateless** — "refund order X" must be app-driven (the app holds the payer + amount).
3. **`reference` = base62-compacted record UUID** (no schema coupling); `encodeRef`/`decodeRef` ship here.
4. **Always reconcile** via `getStatus` — don't rely on the webhook alone.
5. **Money is `bigint`** on this contract (legacy used `number`).
