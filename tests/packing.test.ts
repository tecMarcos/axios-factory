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
import { loadHistory, loadPacked, markPacked, unmarkPacked, validPackingDir } from '../apps/production/src/packing-store.js';
import { buildPrintQueue, itemLabel, packingCards, packingChecklist } from '../apps/production/src/workflow.js';

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
  assert.equal(itemLabel({ productName: 'Caneca 325ml', productAttr: 'Branca' }), 'Caneca 325ml — Branca');
  assert.equal(itemLabel({ productName: ' Caneca ', productAttr: '  ' }), 'Caneca');
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
  await assert.rejects(markPacked(dir, 'a|b|7', [], now, { id: 'bad' }), /DEVICE_ID_INVALID/);
  await writeFile(join(dir, 'embalagem.json'), '{"pedidos":{"ok|x|1":{"embaladoEm":"2026-11-25T10:00:00Z","conferido":[],"dispositivo":{"id":"ABCD2345","nome":" Ana\\n "}},"ok|x|2":{"embaladoEm":"2026-11-25T10:00:00Z","conferido":[],"dispositivo":{"id":"<x>"}}}}');
  const devs = await loadPacked(dir);
  assert.deepEqual(devs.get('ok|x|1')?.dispositivo, { id: 'ABCD2345', nome: 'Ana' });
  assert.equal(devs.get('ok|x|2')?.dispositivo, undefined);
  assert.throws(() => validPackingDir(''), /PACKING_DIR_INVALID/);
  assert.throws(() => validPackingDir('data/embalagem'), /PACKING_DIR_INVALID/);
  assert.equal(validPackingDir(' /opt/embalagem '), '/opt/embalagem');
});

const token = 'fake-panel-token-1234567890';
const base = `/p/${token}`;
// Guarda o cookie do aparelho como um celular faria.
let jar = '';
async function request(handler: ReturnType<typeof createPanelHandler>, url: string, method = 'GET', fields?: [string, string][], cookie = jar) {
  const body = fields ? new URLSearchParams(fields).toString() : undefined;
  const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
    url, method, headers: { ...(body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(cookie ? { cookie } : {}) },
  }) as unknown as IncomingMessage;
  let status = 0, headers: Record<string, string> = {}, out = '';
  const res = { req, writeHead(c: number, h: Record<string, string>) { status = c; headers = h; }, end(v?: string | Buffer) { out = v ? String(v) : ''; } } as unknown as ServerResponse;
  await handler(req, res);
  if (headers['Set-Cookie'] && cookie === jar) jar = headers['Set-Cookie'].split(';')[0]!;
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
  assert.doesNotMatch(after, /FAKEM1/, 'sai da fila');
  assert.match(after, /Embalados \(1\)/);
  const packedTab = (await request(on, base + '/embalar?ver=embalados')).body;
  assert.match(packedTab, /Embalados na bancada \(1\)[\s\S]*FAKEM1[\s\S]*Embalado às 09:00/);
  assert.match((await request(on, base + '/embalar?ver=travados')).body, /FAKESEM[\s\S]*NÃO ENVIAR/);
  assert.match((await request(on, base + '/embalar', 'POST', [['c', 'FAKEM1']])).body, /Já embalado às 09:00/);
  assert.doesNotMatch((await request(on, base + '/impressao')).body, /FAKEM1/);
  assert.equal(buildPrintQueue(q, map, now, await loadPacked(packDir)).lines[0]!.jobs.length, 0);
  assert.match((await request(on, base + '/bipar', 'POST', [['c', 'FAKEM1']])).body, /📦 JÁ EMBALADO/);

  assert.equal((await request(on, base + '/desembalar', 'POST', [['k', key]])).status, 200);
  assert.equal((await loadPacked(packDir)).size, 0);
  assert.equal((await request(on, base + '/desembalar', 'POST', [['k', key]])).status, 409);
  assert.match((await request(on, base + '/impressao')).body, /FAKEM1/);
});

test('bancada: escolher o pedido na lista, com foto, pede para confirmar a etiqueta', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pick-'));
  const packDir = await mkdtemp(join(tmpdir(), 'pick-pack-'));
  t.after(() => Promise.all([dir, packDir].map(d => rm(d, { recursive: true, force: true }))));
  const withPhoto = order('P1', ['bisc'], null, 9);
  withPhoto.orderItemList[0]!.productImg = 'https://cf.shopee.com.br/file/biscoito.jpg';
  const q = queueOf(order('P2', ['elfo'], null, 30), withPhoto);
  await writeFile(join(dir, 'production-queue.json'), JSON.stringify(q));
  await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(q)));
  const on = createPanelHandler({ token, dataDir: dir, timezone: 'America/Sao_Paulo', keywords: ['natal'], now: () => now,
    production: { map, historyLoader: async () => [], filas: true, embalagem: { dir: packDir } } });

  const list = (await request(on, base + '/embalar')).body;
  assert.ok(list.indexOf('FAKEP1') < list.indexOf('FAKEP2'), 'prazo mais curto primeiro');
  assert.match(list, /PRÓXIMO[\s\S]*FAKEP1/);
  assert.match(list, /<img src="https:\/\/cf\.shopee\.com\.br\/file\/biscoito\.jpg"/);
  assert.match(list, /Falta embalar \(2\)/);
  assert.equal((list.match(/📦 Embalar este/g) ?? []).length, 2);

  const key = 'shopee|Conta Teste|P2';
  const pick = await request(on, base + '/embalar', 'POST', [['k', key]]);
  assert.match(pick.body, /A etiqueta colada é do pedido FAKEP2\?/);
  assert.match(pick.body, /name="origem" value="lista"/);
  const base3: [string, string][] = [['k', key], ['origem', 'lista'], ['q', 'peca:elfo'], ['q', 'peca:cordao_vermelho']];
  assert.equal((await request(on, base + '/embalado', 'POST', base3)).status, 422, 'sem confirmar a etiqueta não grava');
  assert.equal((await loadPacked(packDir)).size, 0);
  assert.equal((await request(on, base + '/embalado', 'POST', [...base3, ['q', 'etiqueta']])).status, 200);
  assert.deepEqual((await loadPacked(packDir)).get(key)?.conferido, ['peca:elfo', 'peca:cordao_vermelho', 'etiqueta']);
  assert.match((await request(on, base + '/embalar', 'POST', [['k', 'shopee|Conta Teste|NADA']])).body, /Não encontrei esse código/);
  // Bipado não pede a pergunta da etiqueta.
  assert.doesNotMatch((await request(on, base + '/embalar', 'POST', [['c', 'FAKEP1']])).body, /etiqueta colada/);
});

test('aparelho: ID único por celular, nome opcional, gravado em cada embalado e exigido para gravar', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'device-'));
  const packDir = await mkdtemp(join(tmpdir(), 'device-pack-'));
  t.after(() => Promise.all([dir, packDir].map(d => rm(d, { recursive: true, force: true }))));
  const q = queueOf(order('G1', [], 'Cor azul, sem laço', 6, [{ name: 'Caneca personalizada', count: 2 }]), order('B1', ['bisc'], null, 9));
  await writeFile(join(dir, 'production-queue.json'), JSON.stringify(q));
  await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(q)));
  const on = createPanelHandler({ token, dataDir: dir, timezone: 'America/Sao_Paulo', keywords: ['natal'], now: () => now,
    production: { map, historyLoader: async () => [], filas: true, embalagem: { dir: packDir } } });

  jar = '';
  const first = await request(on, base + '/embalar');
  const set = first.headers['Set-Cookie']!;
  assert.match(set, /^axf_dev=[A-Z2-9]{8}~; Path=\/p\/fake-panel-token-1234567890\/; Max-Age=31536000; HttpOnly; SameSite=Strict$/);
  const id = /axf_dev=([A-Z2-9]{8})/.exec(set)![1]!;
  assert.match(first.body, new RegExp(`Este aparelho: <span class="devid">${id}</span>`));
  assert.equal((await request(on, base + '/embalar')).headers['Set-Cookie'], undefined, 'não troca o ID a cada visita');
  const other = await request(on, base + '/embalar', 'GET', undefined, 'outro=1');
  assert.notEqual(/axf_dev=([A-Z2-9]{8})/.exec(other.headers['Set-Cookie']!)![1], id, 'outro celular, outro ID');

  const named = await request(on, base + '/aparelho', 'POST', [['n', '  Marcos\n<b>  ']]);
  assert.match(named.body, /Este aparelho agora é &quot;Marcos &lt;b&gt;&quot;/);
  assert.match(named.headers['Set-Cookie']!, new RegExp(`^axf_dev=${id}~`), 'mesmo ID, nome novo');
  assert.match((await request(on, base + '/embalar')).body, /value="Marcos &lt;b&gt;"/);
  assert.equal((await request(on, base + '/aparelho', 'GET')).status, 405);

  // Produto que não é de Natal: aparece na fila e tem perguntas + botão.
  const list = (await request(on, base + '/embalar')).body;
  assert.ok(list.indexOf('FAKEG1') > 0 && list.indexOf('FAKEG1') < list.indexOf('FAKEB1'));
  const scan = (await request(on, base + '/embalar', 'POST', [['c', 'FAKEG1']])).body;
  assert.match(scan, /Colocou 2× Caneca personalizada\?/);
  assert.match(list, /2× Caneca personalizada</);
  assert.match(scan, /Conferiu a observação do pedido\?[\s\S]*Cor azul, sem laço/);
  assert.match(scan, /✅ Pedido embalado/);
  assert.doesNotMatch(scan, /ainda não tem roteiro/);

  const key = 'shopee|Conta Teste|G1';
  const answers: [string, string][] = [['k', key], ['q', 'item:0'], ['q', 'observacao']];
  const noCookie = await request(on, base + '/embalado', 'POST', answers, '');
  assert.equal(noCookie.status, 428);
  assert.equal((await loadPacked(packDir)).size, 0, 'sem aparelho identificado não grava');
  assert.equal((await request(on, base + '/embalado', 'POST', [['k', key], ['q', 'item:0']])).status, 422);
  assert.equal((await request(on, base + '/embalado', 'POST', answers)).status, 200);
  assert.deepEqual((await loadPacked(packDir)).get(key)?.dispositivo, { id, nome: 'Marcos <b>' });
  assert.match((await request(on, base + '/embalar?ver=embalados')).body, new RegExp(`FAKEG1[\\s\\S]*por Marcos &lt;b&gt; · <span class="devid">${id}</span>`));
  assert.match((await request(on, base + '/embalar', 'POST', [['c', 'FAKEG1']])).body, new RegExp(`Já embalado às 09:00 <span class="who">por Marcos`));
  // A página de produção continua só com Natal.
  assert.doesNotMatch((await request(on, base + '/producao')).body, /FAKEG1/);
  // Cookie adulterado vira aparelho novo, não quebra.
  assert.match((await request(on, base + '/embalar', 'GET', undefined, 'axf_dev=../../x~%%%')).headers['Set-Cookie']!, /^axf_dev=[A-Z2-9]{8}~;/);
});

test('caso do print: chaveiro (fora do Natal), etiqueta a imprimir, atrasado -> perguntas e botão', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'print-case-'));
  const packDir = await mkdtemp(join(tmpdir(), 'print-case-pack-'));
  t.after(() => Promise.all([dir, packDir].map(d => rm(d, { recursive: true, force: true }))));
  const o = { ...normalize({
    orderNumber: '2611245C1JRNTR', orderId: 'UPS999', platform: 'shopee', orderComment: null, orderTimeoutTime: (now - 2 * 3600000) / 1000,
    orderItemList: [{ productId: 'k1', variationId: 'k1', productName: 'Chaveiro Clicável Brawl Stars', productAttr: null, productCount: 1, productImg: 'https://cf.shopee.com.br/file/x.jpg' }],
  }), queues: ['TO_PRINT'] as ('TO_PRINT')[], account: 'Principal' };
  const q = buildProductionQueue([o], now);
  await writeFile(join(dir, 'production-queue.json'), JSON.stringify(q));
  await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(q)));
  const on = createPanelHandler({ token, dataDir: dir, timezone: 'America/Sao_Paulo', keywords: ['natal'], now: () => now,
    production: { map, historyLoader: async () => [], filas: true, embalagem: { dir: packDir } } });
  jar = '';
  await request(on, base + '/embalar');
  for (const [field, value] of [['c', '2611245C1JRNTR'], ['k', 'shopee|Principal|2611245C1JRNTR']] as const) {
    const page = (await request(on, base + '/embalar', 'POST', [[field, value]])).body;
    assert.doesNotMatch(page, /ainda não tem roteiro/);
    assert.match(page, /Colocou 1× Chaveiro Clicável Brawl Stars\?/);
    assert.match(page, /✅ Pedido embalado/);
  }
});

test('histórico permanente: todo aparelho vê quem embalou e quem desfez, mesmo depois que o pedido sai da fila', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'));
  const packDir = await mkdtemp(join(tmpdir(), 'hist-pack-'));
  t.after(() => Promise.all([dir, packDir].map(d => rm(d, { recursive: true, force: true }))));
  const write = async (orders: ReturnType<typeof order>[]) => {
    const q = queueOf(...orders);
    await writeFile(join(dir, 'production-queue.json'), JSON.stringify(q));
    await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(q)));
  };
  await write([order('H1', ['mao2'], 'Ana, Bia', 5)]);
  let clock = now;
  const on = createPanelHandler({ token, dataDir: dir, timezone: 'America/Sao_Paulo', keywords: ['natal'], now: () => clock,
    production: { map, historyLoader: async () => [], filas: true, embalagem: { dir: packDir } } });
  const key = 'shopee|Conta Teste|H1';
  const yes: [string, string][] = [['k', key], ['q', 'peca:mao_coracao'], ['q', 'nomes'], ['q', 'peca:cordao_vermelho']];

  jar = '';
  await request(on, base + '/embalar');
  await request(on, base + '/aparelho', 'POST', [['n', 'Marcos']]);
  const phoneA = jar;
  await request(on, base + '/embalado', 'POST', yes);
  clock += 60000;
  jar = '';
  await request(on, base + '/embalar');
  await request(on, base + '/aparelho', 'POST', [['n', 'Joana']]);
  const phoneB = jar;
  await request(on, base + '/desembalar', 'POST', [['k', key]]);
  clock += 60000;
  await request(on, base + '/embalado', 'POST', yes);

  const events = await loadHistory(packDir);
  assert.deepEqual(events.map(e => [e.acao, e.dispositivo?.nome]), [['embalado', 'Joana'], ['desfeito', 'Joana'], ['embalado', 'Marcos']]);
  assert.deepEqual(events[2]!.itens, ['2× Mão Grinch coração', '2× Cordão vermelho', 'Nomes: Ana, Bia']);
  assert.equal(events[2]!.pedido, 'FAKEH1');

  // O pedido foi coletado e saiu da fila; o histórico continua visível em qualquer aparelho.
  await write([]);
  clock += 40 * 86400000;
  for (const cookie of [phoneA, phoneB, '']) {
    jar = cookie;
    const page = (await request(on, base + '/embalar?ver=historico')).body;
    assert.match(page, /✅ Embalado<\/strong> · <b class="pedido">FAKEH1<\/b> · por Joana/);
    assert.match(page, /↩️ Desfeito<\/strong> · <b class="pedido">FAKEH1<\/b> · por Joana/);
    assert.match(page, /✅ Embalado<\/strong> · <b class="pedido">FAKEH1<\/b> · por Marcos/);
    assert.match(page, /2× Mão Grinch coração · 2× Cordão vermelho · Nomes: Ana, Bia/);
  }
  jar = phoneA;
  assert.match((await request(on, base + '/embalar?ver=historico&q=h1')).body, /FAKEH1/);
  assert.doesNotMatch((await request(on, base + '/embalar?ver=historico&q=ZZZ')).body, /FAKEH1/);
  assert.match((await request(on, base + '/embalar?ver=historico&q=<x>')).body, /value="&lt;x&gt;"/);
  // Linha estragada no arquivo não derruba a aba.
  await writeFile(join(packDir, 'embalagem-historico.jsonl'), '{"quebrado"\n' + (await readFile(join(packDir, 'embalagem-historico.jsonl'), 'utf8')), 'utf8');
  assert.equal((await loadHistory(packDir)).length, 3);
  // Sem CENTRAL_EMBALAGEM não existe aba de histórico.
  const off = createPanelHandler({ token, dataDir: dir, timezone: 'America/Sao_Paulo', keywords: ['natal'], now: () => clock, production: { map, historyLoader: async () => [], filas: true } });
  assert.doesNotMatch((await request(off, base + '/embalar?ver=historico')).body, /Histórico/);
});
