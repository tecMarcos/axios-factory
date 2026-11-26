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
import { loadPacked } from '../apps/production/src/packing-store.js';
import { liveScript } from '../apps/panel/src/live.js';

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



type Phone = { jar: string };
async function call(handler: ReturnType<typeof createPanelHandler>, phone: Phone, url: string, method = 'GET', fields?: [string, string][]) {
  jar = phone.jar;
  const r = await request(handler, url, method, fields, phone.jar);
  phone.jar = jar;
  return r;
}

test('dois celulares: um vê quando o outro abre e quando embala o pedido', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'live-'));
  const packDir = await mkdtemp(join(tmpdir(), 'live-pack-'));
  t.after(() => Promise.all([dir, packDir].map(d => rm(d, { recursive: true, force: true }))));
  const q = queueOf(order('AAA1', ['elfo'], null, 5), order('BBB1', ['elfo'], null, 6), order('SEM1', ['mao2'], null, 7));
  await writeFile(join(dir, 'production-queue.json'), JSON.stringify(q));
  await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(q)));
  let clock = now;
  const on = createPanelHandler({ token, dataDir: dir, timezone: 'America/Sao_Paulo', keywords: ['natal'], now: () => clock,
    production: { map, historyLoader: async () => [], filas: true, embalagem: { dir: packDir }, etapas: true } });
  const joana: Phone = { jar: '' }, marcos: Phone = { jar: '' };
  await call(on, joana, base + '/embalar');
  await call(on, joana, base + '/aparelho', 'POST', [['n', 'Joana']]);
  const page = await call(on, marcos, base + '/embalar');
  assert.equal(page.headers['Cache-Control'], 'no-store', 'o celular não guarda cópia velha');
  assert.match(page.headers['Content-Security-Policy'] ?? '', /connect-src 'self'/);
  assert.match(page.body, /data-key="shopee\|Conta Teste\|AAA1"/);
  assert.match(page.body, /<span data-count="fila">2<\/span>/);
  assert.match(page.body, new RegExp(`${base.replace(/[/]/g, '\\/')}\\/ao-vivo\\.json`));
  const state = async (p: Phone) => {
    const r = await call(on, p, base + '/ao-vivo.json');
    assert.equal(r.status, 200);
    assert.equal(r.headers['Cache-Control'], 'no-store');
    return JSON.parse(r.body) as { v: string; vp: string; embalados: Record<string, { por: string; meu: boolean }>; andamento: Record<string, { por: string; meu: boolean }>; contagem: Record<string, number>; fila: string[] };
  };
  const k = 'shopee|Conta Teste|AAA1';
  const before = await state(marcos);
  assert.deepEqual(before.andamento, {});
  assert.deepEqual(before.fila, [k, 'shopee|Conta Teste|BBB1']);
  assert.match(page.body, new RegExp(`"v":|${before.v}`), 'a página nasce com a mesma versão do ao-vivo');

  // Joana bipa o pedido: o Marcos vê que ela está embalando.
  const scan = await call(on, joana, base + '/embalar', 'POST', [['c', 'FAKEAAA1']]);
  assert.match(scan.body, /<div id="live" hidden><\/div>/);
  assert.match(scan.body, /data-confirm/);
  const working = await state(marcos);
  assert.deepEqual(working.andamento[k], { por: 'Joana', outros: 1, desde: new Date(clock).toISOString(), meu: false });
  assert.deepEqual((await state(joana)).andamento[k], { por: '', outros: 0, desde: new Date(clock).toISOString(), meu: true });
  assert.notEqual(working.v, before.v);

  // Joana abre outro pedido: o primeiro fica livre.
  await call(on, joana, base + '/embalar', 'POST', [['c', 'FAKEBBB1']]);
  assert.deepEqual(Object.keys((await state(marcos)).andamento), ['shopee|Conta Teste|BBB1']);
  // Pedido travado não conta como "embalando".
  await call(on, joana, base + '/embalar', 'POST', [['c', 'FAKESEM1']]);
  assert.deepEqual((await state(marcos)).andamento, {});

  // Os dois abrem o mesmo pedido: cada um vê o outro (ninguém "toma" o pedido do outro).
  await call(on, joana, base + '/embalar', 'POST', [['c', 'FAKEAAA1']]);
  await call(on, marcos, base + '/aparelho', 'POST', [['n', 'Marcos']]);
  await call(on, marcos, base + '/embalar', 'POST', [['c', 'FAKEAAA1']]);
  assert.deepEqual([(await state(marcos)).andamento[k]!.por, (await state(joana)).andamento[k]!.por], ['Joana', 'Marcos']);
  // Joana embala: some da fila do Marcos na hora, com o nome dela.
  clock += 60_000;
  const done = await call(on, joana, base + '/embalado', 'POST', [['k', k], ['q', 'peca:elfo'], ['q', 'peca:cordao_vermelho']]);
  assert.equal(done.status, 200);
  const after = await state(marcos);
  assert.equal(after.embalados[k]!.por, 'Joana');
  assert.equal(after.embalados[k]!.meu, false);
  assert.deepEqual(after.andamento, {});
  assert.deepEqual(after.fila, ['shopee|Conta Teste|BBB1']);
  assert.equal(after.contagem.fila, 1);
  assert.equal(after.contagem.embalados, 1);
  // O Marcos recarrega (ou já tinha a página aberta e ela se atualizou): o pedido está como embalado.
  assert.match((await call(on, marcos, base + '/embalar?ver=embalados')).body, /Embalado às[\s\S]*por Joana/);
  assert.match((await call(on, marcos, base + '/embalar', 'POST', [['c', 'FAKEAAA1']])).body, /Já embalado[\s\S]*por Joana/);
  assert.equal((await call(on, marcos, base + '/embalado', 'POST', [['k', k], ['q', 'peca:elfo'], ['q', 'peca:cordao_vermelho']])).status, 409, 'não embala duas vezes');
  assert.equal((await loadPacked(packDir)).size, 1);

  // Quem abriu e largou some depois de 15 min.
  await call(on, marcos, base + '/embalar', 'POST', [['c', 'FAKEBBB1']]);
  assert.equal((await state(joana)).andamento['shopee|Conta Teste|BBB1']!.por, 'Marcos');
  clock += 16 * 60_000;
  assert.deepEqual((await state(joana)).andamento, {});

  // Produção: a versão muda quando outro celular marca uma etapa.
  const prod = await call(on, joana, base + '/producao');
  assert.match(prod.body, /ao-vivo\.json/);
  const vp = (await state(joana)).vp;
  assert.match(prod.body, new RegExp(vp));
  const kE = 'shopee|Conta Teste|BBB1#elfo';
  assert.equal((await call(on, marcos, base + '/etapa', 'POST', [['e', 'imprimir'], ['p', kE]])).status, 200);
  const s2 = await state(joana);
  assert.notEqual(s2.vp, vp);
  assert.equal(s2.v, (await state(joana)).v);
});

test('ao-vivo: só existe com a embalagem ligada; o script não monta HTML com o que vem do servidor', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'live-off-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const q = queueOf(order('AAA1', ['elfo'], null, 5));
  await writeFile(join(dir, 'production-queue.json'), JSON.stringify(q));
  await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(q)));
  const off = createPanelHandler({ token, dataDir: dir, timezone: 'America/Sao_Paulo', keywords: ['natal'], now: () => now, production: { map, historyLoader: async () => [], filas: true } });
  assert.equal((await request(off, base + '/ao-vivo.json')).status, 404);
  const js = liveScript({ url: '/x', mode: 'fila', v: '"</script>' });
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(js, /<\/script>/, 'valores escapados dentro do script');
});
