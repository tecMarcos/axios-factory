import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, normalize } from '../apps/collector/src/core.js';
import { aggregateProduction, calculatePriority } from '../apps/collector/src/operational.js';
import { validateSnapshot, type Queue } from '../apps/collector/src/notifications.js';
import { normalizeCode, scanKeyFor, scanKeysFor, scannedCandidates, validScanSecret } from '../apps/collector/src/scan-keys.js';
import { findOrders, maskCode, renderScanPage, renderScanResult } from '../apps/panel/src/scan.js';
import { createPanelHandler } from '../apps/panel/src/server.js';

const now = Date.parse('2026-11-09T15:00:00.000Z');
const secret = 'scan-secret-for-tests-0123456789';
const token = 'test-token-abcdefghijklmnopqrstuvwxyz';
const TRACK = 'BR2611099876543A', NFE = '35261112345678000190550010000012341000012345';
type Order = Queue['orders'][number];
function order(n: number, extra: Partial<Order> = {}): Order {
  const epoch = now + 5 * 3600000;
  return { orderNumber: `UP7K3P00${n}`, priority: calculatePriority(epoch, now), deadline: new Date(epoch).toISOString(), deadlineEpoch: epoch, hoursRemaining: 5, queues: ['TO_PRINT'], operationalStage: 'NEEDS_PRINT_PROCESSING', platform: 'shopee', shopName: 'loja', platformOrderId: `261109AB${n}CDEF`, note: 'Nome: Maria', printLabelState: null, scanKeys: [], items: [{ productId: 'p', variationId: 'v', productName: 'Kit 4 Bolinha de Natal', productAttr: '4un', quantity: 1, productSku: 'BOL4', productImg: 'https://cf.shopee.com.br/file/x.jpg' }], ...extra };
}
const queue = (...orders: Order[]): Queue => ({ generatedAt: new Date(now).toISOString(), orders });
const paths = { list: '/p/T', scan: '/p/T/bipar', lib: '/p/T/leitor.js' };

test('codes normalize: spaces, dashes and case do not matter', () => {
  assert.equal(normalizeCode(' br-2611 0998 7654 3a '), 'BR2611099876543A');
  assert.equal(scanKeyFor('br 2611099876543a', secret), scanKeyFor(TRACK, secret));
  assert.notEqual(scanKeyFor(TRACK, secret), scanKeyFor(TRACK, `${secret}x`));
});

test('collector stores only keyed hashes of tracking number and NF-e key', () => {
  const raw = { orderNumber: 'UP1', trackingNumber: TRACK, invoiceOurKey: NFE, orderItemList: [{ productName: 'X', productCount: 1 }] };
  const o = normalize(raw, undefined, undefined, secret);
  assert.deepEqual(o.scanKeys, [scanKeyFor(TRACK, secret), scanKeyFor(NFE, secret)].sort());
  const text = JSON.stringify(o);
  assert.ok(!text.includes(TRACK) && !text.includes(NFE) && !text.includes('2611099876543'));
  assert.deepEqual(normalize(raw).scanKeys, [], 'no secret configured: nothing derived from the codes');
  assert.deepEqual(scanKeysFor([null, '', 'short', { a: 1 }], secret), []);
});

test('an order in several queues keeps every code', async () => {
  const r = await collect(async profile => {
    if (profile === 'TO_INVOICE') return { orders: [normalize({ orderNumber: 'UP1', orderItemList: [{ productName: 'X', productCount: 1 }] }, profile, undefined, secret)], total: 1 };
    if (profile === 'TO_PRINT') return { orders: [normalize({ orderNumber: 'UP1', isPrintLabel: 0, trackingNumber: TRACK, invoiceOurKey: NFE, orderItemList: [{ productName: 'X', productCount: 1 }] }, profile, undefined, secret)], total: 1 };
    return { orders: [], total: 0 };
  }, 1000, now);
  assert.equal(r.productionQueue.orders[0]!.scanKeys.length, 2);
  assert.doesNotThrow(() => validateSnapshot(r.productionQueue, r.productionSummary));
});

test('snapshot rejects malformed scan keys', () => {
  const q = queue(order(1, { scanKeys: ['not-hex'] }));
  assert.throws(() => validateSnapshot(q, aggregateProduction(q)));
});

test('scanner candidates include tokens inside QR payloads', () => {
  const c = scannedCandidates(`https://www.fazenda.sp.gov.br/nfce/qrcode?p=${NFE}|2|1|1|ABC`);
  assert.ok(c.includes(NFE));
  assert.deepEqual(scannedCandidates('  '), []);
});

test('finds orders by UpSeller number, marketplace number, tracking number or NF-e key', () => {
  const q = queue(order(1, { scanKeys: [scanKeyFor(TRACK, secret), scanKeyFor(NFE, secret)].sort() }), order(2));
  for (const code of ['UP7K3P001', 'up7k3p001', '261109AB1CDEF', TRACK, NFE, `BR 2611 0998 7654 3A`]) {
    assert.deepEqual(findOrders(q, code, secret, now).map(o => o.orderNumber), ['UP7K3P001'], code);
  }
  assert.deepEqual(findOrders(q, TRACK, undefined, now), [], 'hash lookup needs the secret');
  assert.deepEqual(findOrders(q, TRACK, 'another-secret-0123456789abcdef', now), []);
  assert.deepEqual(findOrders(q, 'NADA-A-VER-123', secret, now), []);
  assert.equal(findOrders(q, 'UP7K3P002', secret, now)[0]!.livePriority, 'CRITICAL');
});

test('NF-e keys are masked when echoed back', () => {
  assert.equal(maskCode(NFE), '3526…2345');
  assert.equal(maskCode('abc'), 'ABC');
});

test('result page: found order shows note big, item checklist and next-scan button', () => {
  const page = renderScanResult({ nonce: 'N', paths, scanned: TRACK, matches: findOrders(queue(order(1)), 'UP7K3P001', secret, now), timezone: 'America/Sao_Paulo' });
  assert.match(page, /✅ Pedido encontrado/);
  assert.match(page, /Nome: Maria/);
  assert.match(page, /type="checkbox"/);
  assert.match(page, /width="112"/);
  assert.match(page, /href="\/p\/T\/bipar\?auto=1"/);
});

test('result page: missing personalization is the headline', () => {
  const page = renderScanResult({ nonce: 'N', paths, scanned: 'x', matches: findOrders(queue(order(1, { note: null })), 'UP7K3P001', secret, now), timezone: 'UTC' });
  assert.match(page, /falta o nome no UpSeller/);
});

test('result page: not found never prints the full code', () => {
  const page = renderScanResult({ nonce: 'N', paths, scanned: NFE, matches: [], timezone: 'UTC' });
  assert.match(page, /Não encontrei esse código/);
  assert.ok(!page.includes(NFE));
});

test('scan page posts to itself and loads the reader with the page nonce', () => {
  const page = renderScanPage({ nonce: 'NONCE', paths, auto: true });
  assert.match(page, /<form method="post" action="\/p\/T\/bipar"/);
  assert.match(page, /LIB = "\/p\/T\/leitor.js"/);
  assert.match(page, /AUTO = true/);
  assert.match(page, /<script nonce="NONCE">/);
});

async function serve(t: TestContext, q: Queue, libPath?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'scan-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'production-queue.json'), JSON.stringify(q));
  await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(q)));
  if (libPath) await writeFile(libPath, 'window.ZXing={}');
  const handler = createPanelHandler({ token, dataDir: dir, timezone: 'UTC', keywords: ['natal'], scanSecret: secret, now: () => now, scannerLibPath: libPath ?? join(dir, 'missing.js') });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, dir };
}
const post = (url: string, c: string, type = 'application/x-www-form-urlencoded') => fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body: new URLSearchParams({ c }).toString() });

test('server: scan page, lookup by POST, reader script and camera policy', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'lib-')); t.after(() => rm(tmp, { recursive: true, force: true }));
  const { base } = await serve(t, queue(order(1, { scanKeys: [scanKeyFor(TRACK, secret)] })), join(tmp, 'zxing.js'));
  const list = await (await fetch(`${base}/p/${token}`)).text();
  assert.match(list, new RegExp(`href="/p/${token}/bipar"`));
  const page = await fetch(`${base}/p/${token}/bipar`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('permissions-policy')!, /camera=\(self\)/);
  assert.match(page.headers.get('content-security-policy')!, /form-action 'self'/);
  const hit = await post(`${base}/p/${token}/bipar`, TRACK);
  assert.equal(hit.status, 200); assert.match(await hit.text(), /Pedido encontrado/);
  const miss = await post(`${base}/p/${token}/bipar`, 'XYZ12345678');
  assert.match(await miss.text(), /Não encontrei/);
  const lib = await fetch(`${base}/p/${token}/leitor.js`);
  assert.equal(lib.status, 200); assert.match(lib.headers.get('content-type')!, /javascript/);
});

test('server: scanning requires the token and rejects bad bodies', async t => {
  const { base } = await serve(t, queue(order(1)));
  assert.equal((await post(`${base}/p/wrong-token-abcdefghijklmnop/bipar`, 'UP7K3P001')).status, 404);
  assert.equal((await post(`${base}/p/${token}/bipar`, 'UP7K3P001', 'text/plain')).status, 400);
  assert.equal((await fetch(`${base}/p/${token}/bipar`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'c=' + 'A'.repeat(5000) })).status, 400);
  assert.equal((await fetch(`${base}/p/${token}/leitor.js`)).status, 404, 'missing reader library is a clean 404');
  assert.equal((await fetch(`${base}/p/${token}/outra`)).status, 404);
});

test('scan secret must be long enough when set', () => {
  assert.equal(validScanSecret(undefined), undefined);
  assert.equal(validScanSecret('  '), undefined);
  assert.throws(() => validScanSecret('short'), /SCAN_KEY_INVALID/);
});
