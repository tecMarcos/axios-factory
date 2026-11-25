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
import { classifyPackTime, loadHistory, loadPacked } from '../apps/production/src/packing-store.js';
import { createPackTimer } from '../apps/panel/src/pack-timer.js';
import { formatDuration } from '../apps/panel/src/render-workflow.js';

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


test('tempo de embalagem: rápido demais acende alerta, longo demais fica fora da média', () => {
  assert.deepEqual(classifyPackTime(5), { segundos: 5, status: 'rapido' });
  assert.deepEqual(classifyPackTime(19.6), { segundos: 20, status: 'normal' });
  assert.deepEqual(classifyPackTime(60), { segundos: 60, status: 'normal' });
  assert.deepEqual(classifyPackTime(15 * 60), { segundos: 900, status: 'normal' });
  assert.deepEqual(classifyPackTime(15 * 60 + 1), { segundos: 901, status: 'fora' });
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(65), '1min 05s');
  assert.equal(formatDuration(2 * 3600 + 600), '2h 10min');
});

test('cronômetro: carimbo assinado vale só para o mesmo pedido e aparelho', () => {
  const timer = createPackTimer();
  const t0 = timer.start('shopee|A|1', 'ABCD2345', now);
  assert.equal(timer.elapsed(t0, 'shopee|A|1', 'ABCD2345', now + 42_000), 42);
  assert.equal(timer.elapsed(t0, 'shopee|A|2', 'ABCD2345', now + 42_000), null, 'outro pedido');
  assert.equal(timer.elapsed(t0, 'shopee|A|1', 'ZZZZ2345', now + 42_000), null, 'outro aparelho');
  const [at, sig] = t0.split('.');
  assert.equal(timer.elapsed(`${Number(at) + 30_000}.${sig}`, 'shopee|A|1', 'ABCD2345', now + 42_000), null, 'hora trocada');
  assert.equal(timer.elapsed(t0, 'shopee|A|1', 'ABCD2345', now - 60_000), null, 'carimbo do futuro');
  assert.equal(createPackTimer().elapsed(t0, 'shopee|A|1', 'ABCD2345', now + 1000), null, 'painel reiniciado: sem tempo');
  assert.equal(timer.elapsed('', 'shopee|A|1', 'ABCD2345', now), null);
  assert.equal(timer.elapsed('abc', 'shopee|A|1', 'ABCD2345', now), null);
});

test('painel: tempo oculto do bipar ao salvar; alerta, média e descarte no Histórico', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ptime-'));
  const packDir = await mkdtemp(join(tmpdir(), 'ptime-pack-'));
  t.after(() => Promise.all([dir, packDir].map(d => rm(d, { recursive: true, force: true }))));
  const q = queueOf(order('RAP1', ['elfo'], null, 5), order('NOR1', ['elfo'], null, 6), order('FOR1', ['elfo'], null, 7), order('SEM1', ['elfo'], null, 8));
  await writeFile(join(dir, 'production-queue.json'), JSON.stringify(q));
  await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(q)));
  let clock = now;
  const on = createPanelHandler({ token, dataDir: dir, timezone: 'America/Sao_Paulo', keywords: ['natal'], now: () => clock,
    production: { map, historyLoader: async () => [], filas: true, embalagem: { dir: packDir } } });
  jar = '';
  await request(on, base + '/embalar');
  await request(on, base + '/aparelho', 'POST', [['n', 'Joana']]);
  const yes = (k: string, t0?: string): [string, string][] => [['k', k], ...(t0 ? [['t0', t0] as [string, string]] : []), ['q', 'peca:elfo'], ['q', 'peca:cordao_vermelho']];
  const pack = async (code: string, seconds: number, keepToken = true) => {
    const scan = await request(on, base + '/embalar', 'POST', [['c', `FAKE${code}`]]);
    const t0 = /name="t0" value="([^"]+)"/.exec(scan.body)?.[1];
    assert.ok(t0, 'o pedido aberto leva o carimbo escondido');
    assert.doesNotMatch(scan.body, /⏱️|cronômetro/i, 'quem embala não vê o tempo');
    clock += seconds * 1000;
    const done = await request(on, base + '/embalado', 'POST', yes(`shopee|Conta Teste|${code}`, keepToken ? t0 : undefined));
    assert.equal(done.status, 200);
    assert.doesNotMatch(done.body, /⏱️|⚠️ \d/, 'tela de "embalado" também não mostra o tempo');
  };
  await pack('RAP1', 5);
  await pack('NOR1', 70);
  await pack('FOR1', 40 * 60);
  await pack('SEM1', 30, false);
  const packed = await loadPacked(packDir);
  assert.deepEqual(packed.get('shopee|Conta Teste|RAP1')?.tempo, { segundos: 5, status: 'rapido' });
  assert.deepEqual(packed.get('shopee|Conta Teste|NOR1')?.tempo, { segundos: 70, status: 'normal' });
  assert.deepEqual(packed.get('shopee|Conta Teste|FOR1')?.tempo, { segundos: 2400, status: 'fora' });
  assert.equal(packed.get('shopee|Conta Teste|SEM1')?.tempo, undefined, 'sem carimbo: embala, mas sem tempo');
  const events = await loadHistory(packDir);
  assert.deepEqual(events.map(e => e.tempo?.status ?? '-'), ['-', 'fora', 'normal', 'rapido']);

  const embalados = (await request(on, base + '/embalar?ver=embalados')).body;
  assert.match(embalados, /⚠️ 5s · rápido demais: não seguiu o processo\?/);
  assert.match(embalados, /⏱️ 1min 10s/);
  assert.match(embalados, /⏱️ 40min 00s · fora da média/);
  const hist = (await request(on, base + '/embalar?ver=historico')).body;
  assert.match(hist, /Média 1min 10s<\/strong> · mediana 1min 10s · 1 pedido contados/);
  assert.match(hist, /⚠️ 1 rápido demais/);
  assert.match(hist, /1 descartado/);
  assert.match(hist, /<td>Joana · [A-Z2-9]{8}<\/td><td>1min 10s<\/td><td>1<\/td><td>⚠️ 1<\/td><td>1<\/td>/);
});
