import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, normalize, parseResponse } from '../apps/collector/src/core.js';
import { save } from '../apps/collector/src/output.js';
const order = (id: string, count: unknown = '2') => ({ orderNumber: id, buyerName: 'PRIVATE', buyerAccount: 'PRIVATE', CPF: 'PRIVATE', address: 'PRIVATE', trackingNumber: 'PRIVATE', invoiceOurKey: 'PRIVATE', cookies: 'PRIVATE', tokens: 'PRIVATE', JSESSIONID: 'PRIVATE', orderItemList: [{ productName: 'Code Buddy', productCount: count, buyerName: 'PRIVATE' }] });
const contract = { ordersPath: 'data.list', totalPath: 'data.total', successPath: 'code', successValue: 0 };
test('allowlist excludes sensitive fields recursively', () => {
  const result = normalize(order('1'));
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.orderItemList[0]?.productCount, 2);
  assert.throws(() => normalize({ ...order('1'), shopName: { cookies: 'PRIVATE' } }));
});
test('rejects invalid quantities and identifiers', () => {
  for (const value of [null, '', ' ', true, -1, 1.5, 'NaN']) assert.throws(() => normalize(order('1', value)));
  assert.throws(() => normalize(order('')));
});
test('paginates both profiles, deduplicates across profiles and sums units', async () => {
  const calls: string[] = [];
  const result = await collect(async (profile, page) => {
    calls.push(`${profile}:${page}`);
    return profile === 'TO_SHIP' ? { orders: [normalize(order(String(page)))], total: 2 } : { orders: [normalize(order('2'))], total: 1 };
  });
  assert.deepEqual(calls, ['TO_SHIP:1', 'TO_SHIP:2', 'TO_PICKUP:1']);
  assert.equal(result.summary.uniqueOrders, 2);
  assert.equal(result.summary.units, 4);
  assert.deepEqual(result.summary.counts, { TO_SHIP: 2, TO_PICKUP: 1 });
});
test('empty successful response is valid; unknown envelopes fail closed', () => {
  assert.deepEqual(parseResponse(200, 'application/json', { code: 0, data: { list: [], total: 0 } }, contract), { orders: [], total: 0 });
  assert.throws(() => parseResponse(200, 'application/json', { code: 0, data: {} }, contract));
  assert.throws(() => parseResponse(200, 'application/json', { code: 401, data: { list: [], total: 0 } }, contract), /API_REJECTED/);
});
test('detects authentication, redirect, HTML and HTTP errors', () => {
  for (const status of [401, 403, 302]) assert.throws(() => parseResponse(status, '', null, contract), /AUTH_REQUIRED/);
  assert.throws(() => parseResponse(200, 'text/html', null, contract), /AUTH_REQUIRED/);
  assert.throws(() => parseResponse(500, 'application/json', null, contract), /HTTP_ERROR/);
});
test('rejects overlapping pages, drifting totals, incomplete pages and caps', async () => {
  await assert.rejects(collect(async () => ({ orders: [normalize(order('1'))], total: 2 })), /PAGINATION_OVERLAP/);
  await assert.rejects(collect(async (_, page) => ({ orders: [normalize(order(String(page)))], total: page + 1 })), /TOTAL_CHANGED/);
  await assert.rejects(collect(async () => ({ orders: [], total: 2 })), /INCOMPLETE/);
  await assert.rejects(collect(async () => ({ orders: [normalize(order('1'))], total: 2 }), 1), /MAX_PAGES/);
});
test('conflicting item quantities across profiles fail', async () => {
  await assert.rejects(collect(async profile => ({ orders: [normalize(order('1', profile === 'TO_SHIP' ? 1 : 2))], total: 1 })), /ORDER_CHANGED/);
});
test('publishes matching files and replaces snapshot on subsequent collection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-'));
  try {
    const result = await collect(async () => ({ orders: [normalize(order('1'))], total: 1 }));
    await save(result, dir);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'orders.json'), 'utf8')), result.orders);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')), result.summary);
    const empty = await collect(async () => ({ orders: [], total: 0 }));
    await save(empty, dir);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'orders.json'), 'utf8')), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
