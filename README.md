# nigako-payments-node-sdk

Node/TypeScript SDK for **Nigako payments** — an npm-workspaces monorepo.

## Packages

- **[`@nigako/payments-client`](packages/payments-client)** — the stateless **PaiementPro** core: pay-in
  init (`initPayin` → hosted-payment `{ url, success }`) + the self-signed **callback token**
  (`signNotificationToken` / `verifyNotification`, HMAC-SHA256, path-segment, constant-time, fail-closed
  in production). Framework-agnostic (constructor config, injectable `fetch`); XOF. This is the reusable
  core every `-api` copy-adapted inline — extracted here so souom-ci/ivotruck/dakaud/diatigi share one
  implementation. **Refund / disbursement / wallet + the payment state machine stay per-app** (they are
  *not* in this package). See the **`nigako-payments` skill**.

## Develop

```
npm install          # links the workspace
npm run build        # tsc → dist/ (CJS + d.ts)
npm run typecheck
npm test             # builds + runs node:test
```

## Release

Publish to public npm per package (dependency order if adapters are added later). Tag-based CI mirrors
`nigako-verify-node-sdk` (`payments-client-v*`). Consumers then `npm install @nigako/payments-client` and
wire it behind their own `-api` adapter (a NestJS provider factory reading `ConfigService`).
