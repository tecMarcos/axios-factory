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
import { markPacked } from '../apps/production/src/packing-store.js';
import { applyStages, buildStageBoard, loadStageHistory, loadStages, pieceKey, productionStatus, stagesFor } from '../apps/production/src/stages.js';
import { packingCards } from '../apps/production/src/workflow.js';

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


const dev = { id: 'ABCD2345', nome: 'Mesa 1' };

test('etapas por tipo de peça: mão personalizada tem nomes e colagem; biscoito e elfo só imprimir e separar', () => {
  assert.deepEqual(stagesFor(map, 'mao_coracao'), ['imprimir', 'nomes', 'colar']);
  assert.deepEqual(stagesFor(map, 'biscoito'), ['imprimir', 'separar']);
  assert.deepEqual(stagesFor(map, 'elfo'), ['imprimir', 'separar']);
  assert.deepEqual(stagesFor(map, 'cordao_vermelho'), [], 'cordão não é produzido');
  assert.deepEqual(stagesFor(map, 'nao_existe'), []);
});

test('quadro: só pedidos liberados entram; peças por etapa, prazo mais curto primeiro; travados à parte', () => {
  const q = queueOf(order('M1', ['mao2'], 'Ana, Bia', 20), order('SEM', ['mao2'], null, 3), order('MIX', ['mix'], null, 8), order('B', ['bisc'], null, 2));
  const board = buildStageBoard(q, map, now, new Map());
  assert.deepEqual(board.byStage.imprimir.map(p => `${p.card.displayId}:${p.componentId}:${p.quantidade}`),
    ['FAKEB:biscoito:4', 'FAKEMIX:biscoito:2', 'FAKEMIX:elfo:2', 'FAKEM1:mao_coracao:2']);
  assert.deepEqual(board.byStage.imprimir.at(-1)!.nomes, ['Ana', 'Bia']);
  assert.deepEqual(board.byStage.nomes.map(p => `${p.card.displayId}:${p.nomes.join(',')}`), ['FAKEM1:Ana,Bia'], 'nomes 3D já podem ser impressos');
  assert.equal(board.byStage.colar.length, 0);
  assert.deepEqual(board.travados.map(c => c.displayId), ['FAKESEM']);
  assert.equal(board.prontos.length, 0);
});

test('marcar etapas: imprimir mão e nomes 3D em paralelo, colar só depois dos dois; corrida, desfazer, pronto', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const q = queueOf(order('M1', ['mao2'], 'Ana, Bia', 20), order('E', ['elfo'], null, 5));
  const k = pieceKey('shopee|Conta Teste|M1', 'mao_coracao');
  const etapas = stagesFor(map, 'mao_coracao');
  const change = { piece: k, etapa: 'imprimir' as const, etapas, pedido: 'M1', peca: 'Mão', quantidade: 2 };
  // Antes de imprimir qualquer coisa, a mão já aparece em "imprimir" E em "nomes 3D".
  let board = buildStageBoard(q, map, now, new Map());
  assert.deepEqual(board.byStage.nomes.map(p => p.nomes), [['Ana', 'Bia']]);
  assert.ok(board.byStage.imprimir.some(p => p.piece === k));
  assert.equal(board.byStage.colar.length, 0);
  // Colar antes de imprimir não vale.
  assert.equal((await applyStages(dir, [{ change: { ...change, etapa: 'colar' } }], now, dev)).length, 0);
  // Nomes primeiro, em dois celulares ao mesmo tempo: conta uma vez.
  const [a, b] = await Promise.all([
    applyStages(dir, [{ change: { ...change, etapa: 'nomes' } }], now, dev),
    applyStages(dir, [{ change: { ...change, etapa: 'nomes' } }], now, { id: 'ZZZZ2345' }),
  ]);
  assert.equal(a.length + b.length, 1, 'dois celulares marcando a mesma peça: só um vale');
  let state = await loadStages(dir);
  assert.deepEqual(state.get(k)?.feitas, ['nomes']);
  board = buildStageBoard(q, map, now, state);
  assert.equal(board.byStage.nomes.length, 0);
  assert.equal(board.byStage.colar.length, 0, 'falta imprimir a mão');
  await applyStages(dir, [{ change }], now, dev);
  state = await loadStages(dir);
  board = buildStageBoard(q, map, now, state);
  assert.deepEqual(board.byStage.colar.map(p => p.nomes), [['Ana', 'Bia']]);
  // Com "colar" feito, não dá para desfazer a impressão (desfaz a colagem antes).
  await applyStages(dir, [{ change: { ...change, etapa: 'colar' } }], now, dev);
  assert.equal((await applyStages(dir, [{ change, undo: true }], now, dev)).length, 0);
  state = await loadStages(dir);
  board = buildStageBoard(q, map, now, state);
  assert.deepEqual(board.prontos.map(c => c.displayId), ['FAKEM1']);
  assert.deepEqual(board.pieces.find(p => p.piece === k)!.desfazer, ['colar']);
  const card = packingCards(q, map, now).find(c => c.displayId === 'FAKEM1')!;
  assert.deepEqual(productionStatus(card, map, state), { pronto: true, pendentes: [] });
  await applyStages(dir, [{ change: { ...change, etapa: 'colar' }, undo: true }], now, dev);
  state = await loadStages(dir);
  assert.deepEqual(productionStatus(card, map, state).pendentes, ['Mão Grinch coração: falta colar nomes']);
  await assert.rejects(applyStages(dir, [{ change }], now, { id: 'x' }), /DEVICE_ID_INVALID/);
  const hist = await loadStageHistory(dir);
  assert.deepEqual(hist.map(h => `${h.acao}:${h.etapa}`), ['voltou:colar', 'feito:colar', 'feito:imprimir', 'feito:nomes']);
  assert.equal(hist[0]!.dispositivo?.nome, 'Mesa 1');
  // Pedido embalado sai do quadro.
  await markPacked(dir, 'shopee|Conta Teste|M1', [], now);
  const { loadPacked } = await import('../apps/production/src/packing-store.js');
  assert.equal(buildStageBoard(q, map, now, state, await loadPacked(dir)).pieces.some(p => p.card.displayId === 'FAKEM1'), false);
});

test('registro da versão anterior (contagem de etapas) continua valendo', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stages-v1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const kM = pieceKey('shopee|Conta Teste|M1', 'mao_coracao');
  const kB = pieceKey('shopee|Conta Teste|B', 'biscoito');
  await writeFile(join(dir, 'producao.json'), JSON.stringify({ versao: 1, pecas: { [kM]: { feitas: 1, em: new Date(now).toISOString() }, [kB]: { feitas: 2, em: new Date(now).toISOString() } } }));
  const q = queueOf(order('M1', ['mao2'], 'Ana, Bia', 20), order('B', ['bisc'], null, 2));
  const board = buildStageBoard(q, map, now, await loadStages(dir));
  const m = board.pieces.find(p => p.piece === kM)!;
  assert.deepEqual(m.feitas, ['imprimir']);
  assert.deepEqual(m.pendentes, ['nomes']);
  assert.deepEqual(board.prontos.map(c => c.displayId), ['FAKEB']);
  await applyStages(dir, [{ change: { piece: kM, etapa: 'nomes', etapas: m.etapas, pedido: 'M1', peca: 'Mão', quantidade: 2 } }], now, dev);
  const state = await loadStages(dir);
  assert.deepEqual(state.get(kM)?.feitas, ['imprimir', 'nomes']);
  assert.equal(state.get(kB)?.feitas, 2, 'o que não mudou fica como estava');
});

test('painel: flag desligada mantém a Produção antiga; ligada mostra "O que imprimir agora" e grava etapas com o aparelho', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stg-panel-'));
  const packDir = await mkdtemp(join(tmpdir(), 'stg-pack-'));
  t.after(() => Promise.all([dir, packDir].map(d => rm(d, { recursive: true, force: true }))));
  const q = queueOf(order('M1', ['mao2'], '<i>Ana, Bia', 20), order('SEM', ['mao2'], null, 3), order('B', ['bisc'], null, 2));
  await writeFile(join(dir, 'production-queue.json'), JSON.stringify(q));
  await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(q)));
  const config = { token, dataDir: dir, timezone: 'America/Sao_Paulo', keywords: ['natal'], now: () => now };
  const production = { map, historyLoader: async () => [], filas: true, embalagem: { dir: packDir } };
  const off = createPanelHandler({ ...config, production });
  const on = createPanelHandler({ ...config, production: { ...production, etapas: true } });
  const strip = (s: string) => s.replace(/nonce(-|=")[A-Za-z0-9+/=]+/g, 'nonce');

  const old = await request(off, base + '/producao');
  assert.doesNotMatch(old.body, /Marcar como impressas/);
  assert.equal((await request(off, base + '/etapa', 'POST', [['e', 'imprimir']])).status, 404);
  assert.equal(strip((await request(on, base + '/producao?ver=detalhes')).body), strip(old.body), 'detalhes = página antiga');

  jar = '';
  const first = await request(on, base + '/producao');
  assert.equal(first.status, 200);
  assert.match(first.headers['Set-Cookie'] ?? '', /^axf_dev=[A-Z2-9]{8}~/);
  assert.match(first.body, /🖨️ O que imprimir agora/);
  assert.match(first.body, /Marcar como impressas/);
  assert.match(first.body, /&lt;i&gt;Ana/);
  assert.doesNotMatch(first.body, /<i>Ana/);
  assert.match(first.body, /não mandou os nomes|⛔ 1/);
  const kM = pieceKey('shopee|Conta Teste|M1', 'mao_coracao');
  const kB = pieceKey('shopee|Conta Teste|B', 'biscoito');
  assert.ok(first.body.indexOf(`value="${kB}"`) < first.body.indexOf(`value="${kM}"`) || first.body.includes('Biscoito'));

  // Sem cookie não grava.
  assert.equal((await request(on, base + '/etapa', 'POST', [['e', 'imprimir'], ['p', kM]], 'outro=1')).status, 428);
  assert.equal((await request(on, base + '/etapa', 'GET')).status, 405);
  assert.equal((await request(on, base + '/etapa', 'POST', [['e', 'xxx'], ['p', kM]])).status, 400);
  assert.equal((await request(on, base + '/etapa', 'POST', [['e', 'imprimir']])).status, 422);
  // Pedido travado não pode ser marcado.
  const kSem = pieceKey('shopee|Conta Teste|SEM', 'mao_coracao');
  const blocked = await request(on, base + '/etapa', 'POST', [['e', 'imprimir'], ['p', kSem]]);
  assert.equal(blocked.status, 422);

  // Nomes 3D já aparecem antes de imprimir a mão: são os nomes do pedido no UpSeller.
  const names0 = await request(on, base + '/producao?ver=nomes');
  assert.match(names0.body, /🔠 Nomes 3D para imprimir/);
  assert.match(names0.body, /📋 Copiar 2 nomes/);
  assert.match(names0.body, /Marcar nomes como impressos/);
  const namesMarked = await request(on, base + '/etapa', 'POST', [['e', 'nomes'], ['p', kM]]);
  assert.equal(namesMarked.status, 200);
  assert.match(namesMarked.body, /2 nome\(s\) 3D marcados como impressos/);
  assert.equal((await request(on, base + '/etapa', 'POST', [['e', 'colar'], ['p', kM]])).status, 422, 'mão ainda não impressa');

  const marked = await request(on, base + '/etapa', 'POST', [['e', 'imprimir'], ['p', kM], ['p', kB]]);
  assert.equal(marked.status, 200);
  assert.match(marked.body, /6 peça\(s\) marcadas/);
  const again = await request(on, base + '/etapa', 'POST', [['e', 'imprimir'], ['p', kM]]);
  assert.equal(again.status, 422, 'já saiu da etapa');
  const colar = await request(on, base + '/producao?ver=colar');
  assert.match(colar.body, /Marcar nomes colados/);
  assert.match(colar.body, /desfazer “Imprimir peças”/);
  assert.match(colar.body, /desfazer “Imprimir nomes 3D”/);
  const sep = await request(on, base + '/producao?ver=separar');
  assert.match(sep.body, /4 peças/);

  const undo = await request(on, base + '/etapa-voltar', 'POST', [['v', `imprimir:${kM}`]]);
  assert.equal(undo.status, 200);
  assert.match(undo.body, /Desfeito: &quot;Imprimir peças&quot;|Desfeito: "Imprimir peças"/);
  assert.equal((await request(on, base + '/etapa-voltar', 'POST', [['v', `imprimir:${kM}`]])).status, 404);
  assert.equal((await request(on, base + '/etapa-voltar', 'POST', [['v', kM]])).status, 404);
  const hist = await request(on, base + '/producao?ver=historico');
  assert.match(hist.body, /Mão Grinch coração/);
  assert.match(hist.body, /↩️ Imprimir peças/);
  assert.match(hist.body, /✅ Imprimir nomes 3D/);
  const state = await loadStages(packDir);
  assert.deepEqual(state.get(kM)?.feitas, ['nomes']);
  assert.deepEqual(state.get(kB)?.feitas, ['imprimir']);
  const raw = await readFile(join(packDir, 'producao-historico.jsonl'), 'utf8');
  assert.equal(raw.trim().split('\n').length, 4);
  assert.match(raw, new RegExp(`"id":"${jar.split('=')[1]!.split('~')[0]}"`));
});

test('foto: cada pedido mostra a foto do anúncio; o grupo usa a de um kit só daquela peça', async () => {
  const withImg = (o: ReturnType<typeof order>, img: string) => ({ ...o, orderItemList: o.orderItemList.map(i => ({ ...i, productImg: img })) });
  const q = queueOf(withImg(order('MIX', ['mix'], null, 2), 'https://img.test/misto.jpg'), withImg(order('B', ['bisc'], null, 8), 'https://img.test/biscoito.jpg'));
  const board = buildStageBoard(q, map, now, new Map());
  assert.deepEqual(board.byStage.imprimir.map(p => `${p.card.displayId}:${p.componentId}:${p.unica}`), ['FAKEMIX:biscoito:false', 'FAKEMIX:elfo:false', 'FAKEB:biscoito:true']);
  const { renderStageBoard } = await import('../apps/panel/src/render-stages.js');
  const html = renderStageBoard(q, map, new Map(), new Map(), { now, nonce: 'n', timezone: 'America/Sao_Paulo', device: dev,
    paths: { board: '/b', mark: '/m', undo: '/u', rename: '/r', list: '/l', packing: '/e', print: '/i', details: '/d' } });
  const biscoitoGroup = html.slice(html.indexOf('Biscoito natalino') - 400, html.indexOf('Biscoito natalino'));
  assert.match(biscoitoGroup, /<img src="https:\/\/img\.test\/biscoito\.jpg"/, 'grupo do biscoito usa a foto do kit só de biscoito');
  assert.match(html, /class="thumb" src="https:\/\/img\.test\/misto\.jpg"/, 'o pedido misto mostra a própria foto');
  assert.doesNotMatch(html, /🎄/);
});
