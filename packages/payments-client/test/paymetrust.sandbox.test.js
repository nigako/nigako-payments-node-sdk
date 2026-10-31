'use strict';
// Real-sandbox INTEGRATION test (ledger D5: "a few tests hit the real sandbox"). Skipped unless
// PMT_API_KEY + PMT_API_PASSWORD are set, so the hermetic CI loop never depends on an external service.
// Run it to confirm the A1–A8 assumptions against live Paymetrust:
//   PMT_API_KEY=... PMT_API_PASSWORD=... [PMT_NOTIFY_URL=...] npm test
const { test } = require('node:test');
const assert = require('node:assert');
const { PaymetrustGateway } = require('../dist/gateway');

const live = Boolean(process.env.PMT_API_KEY && process.env.PMT_API_PASSWORD);
const skip = live ? false : 'set PMT_API_KEY + PMT_API_PASSWORD to run the real-sandbox integration test';

test('sandbox: real payIn returns a payment_url + a notify_token to persist', { skip }, async () => {
  const gw = new PaymetrustGateway({
    baseUrl: process.env.PMT_BASE_URL || 'https://api.sandbox.paymetrust.net/v1',
    apiKey: process.env.PMT_API_KEY,
    apiPassword: process.env.PMT_API_PASSWORD,
    country: process.env.PMT_COUNTRY || 'CI',
    notifyUrl: process.env.PMT_NOTIFY_URL || 'https://example.com/pay/notify',
  });
  const res = await gw.payIn({
    reference: 'IT' + Date.now().toString(36), // unique merchant_transaction_id (≤30 chars)
    amount: 100n,
    channel: 'WAVE',
    payer: { phone: '+2250707200200', name: 'PayMe Trust', email: 'payme.trust@pmt.com' },
    successUrl: 'https://example.com/pay/success',
    failureUrl: 'https://example.com/pay/failed',
    description: 'Nigako sandbox integration',
  });
  // These assertions are the live confirmation of A1 (path), A2 (OM_CI/WAVE_CI), A6 (required client fields).
  assert.ok(res.redirectUrl, 'expected a payment_url (A1/A2 payload accepted)');
  assert.ok(res.providerToken, 'expected a notify_token to persist (webhook auth)');
  // eslint-disable-next-line no-console
  console.log('sandbox payIn →', { status: res.status, redirectUrl: res.redirectUrl, providerRef: res.providerRef });
});
