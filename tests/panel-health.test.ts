import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { normalize } from '../apps/collector/src/core.js';
import { nextHealth, writeHealth } from '../apps/collector/src/health.js';
import { recordNotify, writeNotifyHealth } from '../apps/collector/src/notify-health.js';
import { aggregateProduction, buildProductionQueue } from '../apps/collector/src/operational.js';
import { renderProduction } from '../apps/panel/src/render-production.js';
import { renderPanel } from '../apps/panel/src/render.js';
import { createPanelHandler } from '../apps/panel/src/server.js';
import { validateComponentMap } from '../apps/production/src/component-map.js';

const now = Date.parse('2026-11-23T12:00Z'), timezone = 'America/Sao_Paulo', token = 'fake-panel-token-1234567890';
const base = '/p/' + token;
const map = validateComponentMap({ versao: 1, componentes: {}, deteccaoNatal: ['natal'], variantes: {} });
const privateNote = 'Nome privado do comprador';
const order = normalize({ orderNumber: 'ORDER1', orderComment: privateNote, orderItemList: [] });
const account = { name: '<img src=x>', ok: false, error: 'AUTH_REQUIRED', orders: 0 };
const queue = buildProductionQueue([{ ...order, queues: ['TO_SHIP'] }], now, [account]);

async function setup(t: TestContext) {
  const dir = await mkdtemp('.panel-health-test-'); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'production-queue.json'), JSON.stringify(queue));
  await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(queue)));
  return { token, dataDir: dir, timezone, keywords: [], now: () => now, production: { map, historyLoader: async () => [] } };
}
async function request(handler: ReturnType<typeof createPanelHandler>, url: string) {
  const req = { url, method: 'GET' } as IncomingMessage;
  let status = 0, headers: Record<string, string> = {}, body = '';
  const res = {
    req, writeHead(code: number, values: Record<string, string>) { status = code; headers = values; },
    end(value?: string) { body = value ?? ''; },
  } as unknown as ServerResponse;
  await handler(req, res);
  const nonce = /style-src 'nonce-([^']+)'/.exec(headers['Content-Security-Policy'] ?? '')?.[1] ?? '';
  return { status, headers, body, nonce };
}

test('flag off leaves list and production HTML byte-identical and health route hidden', async t => {
  const config = await setup(t), handler = createPanelHandler(config);
  await writeHealth(config.dataDir, nextHealth(null, { at: now, statuses: [account], runError: null }));
  const list = await request(handler, base);
  assert.equal(list.body, renderPanel(queue, { now, timezone, nonce: list.nonce, personalizationKeywords: [], scanHref: base + '/bipar', productionHref: base + '/producao' }));
  const production = await request(handler, base + '/producao');
  assert.equal(production.body, renderProduction(queue, map, [], { now, timezone, nonce: production.nonce, listHref: base, refreshSeconds: 120 }));
  assert.doesNotMatch(list.body + production.body, /monitor-line|Alertas do monitor/);
  assert.equal((await request(handler, base + '/saude.json')).status, 404);
});

test('flag on shows escaped alerts on both pages and health-only JSON when snapshot is missing', async t => {
  const config = await setup(t), handler = createPanelHandler({ ...config, health: { config: {} } });
  const health = nextHealth(null, { at: now, statuses: [account], runError: null });
  await writeHealth(config.dataDir, health);
  const notify = recordNotify(null, 'whatsapp', { at: now, result: 'failed', errorCode: 'WHATSAPP_HTTP_ERROR', httpStatus: 500 });
  await writeNotifyHealth(config.dataDir, notify);
  for (const url of [base, base + '/producao']) {
    const page = await request(handler, url);
    assert.match(page.body, /class="monitor-line"><strong>Conta desconectada: &lt;img src=x&gt;/);
    assert.doesNotMatch(page.body, /<img src=x>/);
    if (url === base) assert.ok(page.body.indexOf('class="monitor-line"') < page.body.indexOf('class="alert"'));
  }
  const url = base + '/saude.json';
  const response = await request(handler, url);
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.match(response.headers['Content-Type']!, /^application\/json/);
  const json = JSON.parse(response.body);
  assert.deepEqual(Object.keys(json), ['generatedAt', 'ok', 'alerts', 'accounts', 'notify', 'lastRunAt']);
  assert.equal(json.generatedAt, new Date(now).toISOString());
  assert.equal(json.lastRunAt, health.lastRunAt);
  assert.equal(json.ok, false);
  assert.deepEqual(json.accounts, [{ name: account.name, ok: false, error: 'AUTH_REQUIRED', lastSuccessAt: null, consecutiveFailures: 1, sessionAgeDays: null }]);
  assert.deepEqual(json.notify, notify.channels);
  assert.doesNotMatch(response.body, /Nome privado|ORDER1|fake-panel-token/);
  assert.equal((await request(handler, '/p/wrong/saude.json')).status, 404);
  await unlink(join(config.dataDir, 'production-queue.json'));
  assert.deepEqual(JSON.parse((await request(handler, url)).body), json);
  assert.equal((await request(handler, base)).status, 503);
});

test('healthy flag-on list has no bar and production shows the last collection time', async t => {
  const config = await setup(t), handler = createPanelHandler({ ...config, health: { config: {} } });
  await writeHealth(config.dataDir, nextHealth(null, { at: now, statuses: [{ ...account, ok: true, error: null }], runError: null }));
  assert.doesNotMatch((await request(handler, base)).body, /Alertas do monitor|Monitor: tudo OK/);
  assert.match((await request(handler, base + '/producao')).body, /Monitor: tudo OK · última coleta 09:00/);
  assert.equal(JSON.parse((await request(handler, base + '/saude.json')).body).ok, true);
});
