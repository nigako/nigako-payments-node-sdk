// Next-generation, provider-agnostic gateway contract (`@nigako/payments-client/gateway`).
// Superset of operations (payIn/payOut/getStatus/verifyWebhook), canonical status/channel, bigint XOF,
// base62 reference codec, shared webhook + redirect-token helpers, and the FakeGateway dev/QA provider.
// Introduced alongside the legacy PaiementPro surface (the package root) so existing consumers are unaffected.
export * from './types';
export * from './ref';
export * from './token';
export * from './webhook';
export * from './fake.gateway';
export * from './paymetrust.gateway';
export { PaymentNotConfiguredError } from '../payment-gateway';
