'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  PaiementProGateway,
  PaiementProChannel,
  PaymentNotConfiguredError,
} = require('../dist');

const okFetch = (payload) => async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(payload),
});

test('resolveInitUrl picks sandbox vs production', () => {
  const gw = new PaiementProGateway({ merchantId: 'M' });
  assert.match(gw.resolveInitUrl(true), /sandbox\.paiementpro\.net/);
  assert.match(gw.resolveInitUrl(false), /www\.paiementpro\.net/);
});

test('signNotificationToken: HMAC hex, null without a secret', () => {
  assert.equal(new PaiementProGateway({}).signNotificationToken('ref'), null);
  const token = new PaiementProGateway({ secretKey: 's' }).signNotificationToken('ref');
  assert.match(token, /^[0-9a-f]{64}$/);
});

test('verifyNotification: accept-all without secret, except in production', () => {
  assert.equal(new PaiementProGateway({}).verifyNotification('ref'), true);
  assert.equal(new PaiementProGateway({ production: true }).verifyNotification('ref'), false);
});

test('verifyNotification: constant-time match with a secret', () => {
  const gw = new PaiementProGateway({ secretKey: 's' });
  const good = gw.signNotificationToken('ref');
  assert.equal(gw.verifyNotification('ref', good), true);
  assert.equal(gw.verifyNotification('ref', good.slice(0, 63) + '0'), false); // same length, wrong
  assert.equal(gw.verifyNotification('ref', 'deadbeef'), false); // wrong length
  assert.equal(gw.verifyNotification('ref', undefined), false); // missing
});

test('initPayin: throws PaymentNotConfiguredError when unconfigured (no merchant id)', async () => {
  await assert.rejects(
    () => new PaiementProGateway({}).initPayin(baseParams()),
    PaymentNotConfiguredError,
  );
});

test('PaiementProGateway satisfies the generic PaymentGateway shape', () => {
  const gw = new PaiementProGateway({ merchantId: 'M' });
  for (const m of ['initPayin', 'signNotificationToken', 'verifyNotification']) {
    assert.equal(typeof gw[m], 'function', `missing ${m}`);
  }
});

test('initPayin: posts the XOF payload and returns the url on success', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, url: 'https://pay/x' }) };
  };
  const gw = new PaiementProGateway({ merchantId: 'MID', fetchImpl });
  const res = await gw.initPayin({ ...baseParams(), channel: PaiementProChannel.WAVECI, customerLastName: 'Koné' });
  assert.deepEqual(res, { url: 'https://pay/x', success: true });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /www\.paiementpro\.net/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.merchantId, 'MID');
  assert.equal(body.countryCurrencyCode, '952');
  assert.equal(body.referenceNumber, 'DGB-1');
  assert.equal(body.notificationURL, 'https://api/notify/DGB-1/token');
  assert.equal(body.customerLastname, 'Koné'); // PaiementPro's lowercase-n spelling
});

test('initPayin: resolves { url:null, success:false } on gateway rejection (never throws)', async () => {
  const rejected = new PaiementProGateway({ merchantId: 'MID', fetchImpl: okFetch({ success: false }) });
  assert.deepEqual(await rejected.initPayin(baseParams()), { url: null, success: false });

  const boom = new PaiementProGateway({
    merchantId: 'MID',
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  assert.deepEqual(await boom.initPayin(baseParams()), { url: null, success: false });
});

function baseParams() {
  return {
    amount: 19800,
    channel: 'WAVECI',
    description: 'Réservation',
    referenceNumber: 'DGB-1',
    notificationUrl: 'https://api/notify/DGB-1/token',
    returnUrl: 'https://app/return',
  };
}
