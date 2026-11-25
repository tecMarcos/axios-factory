import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalize } from '../apps/collector/src/core.js';
import { aggregateProduction, buildProductionQueue } from '../apps/collector/src/operational.js';
import { createPanelHandler } from '../apps/panel/src/server.js';
import { validateComponentMap } from '../apps/production/src/component-map.js';
import { buildPackingQueue, buildPrintQueue, decisionsFor, shippingDecision } from '../apps/production/src/workflow.js';

const now = Date.parse('2026-11-23T12:00:00Z');
const map = validateComponentMap({
  versao: 1,
  componentes: {
    mao_bolinha: { nome: 'Mão bolinha', personalizado: true },
    biscoito: { nome: 'Biscoito', personalizado: false },
    elfo: { nome: 'Elfo', personalizado: false },
    cordao_vermelho: { nome: 'Cordão vermelho', personalizado: false, consumivel: true },
  },
  deteccaoNatal: ['natal'],
  variantes: {
    v2: { productId: 'p1', anuncio: 'Kit com 4 bolinhas Natal', variante: '2 unidades', componentes: { mao_bolinha: 2, cordao_vermelho: 2 }, confirmado: true },
    v3: { productId: 'p1', anuncio: 'Kit com 4 bolinhas Natal', variante: '3 unidades', componentes: { mao_bolinha: 3, cordao_vermelho: 3 }, confirmado: false },
    mix: { productId: 'p2', anuncio: 'Kit Natal misto', variante: 'Misto', componentes: { biscoito: 2, elfo: 2, cordao_vermelho: 4 }, confirmado: true },
  },
});
const attrs = { v2: '2 unidades', v3: '3 unidades', mix: 'Misto' } as const;
type Q = 'TO_SHIP' | 'TO_PRINT' | 'TO_PICKUP';

function order(id: string, variant: keyof typeof attrs, note: string | null, hours: number, queue: Q = 'TO_SHIP') {
  return { ...normalize({
    orderNumber: id, orderId: `FAKE${id}`, platform: 'shopee', orderComment: note, orderTimeoutTime: (now + hours * 3600000) / 1000,
    orderItemList: [{ productId: variant === 'mix' ? 'p2' : 'p1', variationId: variant, productName: variant === 'mix' ? 'Kit Natal misto' : 'Kit com 4 bolinhas Natal', productAttr: attrs[variant], productCount: 1 }],
  }), queues: [queue], account: 'Conta Teste' };
}
const queueOf = (...orders: ReturnType<typeof order>[]) => buildProductionQueue(orders, now);

test('decisão de envio: só libera pedido com nomes conferidos e mapa confirmado', () => {
  const q = queueOf(
    order('OK', 'v2', 'Ana, Bia', 30),
    order('SEM', 'v2', null, 30),
    order('DIV', 'v2', 'Ana', 30),
    order('MAPA', 'v3', 'Ana, Bia, Caio', 30),
    order('MIX', 'mix', null, 30),
    order('EMB', 'v2', 'Ana, Bia', 30, 'TO_PICKUP'),
  );
  const d = decisionsFor(q, map, now);
  const status = (id: string) => d.get(`shopee|Conta Teste|${id}`)?.status;
  assert.equal(status('OK'), 'pode_enviar');
  assert.equal(status('SEM'), 'nao_enviar');
  assert.equal(status('DIV'), 'nao_enviar');
  assert.match(d.get('shopee|Conta Teste|DIV')!.motivo, /1 encontrado de 2/);
  assert.equal(status('MAPA'), 'revisar');
  assert.equal(status('MIX'), 'pode_enviar', 'kit sem mão não precisa de nome');
  assert.equal(status('EMB'), 'ja_embalado');
  // Nome faltando pesa mais que mapa pendente: o pedido não sai de jeito nenhum.
  assert.equal(shippingDecision({ packed: false, mappingPending: true, nameValidation: { status: 'sem_nomes', expected: 2, found: 0, names: [], reasons: [] } }).status, 'nao_enviar');
});

test('fila de impressão: prazo mais curto primeiro, travados à parte, sem cordão e sem embalados', () => {
  const q = queueOf(
    order('LONGE', 'v2', 'Ana, Bia', 60),
    order('PERTO', 'v2', 'Caio, Duda', 5),
    order('TRAVADO', 'v2', null, 1),
    order('MIX', 'mix', null, 20),
    order('EMB', 'v2', 'Eva, Fábio', 2, 'TO_PICKUP'),
  );
  const { lines } = buildPrintQueue(q, map, now);
  assert.deepEqual(lines.map(l => l.id), ['mao_bolinha', 'biscoito', 'elfo'], 'consumível não é impresso');
  const hands = lines.find(l => l.id === 'mao_bolinha')!;
  assert.deepEqual(hands.jobs.map(j => j.orderNumber), ['PERTO', 'LONGE']);
  assert.deepEqual(hands.jobs[0]!.names, ['Caio', 'Duda']);
  assert.equal(hands.agora, 4);
  assert.equal(hands.aguardando, 2);
  assert.deepEqual(hands.bloqueados.map(j => j.orderNumber), ['TRAVADO']);
  assert.deepEqual(hands.bloqueados[0]!.names, []);
  assert.equal(lines.find(l => l.id === 'biscoito')!.agora, 2);
});

test('bancada: o próximo é o liberado mais urgente, mesmo com travado mais atrasado', () => {
  const q = queueOf(
    order('TRAVADO', 'v2', 'Ana', -2),
    order('B', 'v2', 'Ana, Bia', 40),
    order('A', 'v2', 'Caio, Duda', 10),
    order('EMB', 'v2', 'Eva, Fábio', 2, 'TO_PICKUP'),
  );
  const p = buildPackingQueue(q, map, now);
  assert.equal(p.proximo?.orderNumber, 'A');
  assert.deepEqual(p.fila.map(c => c.orderNumber), ['B']);
  assert.deepEqual(p.travados.map(c => c.orderNumber), ['TRAVADO']);
  assert.equal(p.embalados, 1);
  assert.equal(buildPackingQueue(queueOf(order('X', 'v2', null, 5)), map, now).proximo, null);
});

const token = 'fake-panel-token-1234567890';
const base = `/p/${token}`;
async function request(handler: ReturnType<typeof createPanelHandler>, url: string, method = 'GET', body?: string) {
  const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
    url, method, headers: body ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
  }) as unknown as IncomingMessage;
  let status = 0, headers: Record<string, string> = {}, out = '';
  const res = { req, writeHead(c: number, h: Record<string, string>) { status = c; headers = h; }, end(v?: string | Buffer) { out = v ? String(v) : ''; } } as unknown as ServerResponse;
  await handler(req, res);
  return { status, headers, body: out };
}

test('páginas novas só existem com a flag; sem ela, tudo igual', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const q = queueOf(order('OK1', 'v2', '<i>Ana, Bia', 5), order('SEM1', 'v2', null, 3));
  await writeFile(join(dir, 'production-queue.json'), JSON.stringify(q));
  await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(q)));
  const config = { token, dataDir: dir, timezone: 'America/Sao_Paulo', keywords: ['natal'], now: () => now };
  const production = { map, historyLoader: async () => [] };
  const off = createPanelHandler({ ...config, production });
  const on = createPanelHandler({ ...config, production: { ...production, filas: true } });
  const notFound = await request(off, base + '/xyz');

  for (const sub of ['/impressao', '/embalar']) {
    assert.deepEqual(await request(off, base + sub), notFound);
    assert.deepEqual(await request(createPanelHandler(config), base + sub), notFound);
    assert.deepEqual(await request(on, `/p/wrong-token-000000000000000${sub}`), notFound);
    assert.equal((await request(on, base + sub, 'POST')).status, 405);
  }
  const stripNonce = (html: string) => html.replace(/nonce="[^"]+"/g, 'nonce=""');
  assert.equal(stripNonce((await request(off, base + '/producao')).body), stripNonce((await request(createPanelHandler({ ...config, production: { ...production, filas: false } }), base + '/producao')).body));
  assert.doesNotMatch((await request(off, base + '/producao')).body, /Impressão/);
  assert.match((await request(on, base + '/producao')).body, /🖨️ Impressão/);

  const print = await request(on, base + '/impressao');
  assert.equal(print.status, 200);
  assert.match(print.body, /&lt;i&gt;Ana/);
  assert.doesNotMatch(print.body, /<i>Ana/);
  assert.match(print.body, /http-equiv="refresh"/);

  const pack = await request(on, base + '/embalar');
  assert.equal(pack.status, 200);
  assert.doesNotMatch(pack.body, /http-equiv="refresh"/, 'não apaga as marcações');
  assert.ok(pack.body.indexOf('FAKEOK1') < pack.body.indexOf('FAKESEM1'));
  assert.match(pack.body, /⛔ NÃO ENVIAR/);
  assert.doesNotMatch(pack.body, /<script/);

  const scanOn = await request(on, base + '/bipar', 'POST', 'c=FAKESEM1');
  assert.match(scanOn.body, /⛔ NÃO ENVIAR/);
  const scanOff = await request(off, base + '/bipar', 'POST', 'c=FAKESEM1');
  assert.doesNotMatch(scanOff.body, /NÃO ENVIAR/);
  const nonce = /style-src 'nonce-([^']+)'/.exec(scanOn.headers['Content-Security-Policy']!)![1];
  assert.ok(scanOn.body.includes(`<style nonce="${nonce}">`));
});
