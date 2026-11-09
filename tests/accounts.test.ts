import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, collectOrders, finalize, normalize, type FetchPage } from '../apps/collector/src/core.js';
import { findAccount, parseAccounts } from '../apps/collector/src/accounts.js';
import { aggregateProduction } from '../apps/collector/src/operational.js';
import { buildOperationalMessage, validateSnapshot } from '../apps/collector/src/notifications.js';
import { renderPanel } from '../apps/panel/src/render.js';

const now = Date.parse('2026-11-10T15:00:00.000Z');
const raw = (id: string, hours = 3, product = 'Caneca') => ({ orderNumber: id, platform: 'shopee', orderId: `${id}SN`, orderTimeoutTime: (now + hours * 3600000) / 1000, orderItemList: [{ productId: product, variationId: 'v', productName: product, productCount: 1 }] });
const pages = (ids: string[]): FetchPage => async profile => profile === 'TO_SHIP' ? { orders: ids.map(id => normalize(raw(id))), total: ids.length } : { orders: [], total: 0 };

test('no UPSELLER_ACCOUNTS keeps the single previous account', () => {
  assert.deepEqual(parseAccounts({}), [{ name: 'Principal', profileDir: '/opt/axios-factory-runtime/upseller-profile' }]);
  assert.deepEqual(parseAccounts({ UPSELLER_PROFILE_DIR: '/x/p' }), [{ name: 'Principal', profileDir: '/x/p' }]);
});

test('parses several accounts, each with its own profile', () => {
  const a = parseAccounts({ UPSELLER_ACCOUNTS: ' Principal=/opt/p1 ; Loja Dois=/opt/p2 ;' });
  assert.deepEqual(a, [{ name: 'Principal', profileDir: '/opt/p1' }, { name: 'Loja Dois', profileDir: '/opt/p2' }]);
  assert.equal(findAccount(a, 'loja dois').profileDir, '/opt/p2');
  assert.equal(findAccount(a, undefined).name, 'Principal');
  assert.throws(() => findAccount(a, 'Outra'), /UNKNOWN_ACCOUNT/);
});

test('rejects ambiguous or unsafe account lists', () => {
  for (const bad of ['Principal', 'A=relative/path', 'A=/p;a=/q', 'A=/p;B=/p', '=/p', '<b>=/p', `${'x'.repeat(31)}=/p`]) {
    assert.throws(() => parseAccounts({ UPSELLER_ACCOUNTS: bad }), /INVALID_ACCOUNTS/, bad);
  }
});

test('single-account collect is unchanged: no account fields', async () => {
  const r = await collect(pages(['UP1']), 1000, now);
  assert.equal('account' in r.productionQueue.orders[0]!, false);
  assert.equal('accounts' in r.productionQueue, false);
  assert.equal('accounts' in r.summary, false);
});

test('two accounts merge into one queue, each order tagged with its account', async () => {
  const a = await collectOrders(pages(['UP1', 'UP2'])), b = await collectOrders(pages(['UP3']));
  const statuses = [{ name: 'Principal', ok: true, error: null, orders: 2 }, { name: 'Segunda', ok: true, error: null, orders: 1 }];
  const r = finalize([{ ...a, account: 'Principal' }, { ...b, account: 'Segunda' }], now, statuses);
  assert.deepEqual(r.productionQueue.orders.map(o => [o.orderNumber, o.account]), [['UP1', 'Principal'], ['UP2', 'Principal'], ['UP3', 'Segunda']]);
  assert.equal(r.summary.counts.TO_SHIP, 3);
  assert.deepEqual(r.productionQueue.accounts, statuses);
  assert.doesNotThrow(() => validateSnapshot(r.productionQueue, r.productionSummary));
});

test('the same order in both accounts is kept once and reported', async () => {
  const a = await collectOrders(pages(['UP1'])), b = await collectOrders(pages(['UP1', 'UP2']));
  const dup: (string | undefined)[] = [];
  const r = finalize([{ ...a, account: 'Principal' }, { ...b, account: 'Segunda' }], now, undefined, acc => dup.push(acc));
  assert.deepEqual(r.productionQueue.orders.map(o => [o.orderNumber, o.account]), [['UP1', 'Principal'], ['UP2', 'Segunda']]);
  assert.deepEqual(dup, ['Segunda']);
});

test('a failed account is announced in the panel and in WhatsApp', async () => {
  const a = await collectOrders(pages(['UP1']));
  const statuses = [{ name: 'Principal', ok: true, error: null, orders: 1 }, { name: 'Segunda', ok: false, error: 'AUTH_REQUIRED', orders: 0 }];
  const r = finalize([{ ...a, account: 'Principal' }], now, statuses);
  assert.doesNotThrow(() => validateSnapshot(r.productionQueue, r.productionSummary));
  const page = renderPanel(r.productionQueue, { now, timezone: 'UTC', nonce: 'N' });
  assert.match(page, /Conta Segunda<\/strong>: o login no UpSeller expirou/);
  assert.match(page, /<span class="acct">Principal<\/span>/);
  const msg = buildOperationalMessage(aggregateProduction(r.productionQueue), r.productionQueue, { now });
  assert.match(msg, /⚠️ Conta Segunda: login no UpSeller expirou/);
  assert.match(msg, /Shopee UP1SN \(Principal\) —/);
});

test('snapshot rejects malformed account metadata', async () => {
  const r = finalize([await collectOrders(pages(['UP1']))], now, [{ name: 'A', ok: true, error: null, orders: 1 }]);
  for (const bad of [[{ name: '', ok: true, error: null, orders: 0 }], [{ name: 'A', ok: 'yes', error: null, orders: 0 }], 'x']) {
    assert.throws(() => validateSnapshot({ ...r.productionQueue, accounts: bad }, r.productionSummary), /INVALID_NOTIFICATION_SNAPSHOT/, JSON.stringify(bad));
  }
  assert.throws(() => validateSnapshot({ ...r.productionQueue, orders: r.productionQueue.orders.map(o => ({ ...o, account: 5 })) }, r.productionSummary));
});
