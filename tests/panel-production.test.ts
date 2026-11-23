import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalize } from '../apps/collector/src/core.js';
import { aggregateProduction, buildProductionQueue } from '../apps/collector/src/operational.js';
import { personalizationStatus } from '../apps/collector/src/orders-view.js';
import { renderPanel } from '../apps/panel/src/render.js';
import { createPanelHandler } from '../apps/panel/src/server.js';
import { validateComponentMap } from '../apps/production/src/component-map.js';
import { buildProductionView } from '../apps/production/src/production.js';

const now = Date.parse('2026-11-23T12:00:00Z');
const token = 'fake-panel-token-1234567890';
const base = `/p/${token}`;
const timezone = 'America/Sao_Paulo';
const map = validateComponentMap({
  versao: 1, componentes: { mao_bolinha: { nome: 'Bolinha', personalizado: true } }, deteccaoNatal: ['natal'],
  variantes: { v1: { productId: 'p1', anuncio: 'Bolinha Natal', variante: '1un', componentes: { mao_bolinha: 1 }, confirmado: false } },
});
const queue = (productName: string, note: string | null, generatedAt = now) => buildProductionQueue([{
  ...normalize({
    orderNumber: 'UP1', orderId: 'FAKE01', platform: 'shopee', orderComment: note,
    orderItemList: [{ productId: 'p1', variationId: productName === 'Caneca' ? 'v2' : 'v1', productName, productAttr: '1un', productCount: 1 }],
  }), queues: ['TO_SHIP'], account: 'Conta Teste',
}], generatedAt, [{ name: 'Conta Teste', ok: false, error: 'AUTH_REQUIRED', orders: 0 }]);

async function request(handler: ReturnType<typeof createPanelHandler>, url: string, method = 'GET') {
  const req = { url, method } as IncomingMessage;
  let status = 0, headers: Record<string, string> = {}, body = '';
  const res = {
    req,
    writeHead(code: number, values: Record<string, string>) { status = code; headers = values; },
    end(value?: string) { body = value ?? ''; },
  } as unknown as ServerResponse;
  await handler(req, res);
  return { status, headers, body };
}

test('production route is opt-in, preserves token and HEAD handling, and escapes names', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'panel-production-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const q = queue('Bolinha Natal', '<script>', now - 100 * 60000);
  await writeFile(join(dir, 'production-queue.json'), JSON.stringify(q));
  await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(q)));
  const config = { token, dataDir: dir, timezone, keywords: ['natal'], now: () => now };
  const off = createPanelHandler(config);
  assert.deepEqual(await request(off, base + '/producao'), await request(off, base + '/xyz'));
  assert.doesNotMatch((await request(off, base)).body, /🧩 Produção/);

  const on = createPanelHandler({ ...config, production: { map, envLabel: 'STAGING — dados anonimizados', historyLoader: async () => [] } });
  assert.match((await request(on, base)).body, /🧩 Produção/);
  const page = await request(on, base + '/producao');
  assert.equal(page.status, 200);
  const nonce = /style-src 'nonce-([^']+)'/.exec(page.headers['Content-Security-Policy']!)![1];
  assert.ok(page.body.includes(`<style nonce="${nonce}">`));
  assert.match(page.body, /&lt;script&gt;/);
  assert.doesNotMatch(page.body, /<script/);
  for (const label of ['STAGING — dados anonimizados', 'Saúde da sincronização', 'Peças a produzir', 'Pedidos natalinos', 'Variantes natalinas sem mapa', 'login expirou', 'nenhuma coleta nova desde']) {
    assert.ok(page.body.includes(label), label);
  }
  const head = await request(on, base + '/producao', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await request(on, '/p/wrong/producao')).status, 404);
  assert.equal((await request(on, base + '/producao', 'POST')).status, 405);
});

test('ordinary rendering and legacy personalization stay independent of the env flag', t => {
  const previous = process.env.CENTRAL_PRODUCAO;
  t.after(() => {
    if (previous === undefined) delete process.env.CENTRAL_PRODUCAO;
    else process.env.CENTRAL_PRODUCAO = previous;
  });
  const q = queue('Caneca', 'Ana');
  const options = { now, timezone, nonce: 'fixed' };
  process.env.CENTRAL_PRODUCAO = '0';
  const before = renderPanel(q, options);
  process.env.CENTRAL_PRODUCAO = '1';
  assert.equal(renderPanel(q, options), before);
  assert.deepEqual(buildProductionView(q, map, now).orders, []);
  assert.equal(personalizationStatus(q.orders[0]!), 'NOT_NEEDED');
  assert.equal(personalizationStatus(queue('Bolinha Natal', 'Ana').orders[0]!), 'OK');
});
