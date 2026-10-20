'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLab, load, sleep } = require('../scripts/lab-helpers');
const { feeConfig } = require('../src/config');

test('initial debts, amount validation, zero-debt student and bank rejection', async t => {
  const lab = await createLab();
  t.after(() => lab.close());
  assert.equal((await lab.fees(1)).body.outstanding, 50_000_000);
  assert.equal((await lab.fees(2)).body.outstanding, 0);
  assert.equal((await lab.fees(3)).body.outstanding, 3_200_000);
  for (const amount of [0, -1, 0.5, '1000', null, 50_000_001]) {
    const result = await lab.pay(amount);
    assert.equal(result.code, 400);
    assert.equal(result.body.status, 'FAILED');
    assert.ok(result.body.error);
    assert.ok(Object.hasOwn(result.body, 'paymentId'));
  }
  assert.equal((await lab.pay(1000, 2)).code, 400);
  assert.equal((await lab.pay(1000, 9)).code, 404);
  const rejected = await lab.pay(25_000_000);
  assert.equal(rejected.code, 402);
  assert.equal(rejected.body.status, 'FAILED');
  assert.equal((await lab.stats()).body.requests, 1);
  assert.equal((await lab.fees()).body.outstanding, 50_000_000);
  assert.equal((await lab.fees()).body.reserved, 0);
});

test('offline bank returns 503 quickly; fee reads survive; recovery needs no fee restart', async t => {
  const lab = await createLab({ bankRunning: false });
  t.after(() => lab.close());
  const result = await lab.pay();
  assert.equal(result.code, 503);
  assert.equal(result.body.status, 'FAILED');
  assert.ok(result.body.error);
  assert.match(result.body.paymentId, /^P\d+$/);
  assert.ok(result.ms < 1500, `offline response ${result.ms} ms`);
  const fees = await lab.fees();
  assert.equal(fees.code, 200);
  assert.ok(fees.ms < 300);
  await lab.startBank();
  assert.equal((await lab.pay()).code, 201);
});

test('BANK_URL and runtime settings are read from environment', () => {
  const old = process.env.BANK_URL;
  try {
    process.env.BANK_URL = 'http://localhost:4999';
    assert.equal(feeConfig().bankUrl, 'http://localhost:4999/');
    process.env.BANK_URL = 'file:///tmp/bank';
    assert.throws(() => feeConfig(), /BANK_URL/);
  } finally {
    if (old === undefined) delete process.env.BANK_URL;
    else process.env.BANK_URL = old;
  }
});

test('20 slow payments have a global deadline and do not block fee reads', async t => {
  const lab = await createLab({ bank: { delayMs: 5000 } });
  t.after(() => lab.close());
  const waiting = Array.from({ length: 20 }, () => lab.pay());
  await sleep(100);
  const fees = await lab.fees();
  assert.equal(fees.code, 200);
  assert.ok(fees.ms < 300, `fees read ${fees.ms} ms`);
  const results = await Promise.all(waiting);
  for (const result of results) {
    assert.equal(result.code, 504);
    assert.equal(result.body.status, 'PENDING');
    assert.ok(result.ms <= 4500, `payment deadline ${result.ms} ms`);
  }
  assert.equal((await lab.fees()).body.outstanding, 50_000_000);
  assert.equal((await lab.fees()).body.reserved, 20_000);
});

test('200 payments reuse <= 20 bank TCP connections and survive six seconds idle', async t => {
  const lab = await createLab();
  t.after(() => lab.close());
  const batch = await load(lab, 200, 10);
  assert.equal(batch.paid, 200);
  const stats = (await lab.stats()).body;
  assert.equal(stats.charges, 200);
  assert.equal(stats.duplicates, 0);
  assert.ok(stats.connections <= 20, `${stats.connections} TCP connections`);
  await sleep(6000);
  assert.equal((await load(lab, 5, 5)).paid, 5);
  assert.equal((await lab.stats()).body.charges, 205);
});

for (const fault of ['dropRate', 'failRate']) {
  test(`60 sequential payments with ${fault}=0.3 retry safely`, async t => {
    const lab = await createLab({ bank: { [fault]: 0.3 } });
    t.after(() => lab.close());
    const batch = await load(lab, 60);
    const stats = (await lab.stats()).body;
    assert.ok(batch.paid >= 54, `${batch.paid}/60 paid`);
    assert.equal(stats.duplicates, 0);
    assert.equal(stats.charges, batch.paid + batch.pending);
    assert.equal((await lab.fees()).body.outstanding, 50_000_000 - batch.paid * 1000);
    for (const result of batch.results) {
      assert.ok(result.ms <= 4500);
      if (result.body.status === 'PENDING') assert.equal(result.code, 504);
    }
  });
}

test('same bank key is replayed once even for concurrent delayed requests; conflicting payload rejected', async t => {
  const lab = await createLab({ bank: { delayMs: 80 } });
  t.after(() => lab.close());
  const charge = (amount = 1000, key = 'same-key') => lab.request(`${lab.bankUrl}/charges`, {
    method: 'POST', headers: { 'Idempotency-Key': key }, body: { reference: 'same-reference', amount },
  });
  const results = await Promise.all(Array.from({ length: 10 }, () => charge()));
  assert.ok(results.every(result => result.code === 201 && result.body.chargeId === results[0].body.chargeId));
  assert.equal((await charge(2000)).code, 409);
  assert.equal((await charge(1000, 'another-key')).code, 409);
  assert.equal((await lab.stats()).body.charges, 1);
  assert.equal((await lab.stats()).body.duplicates, 0);
});

test('concurrent requests cannot reserve more than the outstanding debt', async t => {
  const lab = await createLab({ bank: { delayMs: 40 } });
  t.after(() => lab.close());
  const results = await Promise.all([lab.pay(2_000_000, 3), lab.pay(2_000_000, 3)]);
  assert.deepEqual(results.map(result => result.code).sort(), [201, 400]);
  assert.equal((await lab.fees(3)).body.outstanding, 1_200_000);
  assert.equal((await lab.stats()).body.charges, 1);
});

test('a debited but unconfirmed payment is reconciled exactly once with the same key', async t => {
  const lab = await createLab({ bank: { dropRate: 1 }, fee: { maxAttempts: 1 } });
  t.after(() => lab.close());
  const result = await lab.pay();
  assert.equal(result.code, 504);
  assert.equal(result.body.status, 'PENDING');
  assert.equal((await lab.stats()).body.charges, 1);
  assert.equal((await lab.fees()).body.outstanding, 50_000_000);
  const retryUrl = `${lab.feeUrl}/payments/${result.body.paymentId}/retry`;
  const retries = await Promise.all(Array.from({ length: 5 }, () => lab.request(retryUrl, { method: 'POST' })));
  assert.ok(retries.every(retry => retry.code === 201));
  assert.equal((await lab.fees()).body.outstanding, 49_999_000);
  assert.equal((await lab.stats()).body.charges, 1);
  assert.equal((await lab.request(retryUrl, { method: 'POST' })).code, 201);
  assert.equal((await lab.fees()).body.outstanding, 49_999_000);
});

test('retrying a previously uncertain payment while the bank is offline stays PENDING', async t => {
  const lab = await createLab({ bank: { dropRate: 1 }, fee: { maxAttempts: 1 } });
  t.after(() => lab.close());
  const result = await lab.pay();
  await lab.stopBank();
  const retry = await lab.request(`${lab.feeUrl}/payments/${result.body.paymentId}/retry`, { method: 'POST' });
  assert.equal(retry.code, 504);
  assert.equal(retry.body.status, 'PENDING');
  assert.equal((await lab.fees()).body.reserved, 1000);
});

test('persistent 500 errors fail without reducing debt or retaining reservations', async t => {
  const lab = await createLab({ bank: { failRate: 1 } });
  t.after(() => lab.close());
  const result = await lab.pay();
  assert.equal(result.code, 503);
  assert.equal(result.body.status, 'FAILED');
  assert.equal((await lab.stats()).body.charges, 0);
  assert.equal((await lab.fees()).body.outstanding, 50_000_000);
  assert.equal((await lab.fees()).body.reserved, 0);
});
