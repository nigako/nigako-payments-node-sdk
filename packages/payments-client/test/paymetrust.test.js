'use strict';
// Hermetic unit tests for PaymetrustGateway — a fetch-STUB feeds canned Paymetrust HTTP responses (no
// network, no sandbox, CI-safe). These verify the adapter's wire-mapping + the A1–A8 assumptions as coded.
// Real-sandbox verification lives in paymetrust.sandbox.test.js (gated on PMT_* creds). Per ledger D5 the
// standalone FakeGateway is NOT used here.
const { test } = require('node:test');
const assert = require('node:assert');
const { PaymetrustGateway } = require('../dist/gateway');

/** A fetch stub that routes by URL substring and records every call (url, parsed body, headers). */
function makeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const call = {
      url: String(url),
      init,
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    for (const [match, resp] of routes) {
      if (String(url).includes(match)) {
        const r = typeof resp === 'function' ? resp(call) : resp;
        return {
          ok: r.ok !== false,
          status: r.status ?? 200,
          json: async () => r.json ?? {},
          text: async () => JSON.stringify(r.json ?? {}),
        };
      }
    }
    throw new Error('no route for ' + url);
  };
  impl.calls = calls;
  return impl;
}

const OAUTH = ['/oauth/login', { json: { code: 200, status: 'OK', access_token: 'TKN', expires_in: 86400 } }];
const baseCfg = (fetchImpl) => ({
  apiKey: 'k',
  apiPassword: 'p',
  country: 'CI',
  notifyUrl: 'https://api.example.test/pay/notify',
  fetchImpl,
});

test('payIn: authenticates, then maps neutral params → Paymetrust payload + result', async () => {
  const f = makeFetch([
    OAUTH,
    ['/payment', { json: { code: 200, status: 'OK', payment_token: 'PT', transaction_id: 'TX', payment_url: 'https://pay/PT', notify_token: 'NT' } }],
  ]);
  const gw = new PaymetrustGateway(baseCfg(f));
  const res = await gw.payIn({
    reference: 'order-123',
    amount: 15000n,
    channel: 'ORANGE_MONEY',
    payer: { phone: '+2250700000000', name: 'Ama Koffi', email: 'a@b.ci' },
    successUrl: 'souom://ok',
    failureUrl: 'souom://ko',
    description: 'Souom booking',
  });
  // result mapping
  assert.equal(res.reference, 'order-123');
  assert.equal(res.providerRef, 'TX');
  assert.equal(res.providerToken, 'NT'); // persisted → used by verifyWebhook
  assert.equal(res.redirectUrl, 'https://pay/PT');
  assert.equal(res.status, 'PENDING');
  // wire mapping
  assert.ok(f.calls.some((c) => c.url.includes('/oauth/login')), 'called oauth/login first');
  const pay = f.calls.find((c) => c.url.endsWith('/payment'));
  assert.ok(pay.url.endsWith('/v1/payment'), 'A1: no country path segment');
  assert.equal(pay.headers.authorization, 'Bearer TKN');
  assert.equal(pay.body.payment_method, 'OM_CI'); // A2
  assert.equal(pay.body.currency, 'XOF');
  assert.equal(pay.body.merchant_transaction_id, 'order-123');
  assert.equal(pay.body.amount, 15000);
  assert.equal(pay.body.notify_url, 'https://api.example.test/pay/notify'); // server-owned
  assert.equal(pay.body.client_phone_number, '+2250700000000');
  assert.equal(pay.body.client_first_name, 'Ama');
  assert.equal(pay.body.client_last_name, 'Koffi');
  assert.equal(pay.body.client_email, 'a@b.ci');
  assert.equal(pay.body.channel, undefined); // A3: omitted
});

test('payIn: validates amount / reference length / required phone + description', async () => {
  const gw = new PaymetrustGateway(baseCfg(makeFetch([OAUTH])));
  const ok = { reference: 'r', amount: 1n, channel: 'ORANGE_MONEY', payer: { phone: '+225x' }, successUrl: 'a', failureUrl: 'b', description: 'd' };
  await assert.rejects(() => gw.payIn({ ...ok, amount: 0n }));
  await assert.rejects(() => gw.payIn({ ...ok, amount: 100 })); // number, not bigint
  await assert.rejects(() => gw.payIn({ ...ok, reference: 'x'.repeat(31) }));
  await assert.rejects(() => gw.payIn({ ...ok, payer: {} })); // no phone
  await assert.rejects(() => gw.payIn({ ...ok, description: undefined })); // no designation
});

test('payIn: a channel not available in the country throws before any network call', async () => {
  const gw = new PaymetrustGateway(baseCfg(makeFetch([OAUTH])));
  await assert.rejects(
    () => gw.payIn({ reference: 'r', amount: 1n, channel: 'CARD', payer: { phone: '+225x' }, successUrl: 'a', failureUrl: 'b', description: 'd' }),
    /not available/,
  );
});

test('oauth token is cached across calls (one login for two payIns)', async () => {
  const f = makeFetch([OAUTH, ['/payment', { json: { code: 200, payment_url: 'u', transaction_id: 'T', notify_token: 'N' } }]]);
  const gw = new PaymetrustGateway(baseCfg(f));
  const p = { amount: 1n, channel: 'ORANGE_MONEY', payer: { phone: '+225x' }, successUrl: 'a', failureUrl: 'b', description: 'd' };
  await gw.payIn({ ...p, reference: 'r1' });
  await gw.payIn({ ...p, reference: 'r2' });
  assert.equal(f.calls.filter((c) => c.url.includes('/oauth/login')).length, 1);
});

test('getStatus: maps code→canonical status; polls by providerRef when present (A1/A5)', async () => {
  const f = makeFetch([OAUTH, ['/payment/TX', { json: { code: 100, status: 'SUCCESS', transaction_id: 'TX' } }]]);
  const gw = new PaymetrustGateway(baseCfg(f));
  const res = await gw.getStatus('order-1', 'TX');
  assert.equal(res.status, 'SUCCEEDED');
  assert.equal(res.providerRef, 'TX');
  assert.ok(f.calls.some((c) => c.url.includes('/payment/TX')));
});

test('payOut: maps to /transfer with phone_number + payment_method; PENDING is honored (A8)', async () => {
  const f = makeFetch([OAUTH, ['/transfer', { json: { code: 2002, status: 'PENDING', transaction_id: 'TR' } }]]);
  const gw = new PaymetrustGateway(baseCfg(f));
  const res = await gw.payOut({ reference: 'po-1', amount: 12000n, channel: 'ORANGE_MONEY', payee: { phone: '+2250707000001' }, reason: 'Remboursement' });
  assert.equal(res.status, 'PENDING');
  assert.equal(res.providerRef, 'TR');
  const t = f.calls.find((c) => c.url.endsWith('/transfer'));
  assert.equal(t.body.phone_number, '+2250707000001');
  assert.equal(t.body.payment_method, 'OM_CI');
  assert.equal(t.body.amount, 12000);
  assert.equal(t.body.reason, 'Remboursement');
});

test('verifyWebhook: per-transaction notify_token match (D5 model) → verified event', () => {
  const gw = new PaymetrustGateway(baseCfg(makeFetch([OAUTH])));
  const body = JSON.stringify({ code: 100, status: 200, notify_token: 'NT', merchant_transaction_id: 'order-123', transaction_id: 'TX' });
  const ok = gw.verifyWebhook(body, {}, { token: 'NT' });
  assert.equal(ok.verified, true);
  assert.equal(ok.event.status, 'SUCCEEDED'); // A4: trust code 100, not the numeric status
  assert.equal(ok.event.reference, 'order-123');
  assert.equal(ok.event.providerRef, 'TX');
  assert.equal(ok.event.kind, 'PAYIN');
  // wrong stored token → fail-closed
  assert.equal(gw.verifyWebhook(body, {}, { token: 'WRONG' }).verified, false);
  // malformed body → fail-closed
  assert.equal(gw.verifyWebhook('not json', {}, { token: 'NT' }).verified, false);
});

test('verifyWebhook: no stored token → dev accept-all, prod fail-closed', () => {
  const body = JSON.stringify({ code: 100, notify_token: 'NT', merchant_transaction_id: 'o', transaction_id: 't' });
  const dev = new PaymetrustGateway(baseCfg(makeFetch([OAUTH])));
  assert.equal(dev.verifyWebhook(body, {}).verified, true);
  const prod = new PaymetrustGateway({ ...baseCfg(makeFetch([OAUTH])), production: true });
  assert.equal(prod.verifyWebhook(body, {}).verified, false);
});

test('PaymetrustGateway satisfies the PaymentGateway shape', () => {
  const gw = new PaymetrustGateway(baseCfg(makeFetch([OAUTH])));
  for (const m of ['payIn', 'payOut', 'getStatus', 'verifyWebhook']) {
    assert.equal(typeof gw[m], 'function', `missing ${m}`);
  }
});
