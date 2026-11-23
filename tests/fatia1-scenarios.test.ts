import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { finalize, normalize } from '../apps/collector/src/core.js';
import { aggregateProduction, buildProductionQueue } from '../apps/collector/src/operational.js';
import { personalizationStatus } from '../apps/collector/src/orders-view.js';
import { renderPanel } from '../apps/panel/src/render.js';
import { createPanelHandler } from '../apps/panel/src/server.js';
import { validateComponentMap } from '../apps/production/src/component-map.js';
import { validateNames } from '../apps/production/src/names.js';
import { buildProductionView } from '../apps/production/src/production.js';
import { computeSyncHealth } from '../apps/production/src/sync-health.js';

const now = Date.parse('2026-11-23T12:00:00Z');
const date = (minutesAgo: number) => new Date(now - minutesAgo * 60000).toISOString();
const variants = {
  unit: ['1un', { bolinha: 1 }, true],
  pending: ['1un', { bolinha: 1 }, false],
  six: ['6 unidades', { bolinha: 6 }, true],
  five: ['5un', { bolinha: 5 }, true],
  mixed: ['Misto', { biscoito: 2, elfo: 2 }, true],
  cookies: ['4 Biscoitos', { biscoito: 4 }, true],
  elves: ['4 Elfos', { elfo: 4 }, true],
} as const;
const map = validateComponentMap({
  versao: 1, deteccaoNatal: ['natal', 'biscoito', 'elfo'],
  componentes: {
    bolinha: { nome: 'Bolinha', personalizado: true },
    biscoito: { nome: 'Biscoito', personalizado: false },
    elfo: { nome: 'Elfo', personalizado: false },
  },
  variantes: Object.fromEntries(Object.entries(variants).map(([id, [variante, componentes, confirmado]]) =>
    [id, { productId: 'fake-p1', anuncio: 'Kit Natal', variante, componentes, confirmado }])),
});

function order(id: string, variant: keyof typeof variants = 'unit', quantity = 1, note: string | null = null, hours = 72) {
  return {
    ...normalize({
      orderNumber: id, platform: 'shopee', orderComment: note, orderTimeoutTime: (now + hours * 3600000) / 1000,
      orderItemList: [{ productId: 'fake-p1', variationId: variant, productName: 'Kit Bolinha Natal', productAttr: variants[variant][0], productCount: quantity }],
    }),
    queues: ['TO_SHIP'] as ('TO_SHIP' | 'TO_PRINT')[],
  };
}
const view = (...orders: ReturnType<typeof order>[]) => buildProductionView(buildProductionQueue(orders, now), map, now);
const account = (name: string, ok = true) => ({ name, ok, orders: 0, error: ok ? null : 'AUTH_REQUIRED' });
const timezone = 'America/Sao_Paulo';
const token = 'fake-panel-token-1234567890';
const productionPath = `/p/${token}/producao`;

async function request(handler: ReturnType<typeof createPanelHandler>, url: string, method = 'GET') {
  const req = { url, method } as IncomingMessage;
  let status = 0, body = '';
  await handler(req, {
    req,
    writeHead(code: number) { status = code; },
    end(value?: string) { body = value ?? ''; },
  } as unknown as ServerResponse);
  return { status, body };
}

test('cenário: pedido personalizado completo', () => {
  const result = view(order('A', 'unit', 1, 'Ana'));
  assert.equal(result.orders[0]!.nameValidation.status, 'completo');
  assert.equal(result.totals.aProduzir.bolinha, 1);
});

test('cenário: mapa não confirmado nunca dá completo', () => {
  const pending = order('A', 'pending', 1, 'Ana');
  const changed = order('B', 'unit', 1, 'Bia');
  changed.orderItemList[0]!.productAttr = 'Mudou';
  for (const result of view(pending, changed).orders) {
    assert.equal(result.mappingPending, true);
    assert.equal(result.nameValidation.status, 'revisar');
    assert.ok(result.nameValidation.reasons.includes('mapa a confirmar'));
  }
});

test('cenário: pedido sem nomes', () => {
  assert.equal(view(order('A', 'pending')).orders[0]!.nameValidation.status, 'sem_nomes');
  assert.equal(validateNames(null, 1, { unmappedChristmas: true }).status, 'sem_nomes');
});

test('cenário: quantidade de nomes errada', () => {
  const result = view(order('A', 'pending', 2, 'ok')).orders[0]!.nameValidation;
  assert.equal(result.status, 'quantidade_divergente');
  assert.ok(result.reasons.includes('encontrados 1 de 2'));
});

test('cenário: kit misto (2 biscoitos + 2 elfos, sem nomes)', () => {
  const result = view(order('A', 'mixed'));
  assert.deepEqual(result.totals.aProduzir, { bolinha: 0, biscoito: 2, elfo: 2 });
  assert.equal(result.orders[0]!.nameValidation.status, 'nao_aplicavel');
});

test('cenário: kit 4 biscoitos e kit 4 elfos', () => {
  assert.deepEqual(view(order('A', 'cookies'), order('B', 'elves')).totals.aProduzir, { bolinha: 0, biscoito: 4, elfo: 4 });
});

test('cenário: Kit N unidades (6 unidades ×1 e 5un ×2)', () => {
  const result = view(order('A', 'six'), order('B', 'five', 2));
  assert.deepEqual(result.orders.map(o => [o.parts.bolinha, o.expectedNames]), [[6, 6], [10, 10]]);
  assert.equal(result.totals.aProduzir.bolinha, 16);
});

test('cenário: pedido cancelado some da contagem na sync seguinte', () => {
  assert.equal(view(order('A')).totals.aProduzir.bolinha, 1);
  assert.equal(buildProductionView(buildProductionQueue([], now + 60000), map, now + 60000).totals.aProduzir.bolinha, 0);
});

test('cenário: pedido duplicado entre syncs não conta em dobro', () => {
  const orders = [order('A')];
  const first = buildProductionQueue(orders, now - 60000);
  const second = buildProductionQueue(orders, now);
  assert.notEqual(first.generatedAt, second.generatedAt);
  const result = buildProductionView(second, map, now);
  assert.deepEqual(result, buildProductionView(first, map, now));
  assert.deepEqual(result, buildProductionView(second, map, now));
  assert.equal(result.totals.aProduzir.bolinha, 1);
});

test('cenário: pedido em duas filas e em duas contas conta uma vez', () => {
  const entry = order('A');
  entry.queues.push('TO_PRINT');
  const part = { orders: [entry], counts: { TO_INVOICE: 0, TO_SHIP: 1, TO_PRINT: 1, TO_PICKUP: 0 }, print: { printed: 0, notPrinted: 1 } };
  const merged = finalize([{ ...part, account: 'Conta A' }, { ...part, account: 'Conta B' }], now);
  const queue = buildProductionQueue(merged.orders, now);
  assert.deepEqual(merged.orders[0]!.queues, ['TO_SHIP', 'TO_PRINT']);
  assert.equal(buildProductionView(queue, map, now).totals.aProduzir.bolinha, 1);
  const sameOrder = queue.orders[0]!;
  queue.orders.push(sameOrder, { ...sameOrder, platform: 'tiktok' }, { ...sameOrder, account: 'Conta C' });
  assert.equal(buildProductionView(queue, map, now).totals.aProduzir.bolinha, 3);
});

test('cenário: falha de sincronização / conta caída', () => {
  const health = computeSyncHealth([20, 15, 10, 5].map(minutes => ({
    generatedAt: date(minutes), accounts: [account('Conta A', minutes === 20)],
  })), now);
  const a = health.accounts['Conta A']!;
  assert.equal(a.failureStreak, 3);
  assert.equal(a.lastOkAt, date(20));
  assert.equal(a.down, true);
});

test('cenário: dados velhos (snapshot > 90 min)', () => {
  for (const minutes of [90, 91]) {
    const health = computeSyncHealth([{ generatedAt: date(minutes), accounts: [account('Conta A')] }], now);
    assert.equal(health.snapshotAgeMinutes, minutes);
    assert.equal(health.snapshotStale, minutes > 90);
    assert.equal(health.accounts['Conta A']!.stale, minutes > 90);
  }
});

test('cenário: conta ausente e data futura', () => {
  const health = computeSyncHealth([
    { generatedAt: date(20), accounts: [account('Conta A'), account('Conta B')] },
    { generatedAt: date(10), accounts: [account('Conta B')] },
    { generatedAt: date(5) },
    { generatedAt: date(-6), accounts: [account('Conta A')] },
  ], now);
  assert.equal(health.latestGeneratedAt, date(5));
  assert.equal(health.accounts['Conta A']!.absent, true);
  assert.equal(health.accounts['Conta B']!.absent, false);
  assert.equal(health.accounts['Conta A']!.lastAttemptAt, date(20));
  assert.equal(computeSyncHealth([{ generatedAt: date(-5) }], now).latestGeneratedAt, date(-5));
});

test('cenário: pedido perto do prazo sobe (CRITICAL antes de URGENT/NORMAL; boundary 6h/24h)', () => {
  const result = view(...[72, 25, 24, 7, 6, 3].map(hours => order(String(hours), 'unit', 1, null, hours)));
  assert.deepEqual(result.orders.map(o => [o.orderNumber, o.livePriority]), [
    ['3', 'CRITICAL'], ['6', 'CRITICAL'], ['7', 'URGENT'], ['24', 'URGENT'], ['25', 'ATTENTION'], ['72', 'NORMAL'],
  ]);
});

test('cenário: produto não natalino inalterado', async () => {
  const ordinary = order('A', 'unit', 1, 'Ana');
  Object.assign(ordinary.orderItemList[0]!, { productName: 'Caneca', variationId: 'fake-other' });
  const queue = buildProductionQueue([ordinary], now);
  const options = { now, timezone, nonce: 'fixed' };
  assert.deepEqual(view(ordinary).orders, []);
  assert.equal(renderPanel(queue, options), renderPanel(queue, { ...options, productionHref: undefined }));
  assert.equal(personalizationStatus(queue.orders[0]!), 'NOT_NEEDED');
  const handler = createPanelHandler({ token, dataDir: '.', timezone, keywords: [] });
  assert.equal((await request(handler, productionPath)).status, 404);
});

test('cenário: notas reais anonimizadas', () => {
  for (const [note, expected, status, flag] of [
    ['Ana, Bia, Caio, Duda', 4, 'completo'],
    ['Ana / Bia / Caio', 3, 'completo'],
    ['Ana\nBia\nCaio', 3, 'completo'],
    ['Nomes das bolinhas: Ana, Bia, Caio, Duda', 4, 'completo'],
    ['Lia: Ana, Bia\n\nBolinhas: Caio, Duda', 4, 'revisar', 'rotulo_removido'],
    ['Ana, Bia, Caio e Duda', 4, 'revisar', 'conjuncao_dividida'],
    ['Ana Clara, Bia', 2, 'completo'],
    ['Ana / Bia - cor azul', 2, 'revisar', 'texto_extra'],
    ['1 Ana\n2 Bia', 2, 'completo'],
    ['Ana, Bia (urgente)', 2, 'revisar', 'texto_extra'],
  ] as const) {
    const result = validateNames(note, expected);
    assert.equal(result.status, status, note);
    assert.equal(result.found, expected, note);
    if (flag) assert.ok(result.reasons.includes(flag), note);
  }
  assert.equal(validateNames('Ana, Bia e Caio', 3).status, 'revisar');
});

test('cenário: nota-lixo e nomes repetidos', () => {
  for (const note of ['ok', 'sim', 'não', 'nao', 'sem nome', 'sem nomes', 'n/a', 'na', 'obrigado', 'obrigada', 'nome', 'nomes', '-', '.', 'x', 'teste', '123']) {
    const result = validateNames(note, 1);
    assert.equal(result.status, 'revisar', note);
    assert.ok(result.reasons.includes('placeholder'), note);
  }
  for (const note of ['Ana, Ana', 'Ána, ANA']) {
    const result = validateNames(note, 2);
    assert.equal(result.status, 'revisar');
    assert.ok(result.reasons.includes('nome_repetido'));
  }
});

test('cenário: variante natalina sem mapa não é contada', () => {
  const unknown = order('A');
  Object.assign(unknown.orderItemList[0]!, { variationId: 'fake-new', productName: 'Kit 4 Biscoitos' });
  const result = view(unknown);
  assert.equal(result.orders[0]!.nameValidation.status, 'revisar');
  assert.equal(result.unmapped[0]!.orderCount, 1);
  assert.deepEqual(result.unmapped[0]!.guess, { biscoito: 4 });
  assert.deepEqual(result.totals.aProduzir, { bolinha: 0, biscoito: 0, elfo: 0 });
});

test('cenário: productId diferente do mapa', () => {
  const mismatch = order('A', 'unit', 1, 'Ana');
  Object.assign(mismatch.orderItemList[0]!, { productId: 'fake-other', productName: 'Caneca' });
  const result = view(mismatch);
  assert.equal(result.orders[0]!.mappingPending, true);
  assert.equal(result.unmapped[0]!.reason, 'productId diferente do mapa');
  assert.equal(result.totals.aProduzir.bolinha, 0);
});

test("cenário: 'Natália' e 'neonatal' não são natalinos", () => {
  for (const productName of ['Caneca Natália', 'Kit neonatal']) {
    const ordinary = order('A');
    Object.assign(ordinary.orderItemList[0]!, { productName, variationId: 'fake-other' });
    assert.deepEqual(view(ordinary).orders, []);
  }
});

test('cenário: várias linhas personalizadas e outros itens exigem revisão', () => {
  const personalized = order('A', 'unit', 1, 'Ana, Bia');
  const item = personalized.orderItemList[0]!;
  personalized.orderItemList.push({ ...item });
  assert.deepEqual(view(personalized).orders[0]!.nameValidation.reasons, ['distribuição por item não verificada']);
  assert.equal(view(personalized).orders[0]!.nameValidation.status, 'revisar');

  personalized.note = 'Ana';
  personalized.orderItemList[1] = { ...item, productName: 'Caneca', variationId: 'fake-other' };
  const result = view(personalized).orders[0]!.nameValidation;
  assert.equal(result.status, 'revisar');
  assert.deepEqual(result.reasons, ['pedido com itens não natalinos']);
});

test('cenário: painel filtra pedidos, mantém totais e exibe avisos da coleta', async t => {
  const dir = await mkdtemp(join(process.cwd(), '.fatia1-panel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mismatch = order('MAPA');
  Object.assign(mismatch.orderItemList[0]!, { productId: 'fake-other', productName: 'Caneca' });
  const queue = buildProductionQueue([
    order('PEDIDO-OK', 'unit', 1, 'Ana'),
    order('SEM-NOMES'),
    order('PEDIDO-REVISAR', 'pending', 1, '<script>'),
    mismatch,
  ], now, [account('Conta Atual')]);
  await writeFile(join(dir, 'production-queue.json'), JSON.stringify(queue));
  await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(queue)));
  const config = { token, dataDir: dir, timezone, keywords: [], now: () => now };
  const handler = createPanelHandler({
    ...config, production: { map, envLabel: 'STAGING', historyLoader: async () => [
      { generatedAt: date(10), accounts: [account('Conta Anterior', false)] },
    ] },
  });
  const page = await request(handler, productionPath);
  assert.equal(page.status, 200);
  assert.match(page.body, /http-equiv="refresh" content="120"/);
  assert.match(page.body, /class="sync-stale">\s*<strong>Conta Anterior · ausente na última coleta/);
  assert.match(page.body, /Nota: &lt;script&gt;/);
  assert.match(page.body, /productId diferente do mapa/);
  assert.match(page.body, /href="\?nomes=completo">completo \(contagem confere\) <b>1<\/b>/);
  const filtered = await request(handler, productionPath + '?nomes=sem_nomes');
  assert.match(filtered.body, /SEM-NOMES/);
  assert.doesNotMatch(filtered.body, /PEDIDO-OK|PEDIDO-REVISAR/);
  for (const pattern of [/<table>[\s\S]*?<\/table>/, /revisar <b>2<\/b>/]) {
    assert.equal(pattern.exec(filtered.body)?.[0], pattern.exec(page.body)?.[0]);
    assert.match(filtered.body, pattern);
  }
  assert.match((await request(handler, productionPath + '?nomes=invalid')).body, /PEDIDO-OK/);

  const log = t.mock.method(console, 'error', () => {});
  const unavailable = createPanelHandler({
    ...config, production: { map, historyLoader: async () => {
      throw Object.assign(new Error('detalhe privado'), { code: 'EACCES' });
    } },
  });
  const fallback = await request(unavailable, productionPath);
  assert.equal(fallback.status, 200);
  assert.match(fallback.body, /Histórico indisponível: falhas seguidas podem estar subestimadas/);
  assert.match(fallback.body, /Conta Atual/);
  assert.deepEqual(log.mock.calls.map(call => call.arguments), [
    ['{"event":"production_history_unavailable","code":"EACCES"}'],
  ]);
});
