'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  FakeGateway,
  PaymentNotConfiguredError,
  encodeRef,
  decodeRef,
  isRef,
  signToken,
  verifyToken,
  decodeTokenView,
  signWebhookBody,
  verifyWebhookSignature,
  buildWebhookBody,
  parseWebhookEvent,
  SIGNATURE_HEADER,
  TRANSACTION_CHANNELS,
} = require('../dist/gateway');

const SECRET = 'dev_secret_123';

// ── reference codec (base62, fixed 16-byte width) ────────────────────────────
test('encodeRef/decodeRef: round-trip a UUID to 22 chars and back', () => {
  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const ref = encodeRef(uuid);
  assert.equal(ref.length, 22);
  assert.ok(isRef(ref));
  assert.equal(decodeRef(ref), uuid);
});

test('encodeRef: leading-zero UUID round-trips losslessly (fixed width)', () => {
  const uuid = '00000000-0000-0000-0000-000000000001';
  const ref = encodeRef(uuid);
  assert.equal(ref.length, 22);
  assert.equal(decodeRef(ref), uuid);
  const max = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  assert.equal(decodeRef(encodeRef(max)), max);
});

test('encodeRef: rejects a non-UUID; decodeRef rejects bad input', () => {
  assert.throws(() => encodeRef('not-a-uuid'));
  assert.throws(() => decodeRef('tooshort'));
  assert.throws(() => decodeRef('@'.repeat(22))); // invalid base62 char
});

// ── redirect token ───────────────────────────────────────────────────────────
const payload = () => ({
  kind: 'PAYIN',
  reference: encodeRef('3f2504e0-4f89-41d3-9a0c-0305e82c3301'),
  amount: '15000',
  channel: 'WAVE',
  notificationUrl: 'https://api.example.test/pay/webhook',
  successUrl: 'souom://pay/success',
  failureUrl: 'souom://pay/failure',
  description: 'Spike',
  payer: { phone: '+2250700000000' },
});

test('signToken/verifyToken: valid round-trip; tamper + wrong secret rejected', () => {
  const t = signToken(payload(), SECRET);
  const got = verifyToken(t, SECRET);
  assert.equal(got.reference, payload().reference);
  assert.equal(got.amount, '15000');
  assert.equal(verifyToken(t, 'wrong'), null);
  assert.equal(verifyToken(t.slice(0, -2) + 'xx', SECRET), null); // tampered sig
  assert.equal(verifyToken(undefined, SECRET), null);
  assert.equal(verifyToken('nodot', SECRET), null);
});

test('token validation: missing/invalid required fields are rejected (presence asserted)', () => {
  assert.throws(() => signToken({ ...payload(), reference: '' }, SECRET));
  assert.throws(() => signToken({ ...payload(), channel: 'NOPE' }, SECRET));
  assert.throws(() => signToken({ ...payload(), amount: '12.5' }, SECRET));
  assert.throws(() => signToken({ ...payload(), notificationUrl: 'ftp://x' }, SECRET));
  // a validly-signed token whose payload is missing a field decodes to null on verify
  const badBody = Buffer.from(JSON.stringify({ kind: 'PAYIN' }), 'utf8').toString('base64url');
  const badTok = `${badBody}.${signWebhookBody(badBody, SECRET)}`;
  assert.equal(verifyToken(badTok, SECRET), null);
});

test('decodeTokenView: reads payload for display without the secret, still asserts presence', () => {
  const t = signToken(payload(), SECRET);
  const view = decodeTokenView(t);
  assert.equal(view.amount, '15000');
  assert.throws(() => decodeTokenView(undefined));
});

// ── webhook sign / verify / parse ────────────────────────────────────────────
test('webhook: sign + constant-time verify', () => {
  const body = buildWebhookBody({ kind: 'PAYIN', status: 'SUCCEEDED', reference: 'R', amount: '15000' });
  const sig = signWebhookBody(body, SECRET);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(verifyWebhookSignature(body, sig, SECRET), true);
  assert.equal(verifyWebhookSignature(body + ' ', sig, SECRET), false);
  assert.equal(verifyWebhookSignature(body, 'deadbeef', SECRET), false);
  assert.equal(verifyWebhookSignature(body, undefined, SECRET), false);
});

test('parseWebhookEvent: normalizes to bigint + validates kind/status/reference', () => {
  const body = buildWebhookBody({
    kind: 'PAYIN', status: 'SUCCEEDED', reference: 'R', amount: '15000', fees: '150', channel: 'WAVE',
  });
  const ev = parseWebhookEvent(body);
  assert.equal(ev.amount, 15000n);
  assert.equal(ev.fees, 150n);
  assert.equal(ev.channel, 'WAVE');
  assert.throws(() => parseWebhookEvent('{"kind":"NOPE","status":"SUCCEEDED","reference":"R"}'));
  assert.throws(() => parseWebhookEvent('{"kind":"PAYIN","status":"WAT","reference":"R"}'));
  assert.throws(() => parseWebhookEvent('not json'));
});

// ── FakeGateway ──────────────────────────────────────────────────────────────
const fakeCfg = () => ({
  fakeWebBaseUrl: 'http://localhost:3033',
  fakeApiBaseUrl: 'http://localhost:3032',
  notificationUrl: 'https://api.example.test/pay/webhook',
  secret: SECRET,
});

test('FakeGateway.payIn: returns a PENDING result with a fake redirectUrl carrying a valid token', async () => {
  const gw = new FakeGateway(fakeCfg());
  const ref = encodeRef('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  const res = await gw.payIn({ reference: ref, amount: 15000n, channel: 'WAVE', successUrl: 'souom://ok', failureUrl: 'souom://ko' });
  assert.equal(res.status, 'PENDING');
  assert.equal(res.reference, ref);
  assert.match(res.redirectUrl, /^http:\/\/localhost:3033\/pay\?t=/);
  const token = decodeURIComponent(res.redirectUrl.split('t=')[1]);
  const vp = verifyToken(token, SECRET);
  assert.equal(vp.kind, 'PAYIN');
  assert.equal(vp.amount, '15000');
  assert.equal(vp.notificationUrl, 'https://api.example.test/pay/webhook');
});

test('FakeGateway.payOut: PENDING, token kind PAYOUT, resolve link in raw', async () => {
  const gw = new FakeGateway(fakeCfg());
  const ref = encodeRef('11111111-2222-3333-4444-555555555555');
  const res = await gw.payOut({ reference: ref, amount: 12000n, channel: 'ORANGE_MONEY', payee: { phone: '+2250700000000' }, reason: 'Remboursement' });
  assert.equal(res.status, 'PENDING');
  assert.match(res.raw.resolveUrl, /\/pay\?t=/);
  const vp = verifyToken(decodeURIComponent(res.raw.resolveUrl.split('t=')[1]), SECRET);
  assert.equal(vp.kind, 'PAYOUT');
  assert.equal(vp.payee.phone, '+2250700000000');
});

test('FakeGateway: strict input validation (presence + types)', async () => {
  const gw = new FakeGateway(fakeCfg());
  await assert.rejects(() => gw.payIn({ reference: '', amount: 1n, channel: 'WAVE' }));
  await assert.rejects(() => gw.payIn({ reference: 'r', amount: 0n, channel: 'WAVE' }));
  await assert.rejects(() => gw.payIn({ reference: 'r', amount: 100, channel: 'WAVE' })); // number not bigint
  await assert.rejects(() => gw.payIn({ reference: 'r', amount: 1n, channel: 'NOPE' }));
  await assert.rejects(() => gw.payOut({ reference: 'r', amount: 1n, channel: 'WAVE', payee: {} }));
});

test('FakeGateway: unconfigured → PaymentNotConfiguredError', async () => {
  await assert.rejects(() => new FakeGateway({}).payIn({ reference: 'r', amount: 1n, channel: 'WAVE' }), PaymentNotConfiguredError);
});

test('FakeGateway.getStatus: polls fake-api (injected fetch); defaults PENDING on error', async () => {
  const gw = new FakeGateway({ ...fakeCfg(), fetchImpl: async () => ({ json: async () => ({ status: 'SUCCEEDED' }) }) });
  assert.deepEqual((await gw.getStatus('R')).status, 'SUCCEEDED');
  const boom = new FakeGateway({ ...fakeCfg(), fetchImpl: async () => { throw new Error('down'); } });
  assert.equal((await boom.getStatus('R')).status, 'PENDING');
});

test('FakeGateway.verifyWebhook: valid → event; bad sig → fail-closed; no-secret dev/prod policy', () => {
  const gw = new FakeGateway(fakeCfg());
  const body = buildWebhookBody({ kind: 'PAYIN', status: 'SUCCEEDED', reference: 'R', amount: '15000' });
  const sig = signWebhookBody(body, SECRET);
  const ok = gw.verifyWebhook(body, { [SIGNATURE_HEADER]: sig });
  assert.equal(ok.verified, true);
  assert.equal(ok.event.status, 'SUCCEEDED');
  assert.equal(ok.event.amount, 15000n);
  // case-insensitive header lookup
  assert.equal(gw.verifyWebhook(body, { 'X-Nigako-Signature': sig }).verified, true);
  // bad signature
  assert.equal(gw.verifyWebhook(body, { [SIGNATURE_HEADER]: 'deadbeef' }).verified, false);
  // no secret → dev accept-all, prod fail-closed
  assert.equal(new FakeGateway({}).verifyWebhook(body, {}).verified, true);
  assert.equal(new FakeGateway({ production: true }).verifyWebhook(body, {}).verified, false);
});

test('FakeGateway satisfies the PaymentGateway shape', () => {
  const gw = new FakeGateway(fakeCfg());
  for (const m of ['payIn', 'payOut', 'getStatus', 'verifyWebhook']) {
    assert.equal(typeof gw[m], 'function', `missing ${m}`);
  }
  assert.equal(TRANSACTION_CHANNELS.length, 7);
});
