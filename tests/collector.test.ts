import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, normalize, parseResponse, profiles, type Profile } from '../apps/collector/src/core.js';
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
    if (profile === 'TO_INVOICE' || profile === 'TO_PRINT') return { orders: [], total: 0 };
    return profile === 'TO_SHIP' ? { orders: [normalize(order(String(page)))], total: 2 } : { orders: [normalize(order('2'))], total: 1 };
  });
  assert.deepEqual(calls, ['TO_INVOICE:1', 'TO_SHIP:1', 'TO_SHIP:2', 'TO_PRINT:1', 'TO_PICKUP:1']);
  assert.equal(result.summary.uniqueOrders, 2);
  assert.equal(result.summary.units, 4);
  assert.deepEqual(result.summary.counts, { TO_INVOICE: 0, TO_SHIP: 2, TO_PRINT: 0, TO_PICKUP: 1 });
});
test('empty successful response is valid; unknown envelopes fail closed', () => {
  assert.deepEqual(parseResponse(200, 'application/json', { code: 0, data: { list: [], total: 0 } }, contract), { orders: [], total: 0 });
  assert.throws(() => parseResponse(200, 'application/json', { code: 0, data: {} }, contract));
  assert.throws(() => parseResponse(200, 'application/json', { code: 401, data: { list: [], total: 0 } }, contract), /AUTH_REQUIRED/);
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
    const result = await collect(async profile => ({ orders: [normalize({ ...order('1'), isPrintLabel: 0 }, profile)], total: 1 }));
    await save(result, dir);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'orders.json'), 'utf8')), result.orders);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')), result.summary);
    const empty = await collect(async () => ({ orders: [], total: 0 }));
    await save(empty, dir);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'orders.json'), 'utf8')), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('private profile rejects project paths and permissive directories', async () => {
  const { privateProfile } = await import('../apps/collector/src/session.js');
  const { chmod, stat, symlink } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'profile-test-'));
  const project = join(root, 'project');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(project);
  try {
    await assert.rejects(privateProfile(join(project, 'session'), project), /PROFILE_MUST_BE_EXTERNAL/);
    await assert.rejects(privateProfile('relative', project), /PROFILE_MUST_BE_EXTERNAL/);
    const profile = await privateProfile(join(root, 'private'), project);
    assert.equal((await stat(profile)).mode & 0o777, 0o700);
    await chmod(profile, 0o755);
    await assert.rejects(privateProfile(profile, project), /PROFILE_PERMISSIONS_REQUIRED/);
    await symlink(project, join(root, 'alias'));
    await assert.rejects(privateProfile(join(root, 'alias'), project), /PROFILE_MUST_BE_EXTERNAL/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const profileNames = ['TO_INVOICE', 'TO_SHIP', 'TO_PRINT', 'TO_PICKUP'] as const;
const filters = {
  TO_INVOICE: { orderState: 'invoice_pending', invoiceStatus: 'to_issue' },
  TO_SHIP: { orderState: 'to_ship', arrangeStatus: 'to_arrange' },
  TO_PRINT: { orderState: 'in_process', labelStatus: 'success', warehouseType: 0 },
  TO_PICKUP: { orderState: 'to_pickup', pickupStatus: 'to_pickup' },
};
for (const profile of profileNames) {
  test(`${profile} exact form payload and dynamic page`, () => {
    const expected = { timeType: 0, searchType: 0, searchValue: '', sortName: 1, sortValue: 1, isVoided: 0, ...filters[profile], pageNum: 1, pageSize: 50 };
    assert.deepEqual(profiles[profile], expected);
    assert.deepEqual({ ...profiles[profile], pageNum: 3 }, { ...expected, pageNum: 3 });
  });
  test(`${profile} paginates and preserves page guards`, async () => {
    const calls: number[] = [];
    const fetch = async (current: Profile, page: number) => {
      if (current !== profile) return { orders: [], total: 0 };
      calls.push(page);
      return { orders: [normalize({ ...order(String(page)), isPrintLabel: 0 }, current)], total: 2 };
    };
    const result = await collect(fetch);
    assert.deepEqual(calls, [1, 2]);
    assert.equal(result.summary.queues[profile], 2);
    await assert.rejects(collect(fetch, 1), /MAX_PAGES/);
    await assert.rejects(collect(async (current, page) => current !== profile ? { orders: [], total: 0 } : { orders: [normalize({ ...order('same'), isPrintLabel: 0 }, current)], total: 2 }), /PAGINATION_OVERLAP/);
  });
}
test('four queues aggregate memberships and count units once', async () => {
  const calls: string[] = [];
  const result = await collect(async (profile, page) => {
    calls.push(`${profile}:${page}`);
    return parseResponse(200, 'application/json', { code: 0, data: { list: [{ ...order('shared'), isPrintLabel: 1 }], total: 1 } }, contract, profile);
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(result.orders[0]?.queues, profileNames);
  assert.equal(result.orders[0]?.printLabelState, 'PRINT_LABEL_PRINTED');
  assert.equal(result.summary.uniqueOrders, 1);
  assert.equal(result.summary.units, 2);
  assert.deepEqual(result.summary.queues, { TO_INVOICE: 1, TO_SHIP: 1, TO_PRINT: 1, TO_PICKUP: 1 });
  assert.deepEqual(result.summary.counts, result.summary.queues);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
test('invoice and print overlap preserves units and both label classifications without extra calls', async () => {
  let calls = 0;
  const result = await collect(async profile => {
    calls++;
    if (profile !== 'TO_INVOICE' && profile !== 'TO_PRINT') return { orders: [], total: 0 };
    return { orders: [0, 1].map(label => normalize({ ...order(String(label)), isPrintLabel: label, buyerCountry: 'PRIVATE', headers: 'PRIVATE' }, profile)), total: 2 };
  });
  assert.equal(calls, 4);
  assert.equal(result.summary.units, 4);
  assert.equal(result.summary.uniqueOrders, 2);
  assert.deepEqual(result.orders.map(o => o.printLabelState), ['PRINT_LABEL_NOT_PRINTED', 'PRINT_LABEL_PRINTED']);
  assert.deepEqual(result.summary.print, { notPrinted: 1, printed: 1 });
  assert.equal(result.summary.print.notPrinted + result.summary.print.printed, result.summary.queues.TO_PRINT);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
test('invalid print flags fail closed rather than coerce or invent a classification', () => {
  for (const flag of [undefined, null, '0', '1', true, 2, -1]) {
    assert.throws(() => normalize({ ...order('1'), isPrintLabel: flag }, 'TO_PRINT'), /INVALID_PRINT_LABEL_STATE/);
  }
});
test('invoice/print quantity and product conflicts fail closed', async () => {
  for (const changed of [{ productName: 'Other', productCount: 2 }, { productName: 'Code Buddy', productCount: 3 }]) {
    await assert.rejects(collect(async profile => {
      if (profile !== 'TO_INVOICE' && profile !== 'TO_PRINT') return { orders: [], total: 0 };
      return { orders: [normalize({ ...order('1'), isPrintLabel: 0, ...(profile === 'TO_PRINT' ? { orderItemList: [changed] } : {}) }, profile)], total: 1 };
    }), /ORDER_CHANGED/);
  }
});
test('all four empty queues produce zero summary', async () => {
  const result = await collect(async profile => parseResponse(200, 'application/json', { code: 0, data: { list: [], total: 0 } }, contract, profile));
  assert.deepEqual(result.summary.queues, { TO_INVOICE: 0, TO_SHIP: 0, TO_PRINT: 0, TO_PICKUP: 0 });
  assert.deepEqual(result.summary.print, { notPrinted: 0, printed: 0 });
  assert.equal(result.summary.units, 0);
});
