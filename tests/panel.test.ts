import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize } from '../apps/collector/src/core.js';
import { aggregateProduction, buildProductionQueue, calculatePriority } from '../apps/collector/src/operational.js';
import { buildOperationalMessage, buildPriorityAlert, validateSnapshot, type Queue } from '../apps/collector/src/notifications.js';
import { formatRemaining, marketplaceUrl, parseKeywords, personalizationStatus } from '../apps/collector/src/orders-view.js';
import { renderPanel } from '../apps/panel/src/render.js';
import { createPanelHandler } from '../apps/panel/src/server.js';

const now = Date.parse('2026-11-05T15:00:00.000Z');
const token = 'test-token-abcdefghijklmnopqrstuvwxyz';
type Item = Queue['orders'][number]['items'][number];
const item = (name: string, extra: Partial<Item> = {}): Item => ({ productId: name, variationId: 'v', productName: name, productAttr: 'Vermelha', quantity: 1, productSku: 'SKU1', productImg: 'https://cf.shopee.com.br/file/x.jpg', ...extra });
function order(n: number, hours: number | null, extra: Partial<Queue['orders'][number]> = {}): Queue['orders'][number] {
  const epoch = hours === null ? null : now + hours * 3600000;
  return { orderNumber: `UP${n}`, priority: calculatePriority(epoch, now), deadline: epoch === null ? null : new Date(epoch).toISOString(), deadlineEpoch: epoch, hoursRemaining: hours, queues: ['TO_PRINT'], operationalStage: 'NEEDS_PRINT_PROCESSING', platform: 'shopee', shopName: 'jp shopee', platformOrderId: `251105AB${n}CD`, note: null, printLabelState: 'PRINT_LABEL_NOT_PRINTED', scanKeys: [], items: [item('Caneca')], ...extra };
}
const queue = (...orders: Queue['orders']): Queue => ({ generatedAt: new Date(now).toISOString(), orders });
const html = (q: Queue, extra = {}) => renderPanel(q, { now, timezone: 'America/Sao_Paulo', nonce: 'NONCE', ...extra });

test('collector keeps note, marketplace id, sku and https image; drops unsafe shapes', () => {
  const raw = { orderNumber: 'UP1', orderId: '251105ABCD1234', orderComment: '  Nome: Maria  ', buyerName: 'PRIVATE', orderItemList: [{ productName: 'Kit 4 Bolinha de Natal', productCount: 1, productSku: 'BOL4', productImg: 'https://cf.shopee.com.br/file/a.jpg' }] };
  const o = normalize(raw);
  assert.equal(o.platformOrderId, '251105ABCD1234');
  assert.equal(o.note, 'Nome: Maria');
  assert.equal(o.orderItemList[0]!.productImg, 'https://cf.shopee.com.br/file/a.jpg');
  assert.equal(JSON.stringify(o).includes('PRIVATE'), false);
  const odd = normalize({ ...raw, orderComment: { x: 1 }, orderId: [], orderItemList: [{ productName: 'X', productCount: 1, productImg: 'javascript:alert(1)', productSku: {} }] });
  assert.equal(odd.note, null); assert.equal(odd.platformOrderId, null);
  assert.equal(odd.orderItemList[0]!.productImg, null); assert.equal(odd.orderItemList[0]!.productSku, null);
});

test('production queue carries panel fields and still validates', () => {
  const n = normalize({ orderNumber: 'UP1', platform: 'tiktok', orderId: '576300000000000001', orderComment: 'Ana', orderTimeoutTime: (now + 3 * 3600000) / 1000, orderItemList: [{ productName: 'Bolinha', productCount: 2 }] });
  const q = buildProductionQueue([{ ...n, queues: ['TO_PICKUP'] }], now);
  assert.equal(q.orders[0]!.note, 'Ana'); assert.equal(q.orders[0]!.platform, 'tiktok');
  assert.doesNotThrow(() => validateSnapshot(q, aggregateProduction(q)));
});

test('snapshots written before the panel fields existed remain valid', () => {
  const q = queue(order(1, 3));
  for (const o of q.orders) { for (const k of ['platform', 'shopName', 'platformOrderId', 'note', 'printLabelState', 'scanKeys'] as const) delete (o as Partial<typeof o>)[k]; for (const i of o.items) { delete (i as Partial<Item>).productImg; delete (i as Partial<Item>).productSku; } }
  assert.doesNotThrow(() => validateSnapshot(q, aggregateProduction(q)));
  assert.match(html(q), /UP1/);
});

test('personalization: keyword products need a note, accent and case insensitive', () => {
  assert.equal(personalizationStatus({ items: [item('Enfeite NATAL dourado')], note: null }), 'MISSING');
  assert.equal(personalizationStatus({ items: [item('Kit 4 Bolinha')], note: '  ' }), 'MISSING');
  assert.equal(personalizationStatus({ items: [item('Kit 4 Bolinha')], note: 'Maria' }), 'OK');
  assert.equal(personalizationStatus({ items: [item('Caneca')], note: null }), 'NOT_NEEDED');
  assert.equal(personalizationStatus({ items: [item('Caneca Personalizada')], note: null }, parseKeywords('personalizada, Natal')), 'MISSING');
  assert.deepEqual(parseKeywords(''), ['natal', 'bolinha']);
});

test('marketplace links only for known platforms and well-formed ids', () => {
  assert.equal(marketplaceUrl({ platform: 'tiktok', platformOrderId: '576300000000000001' }), 'https://seller-br.tiktok.com/order/detail?order_no=576300000000000001');
  assert.match(marketplaceUrl({ platform: 'shopee', platformOrderId: '251105ABCD1234' })!, /^https:\/\/seller\.shopee\.com\.br\//);
  assert.equal(marketplaceUrl({ platform: 'shopee', platformOrderId: '"><script>' }), null);
  assert.equal(marketplaceUrl({ platform: 'amazon', platformOrderId: '251105ABCD1234' }), null);
  assert.equal(marketplaceUrl({ platform: 'shopee', platformOrderId: null }), null);
});

test('remaining time reads naturally', () => {
  assert.equal(formatRemaining(-14), 'atrasado 14h');
  assert.equal(formatRemaining(2.5), 'faltam 2h 30min');
  assert.equal(formatRemaining(0.25), 'faltam 15min');
  assert.equal(formatRemaining(72), 'faltam 3d 0h');
  assert.equal(formatRemaining(null), 'sem prazo');
});

test('panel groups by live priority, shows notes and flags missing names', () => {
  const page = html(queue(
    order(1, -5, { items: [item('Kit 4 Bolinha de Natal')], note: null }),
    order(2, 3, { items: [item('Kit 4 Bolinha de Natal')], note: 'Nome: Maria' }),
    order(3, 30, { platform: 'tiktok', platformOrderId: '576300000000000003' }),
  ));
  assert.ok(page.indexOf('id="OVERDUE"') < page.indexOf('id="CRITICAL"'));
  assert.ok(page.indexOf('id="CRITICAL"') < page.indexOf('id="ATTENTION"'));
  assert.match(page, /Falta o nome/);
  assert.match(page, /Nota:<\/strong> Nome: Maria/);
  assert.match(page, /⚠️ Sem nome <b>1<\/b>/);
  assert.match(page, /href="https:\/\/seller-br\.tiktok\.com\/order\/detail\?order_no=576300000000000003"/);
  assert.match(page, /rel="noopener noreferrer"/);
});

test('panel recomputes priority against the current time', () => {
  const q = queue(order(1, 2));
  assert.match(html(q), /id="CRITICAL"/);
  assert.match(html(q, { now: now + 3 * 3600000 }), /id="OVERDUE"/);
  assert.match(html(q, { now: now + 3 * 3600000 }), /dados de 180 min atrás/);
});

test('panel escapes marketplace text and never renders raw markup', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const page = html(queue(order(1, 3, { note: evil, shopName: evil, items: [item(evil, { productAttr: evil, productSku: evil })] })));
  assert.equal(page.includes('<img src=x'), false);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
});

test('empty queue renders a friendly empty state', () => assert.match(html(queue()), /Nenhum pedido pendente/));

test('WhatsApp daily lists urgent orders with id, flag and panel link', () => {
  const q = queue(order(1, -5, { items: [item('Kit 4 Bolinha de Natal')] }), order(2, 3), order(3, 30));
  const m = buildOperationalMessage(aggregateProduction(q), q, { now, panelUrl: `https://pedidos.example.com/p/${token}` });
  assert.match(m, /🚨 Atrasados \(1\)\n• Shopee 251105AB1CD — 1x Kit 4 Bolinha de Natal · atrasado 5h ⚠️ sem nome/);
  assert.match(m, /🔴 Críticos \(1\)\n• Shopee 251105AB2CD — 1x Caneca · faltam 3h/);
  assert.doesNotMatch(m, /251105AB3CD/, 'ATTENTION orders stay in the panel only');
  assert.match(m, /✏️ Personalizados sem nome no UpSeller: 1/);
  assert.match(m, /📋 Painel: https:\/\/pedidos\.example\.com\/p\/test-token/);
});

test('WhatsApp list respects the limit and points to the panel', () => {
  const q = queue(...[1, 2, 3, 4].map(n => order(n, -n)));
  const m = buildOperationalMessage(aggregateProduction(q), q, { now, listLimit: 2 });
  assert.equal((m.match(/^• Shopee/gm) ?? []).length, 2);
  assert.match(m, /\+ 2 outros no painel/);
});

test('panel URL must be https', () => {
  const q = queue(order(1, 3));
  assert.throws(() => buildOperationalMessage(aggregateProduction(q), q, { now, panelUrl: 'http://x.com/p/a' }), /INVALID_PANEL_URL/);
  assert.throws(() => buildOperationalMessage(aggregateProduction(q), q, { now, panelUrl: 'javascript:alert(1)' }), /INVALID_PANEL_URL/);
});

test('priority alert names the order and the missing personalization', () => {
  const q = queue(order(1, 3, { items: [item('Bolinha de Natal')] }));
  const m = buildPriorityAlert('NEW_CRITICAL', q.orders[0]!, aggregateProduction(q), { now, panelUrl: `https://pedidos.example.com/p/${token}` });
  assert.match(m, /^Axios Factory — NEW_CRITICAL\nShopee 251105AB1CD ⚠️ sem nome no UpSeller/);
  assert.match(m, /📋 Painel:/);
});

async function serve(t: TestContext, dataDir: string) {
  const handler = createPanelHandler({ token, dataDir, timezone: 'America/Sao_Paulo', keywords: ['natal'], now: () => now });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test('server: right token shows the panel with strict headers; anything else is 404', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'panel-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const q = queue(order(1, 3, { note: 'Nome: Ana' }));
  await writeFile(join(dir, 'production-queue.json'), JSON.stringify(q));
  await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(q)));
  const base = await serve(t, dir);
  const ok = await fetch(`${base}/p/${token}`);
  assert.equal(ok.status, 200);
  const body = await ok.text();
  assert.match(body, /Nome: Ana/);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');
  assert.match(ok.headers.get('content-security-policy')!, /default-src 'none'; img-src https:; media-src 'self' blob: mediastream:; style-src 'nonce-[^']+'; script-src 'nonce-[^']+'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(ok.headers.get('content-security-policy')!)![1]!;
  assert.ok(body.includes(`<script nonce="${nonce}">`));
  for (const path of ['/', `/p/${token}x`, '/p/wrong', `/P/${token}`, `/p/${token}/extra`, '/p/%E0%A4%A']) {
    const r = await fetch(base + path); assert.equal(r.status, 404, path); assert.ok(!(await r.text()).includes('Ana'));
  }
  assert.equal((await fetch(`${base}/p/${token}`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('server: missing or corrupt snapshot answers 503 without details', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'panel-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const base = await serve(t, dir);
  const r = await fetch(`${base}/p/${token}`);
  assert.equal(r.status, 503); assert.match(await r.text(), /ainda não estão disponíveis/);
  await writeFile(join(dir, 'production-queue.json'), '{"generatedAt":1}');
  await writeFile(join(dir, 'production-summary.json'), '{}');
  assert.equal((await fetch(`${base}/p/${token}`)).status, 503);
});

test('server refuses weak or malformed tokens', () => {
  for (const bad of ['', 'short', 'has spaces in it but is long enough', 'x'.repeat(23)]) assert.throws(() => createPanelHandler({ token: bad, dataDir: '.', timezone: 'UTC', keywords: [] }), /PANEL_TOKEN_INVALID/);
});
