import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalize } from '../apps/collector/src/core.js';
import { aggregateProduction, buildProductionQueue } from '../apps/collector/src/operational.js';
import { createPanelHandler } from '../apps/panel/src/server.js';
import { validateComponentMap } from '../apps/production/src/component-map.js';
import { loadPacked, markPacked, unmarkPacked, validPackingDir } from '../apps/production/src/packing-store.js';
import { buildPrintQueue, packingCards, packingChecklist } from '../apps/production/src/workflow.js';

const now = Date.parse('2026-11-25T12:00:00Z');
const map = validateComponentMap({
  versao: 1,
  componentes: {
    mao_coracao: { nome: 'Mão Grinch coração', personalizado: true },
    biscoito: { nome: 'Biscoito natalino', personalizado: false },
    elfo: { nome: 'Elfo natalino', personalizado: false },
    cordao_vermelho: { nome: 'Cordão vermelho', personalizado: false, consumivel: true },
  },
  deteccaoNatal: ['natal'],
  variantes: {
    mao2: { productId: 'p1', anuncio: 'Kit 4 Bolinha de Natal Grinch', variante: '2 unidades', componentes: { mao_coracao: 2, cordao_vermelho: 2 }, confirmado: true },
    bisc: { productId: 'p2', anuncio: 'Kit 4 biscoitos natal', variante: '4 Biscoitos', componentes: { biscoito: 4, cordao_vermelho: 4 }, confirmado: true },
    elfo: { productId: 'p2', anuncio: 'Kit 4 elfos natal', variante: '4 Elfos', componentes: { elfo: 4, cordao_vermelho: 4 }, confirmado: true },
    mix: { productId: 'p2', anuncio: 'Kit natal misto', variante: 'Misto', componentes: { biscoito: 2, elfo: 2, cordao_vermelho: 4 }, confirmado: true },
  },
});
const products = {
  mao2: ['p1', 'Kit 4 Bolinha de Natal Grinch', '2 unidades'], bisc: ['p2', 'Kit 4 biscoitos natal', '4 Biscoitos'],
  elfo: ['p2', 'Kit 4 elfos natal', '4 Elfos'], mix: ['p2', 'Kit natal misto', 'Misto'],
} as const;
type Variant = keyof typeof products;

function order(id: string, variants: Variant[], note: string | null, hours: number, extra: { name: string; count: number }[] = []) {
  return { ...normalize({
    orderNumber: id, orderId: `FAKE${id}`, platform: 'shopee', orderComment: note, orderTimeoutTime: (now + hours * 3600000) / 1000,
    orderItemList: [
      ...variants.map(v => ({ productId: products[v][0], variationId: v, productName: products[v][1], productAttr: products[v][2], productCount: 1 })),
      ...extra.map((e, i) => ({ productId: `x${i}`, variationId: `x${i}`, productName: e.name, productAttr: null, productCount: e.count })),
    ],
  }), queues: ['TO_SHIP'] as ('TO_SHIP')[], account: 'Conta Teste' };
}
const queueOf = (...orders: ReturnType<typeof order>[]) => buildProductionQueue(orders, now);
const checklist = (o: ReturnType<typeof order>) => packingChecklist(packingCards(queueOf(o), map, now)[0]!, map);

test('perguntas da bancada: cada produto só com o que é dele', () => {
  assert.deepEqual(checklist(order('M', ['mao2'], 'Ana, Bia', 10)).map(q => q.pergunta), [
    'Colocou 2× Mão Grinch coração?', 'Conferiu os 2 nomes nas peças?', 'Colocou 2× cordão vermelho?',
  ]);
  assert.deepEqual(checklist(order('M', ['mao2'], 'Ana, Bia', 10))[1]!.detalhe, ['Ana', 'Bia']);
  assert.deepEqual(checklist(order('B', ['bisc'], null, 10)).map(q => q.pergunta), ['Colocou 4× Biscoito natalino?', 'Colocou 4× cordão vermelho?']);
  assert.deepEqual(checklist(order('E', ['elfo'], null, 10)).map(q => q.pergunta), ['Colocou 4× Elfo natalino?', 'Colocou 4× cordão vermelho?']);
  assert.deepEqual(checklist(order('X', ['mix'], null, 10)).map(q => q.pergunta), [
    'Colocou 2× Biscoito natalino?', 'Colocou 2× Elfo natalino?', 'Colocou 4× cordão vermelho?',
  ]);
  const withOther = checklist(order('O', ['bisc'], null, 10, [{ name: 'Caneca azul', count: 1 }]));
  assert.deepEqual(withOther.map(q => q.id), ['peca:biscoito', 'peca:cordao_vermelho', 'item:1']);
  assert.equal(withOther[2]!.pergunta, 'Colocou 1× Caneca azul?');
});

test('registro de embalagem: grava, desfaz, ignora lixo, descarta antigos e não perde escrita simultânea', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'packing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal((await loadPacked(dir)).size, 0);
  await Promise.all(['a|b|1', 'a|b|2', 'a|b|3'].map(k => markPacked(dir, k, ['nomes'], now)));
  assert.deepEqual([...(await loadPacked(dir)).keys()].sort(), ['a|b|1', 'a|b|2', 'a|b|3']);
  await markPacked(dir, 'a|b|1', ['outro'], now + 1000);
  assert.deepEqual((await loadPacked(dir)).get('a|b|1'), { embaladoEm: new Date(now).toISOString(), conferido: ['nomes'] }, 'primeira marcação vale');
  await unmarkPacked(dir, 'a|b|2', now);
  assert.equal((await loadPacked(dir)).has('a|b|2'), false);
  await markPacked(dir, 'a|b|9', [], now + 31 * 86400000);
  assert.deepEqual([...(await loadPacked(dir)).keys()], ['a|b|9'], 'registros com mais de 30 dias saem');
  await writeFile(join(dir, 'embalagem.json'), '{"pedidos":{"ok|x|1":{"embaladoEm":"2026-11-25T10:00:00Z","conferido":[]},"ruim":{"embaladoEm":"x"}}}');
  assert.deepEqual([...(await loadPacked(dir)).keys()], ['ok|x|1']);
  await writeFile(join(dir, 'embalagem.json'), 'não é json');
  assert.equal((await loadPacked(dir)).size, 0);
  await assert.rejects(markPacked(dir, 'x', [], now), /PACK_KEY_INVALID/);
  assert.throws(() => validPackingDir(''), /PACKING_DIR_INVALID/);
  assert.throws(() => validPackingDir('data/embalagem'), /PACKING_DIR_INVALID/);
  assert.equal(validPackingDir(' /opt/embalagem '), '/opt/embalagem');
});

const token = 'fake-panel-token-1234567890';
const base = `/p/${token}`;
async function request(handler: ReturnType<typeof createPanelHandler>, url: string, method = 'GET', fields?: [string, string][]) {
  const body = fields ? new URLSearchParams(fields).toString() : undefined;
  const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
    url, method, headers: body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
  }) as unknown as IncomingMessage;
  let status = 0, headers: Record<string, string> = {}, out = '';
  const res = { req, writeHead(c: number, h: Record<string, string>) { status = c; headers = h; }, end(v?: string | Buffer) { out = v ? String(v) : ''; } } as unknown as ServerResponse;
  await handler(req, res);
  return { status, headers, body: out };
}

test('bancada: bipar, responder Sim em tudo, marcar embalado e desfazer', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'station-'));
  const packDir = await mkdtemp(join(tmpdir(), 'station-pack-'));
  t.after(() => Promise.all([dir, packDir].map(d => rm(d, { recursive: true, force: true }))));
  const q = queueOf(order('M1', ['mao2'], '<i>Ana, Bia', 5), order('SEM', ['mao2'], null, 3), order('MIX', ['mix'], null, 8));
  await writeFile(join(dir, 'production-queue.json'), JSON.stringify(q));
  await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(q)));
  const config = { token, dataDir: dir, timezone: 'America/Sao_Paulo', keywords: ['natal'], now: () => now };
  const production = { map, historyLoader: async () => [], filas: true };
  const off = createPanelHandler({ ...config, production });
  const on = createPanelHandler({ ...config, production: { ...production, embalagem: { dir: packDir } } });
  const notFound = await request(off, base + '/xyz');
  const key = 'shopee|Conta Teste|M1';

  // Sem CENTRAL_EMBALAGEM: nada de gravar, e o Embalar continua só leitura.
  assert.deepEqual(await request(off, base + '/embalado', 'POST', [['k', key]]), notFound);
  assert.equal((await request(off, base + '/embalar', 'POST', [['c', 'FAKEM1']])).status, 405);
  assert.doesNotMatch((await request(off, base + '/embalar')).body, /id="cam"/);
  assert.match((await request(off, base + '/embalar')).body, /📷 Bipar/);
  assert.equal((await request(on, base + '/embalado')).status, 405);

  const station = await request(on, base + '/embalar');
  assert.equal(station.status, 200);
  assert.match(station.body, new RegExp(`action="${base}/embalar" id="f"`));
  assert.doesNotMatch(station.body, /\/bipar"/, 'Bipar sai do menu: o leitor está no Embalar');
  assert.doesNotMatch(station.body, /http-equiv="refresh"/);

  const scan = await request(on, base + '/embalar', 'POST', [['c', 'FAKEM1']]);
  assert.match(scan.body, /Conferiu os 2 nomes nas peças\?/);
  assert.match(scan.body, /&lt;i&gt;Ana · Bia/);
  assert.match(scan.body, /value="peca:mao_coracao" required/);
  assert.match((await request(on, base + '/embalar', 'POST', [['c', 'FAKESEM']])).body, /Não embale\./);
  assert.doesNotMatch((await request(on, base + '/embalar', 'POST', [['c', 'FAKESEM']])).body, /Pedido embalado/);
  assert.match((await request(on, base + '/embalar', 'POST', [['c', 'NADA123']])).body, /Não encontrei esse código/);

  const partial = await request(on, base + '/embalado', 'POST', [['k', key], ['q', 'peca:mao_coracao'], ['q', 'nomes']]);
  assert.equal(partial.status, 422);
  assert.match(partial.body, /Colocou 2× cordão vermelho\?/);
  assert.equal((await loadPacked(packDir)).size, 0);
  assert.equal((await request(on, base + '/embalado', 'POST', [['k', 'shopee|Conta Teste|SEM'], ['q', 'peca:mao_coracao'], ['q', 'nomes'], ['q', 'peca:cordao_vermelho']])).status, 409);
  assert.equal((await request(on, base + '/embalado', 'POST', [['k', 'shopee|Conta Teste|NAO']])).status, 404);
  assert.equal((await loadPacked(packDir)).size, 0);

  const ok = await request(on, base + '/embalado', 'POST', [['k', key], ['q', 'peca:mao_coracao'], ['q', 'nomes'], ['q', 'peca:cordao_vermelho']]);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /FAKEM1 embalado/);
  assert.deepEqual((await loadPacked(packDir)).get(key)?.conferido, ['peca:mao_coracao', 'nomes', 'peca:cordao_vermelho']);
  assert.match(await readFile(join(packDir, 'embalagem.json'), 'utf8'), /"versao":1/);
  assert.equal((await request(on, base + '/embalado', 'POST', [['k', key], ['q', 'peca:mao_coracao'], ['q', 'nomes'], ['q', 'peca:cordao_vermelho']])).status, 409);

  const after = (await request(on, base + '/embalar')).body;
  const doneAt = after.indexOf('Embalados na bancada (1)');
  assert.ok(doneAt > 0 && after.indexOf('FAKEM1') > doneAt, 'sai da fila e aparece nos embalados');
  assert.match((await request(on, base + '/embalar', 'POST', [['c', 'FAKEM1']])).body, /Já embalado às 09:00/);
  assert.doesNotMatch((await request(on, base + '/impressao')).body, /FAKEM1/);
  assert.equal(buildPrintQueue(q, map, now, await loadPacked(packDir)).lines[0]!.jobs.length, 0);
  assert.match((await request(on, base + '/bipar', 'POST', [['c', 'FAKEM1']])).body, /📦 JÁ EMBALADO/);

  assert.equal((await request(on, base + '/desembalar', 'POST', [['k', key]])).status, 200);
  assert.equal((await loadPacked(packDir)).size, 0);
  assert.equal((await request(on, base + '/desembalar', 'POST', [['k', key]])).status, 409);
  assert.match((await request(on, base + '/impressao')).body, /FAKEM1/);
});
