import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { aggregateProduction, calculatePriority, type Priority } from '../apps/collector/src/operational.js';
import { buildOperationalMessage, buildPriorityAlert, validateSnapshot, type Queue } from '../apps/collector/src/notifications.js';
import { runNotifications, writeNotificationState, ConsoleNotificationSender } from '../apps/collector/src/notification-runner.js';
const now = Date.parse('2026-10-08T12:00:00.000Z'), opts = { now, dryRun: true };
function fixture(hours = [-38, 3, 12, 36, 72, 80]): Queue {
  return { generatedAt: new Date(now).toISOString(), orders: hours.map((h, i) => ({ orderNumber: `ORDER${i}`, priority: calculatePriority(now + h * 3600000, now), deadlineEpoch: now + h * 3600000, deadline: new Date(now + h * 3600000).toISOString(), hoursRemaining: h, queues: ['TO_SHIP'], operationalStage: 'NEEDS_SHIPPING', items: [{ productId: `p${i}`, variationId: 'v', productName: `Produto ${i}`, productAttr: 'Azul', quantity: i + 1 }] })) };
}
const message = (q = fixture(), extra = {}) => buildOperationalMessage(aggregateProduction(q), q, { ...opts, ...extra });
async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'notification-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function snapshot(dir: string, q: Queue) { await writeFile(join(dir, 'production-queue.json'), JSON.stringify(q)); await writeFile(join(dir, 'production-summary.json'), JSON.stringify(aggregateProduction(q))); }
test('DAILY_SUMMARY includes priority counts, orders and units deterministically', () => { const m = message(); assert.match(m, /Atrasados: 1/); assert.match(m, /Críticos: 1/); assert.match(m, /Urgentes: 1/); assert.match(m, /Atenção: 1/); assert.match(m, /Pedidos: 6\nUnidades: 21/); assert.equal(m, message()); });
test('zero priorities omitted', () => assert.doesNotMatch(message(fixture([36])), /Atrasados|Críticos|Urgentes/));
test('top products and remainder follow V0.3 order', () => { const m = message(fixture(), { topProducts: 2 }); assert.match(m, /1x Produto 0/); assert.match(m, /2x Produto 1/); assert.doesNotMatch(m, /Produto 2/); assert.match(m, /\+ 4 outros itens na fila/); });
test('future deadline independent of oldest overdue', () => { assert.match(message(), /Atraso mais antigo: 38h/); assert.match(message(), /Próximo prazo: 08\/10\/2026, 12:00/); });
test('no future deadline', () => assert.match(message(fixture([-1])), /nenhum conhecido/));
test('business timezone explicit', () => assert.match(message(fixture([3]), { timezone: 'UTC' }), /15:00/));
test('daily never mutates queue or summary', () => { const q = fixture(), s = aggregateProduction(q), before = JSON.stringify({ q, s }); buildOperationalMessage(s, q, opts); assert.equal(JSON.stringify({ q, s }), before); });
for (const [from, hours, type] of [['ATTENTION', 12, 'NEW_URGENT'], ['URGENT', 3, 'NEW_CRITICAL'], ['CRITICAL', -1, 'NEW_OVERDUE']] as const) {
  test(type + ' transition and no repeated alert', async t => { const dir = await setup(t), q = fixture([hours]); await snapshot(dir, q); await writeNotificationState(join(dir, 'notification-state.json'), { version: 1, orders: { ORDER0: { lastPriority: from, lastAlertedPriority: null } } }); const logs: Record<string, unknown>[] = []; await runNotifications('check', dir, opts, e => logs.push(e)); assert.equal(logs.filter(e => e.type === type && e.event === 'notification_dry_run').length, 1); logs.length = 0; await runNotifications('check', dir, { ...opts, dryRun: false }, e => logs.push(e), { send: async () => {} }); logs.length = 0; await runNotifications('check', dir, opts, e => logs.push(e)); assert.equal(logs.filter(e => e.event === 'notification_dry_run').length, 0); });
}
test('silent bootstrap persists current priorities without sent markers', async t => { const dir = await setup(t); await snapshot(dir, fixture([-1])); const logs: unknown[] = []; await runNotifications('check', dir, { ...opts, dryRun: false }, e => logs.push(e), { send: async () => assert.fail('silent bootstrap') }); const s = JSON.parse(await readFile(join(dir, 'notification-state.json'), 'utf8')); assert.deepEqual(s.orders.ORDER0, { lastPriority: 'OVERDUE', lastAlertedPriority: null }); assert.equal(logs.length, 1); assert.match(JSON.stringify(logs), /notification_bootstrap/); });
test('dry run never invokes sender and does not mark as sent', async t => { const dir = await setup(t); await snapshot(dir, fixture([12])); await writeNotificationState(join(dir, 'notification-state.json'), { version: 1, orders: { ORDER0: { lastPriority: 'ATTENTION', lastAlertedPriority: null } } }); await runNotifications('check', dir, opts, () => {}, { send: async () => { assert.fail('network'); } }); assert.equal(JSON.parse(await readFile(join(dir, 'notification-state.json'), 'utf8')).orders.ORDER0.lastAlertedPriority, null); });
test('failed delivery preserves exact state and can retry', async t => { const dir = await setup(t), path = join(dir, 'notification-state.json'); await snapshot(dir, fixture([12])); await writeNotificationState(path, { version: 1, orders: { ORDER0: { lastPriority: 'ATTENTION', lastAlertedPriority: null } } }); const before = await readFile(path, 'utf8'); await assert.rejects(runNotifications('check', dir, { ...opts, dryRun: false }, () => {}, { send: async () => { throw new Error('secret-token'); } })); assert.equal(await readFile(path, 'utf8'), before); await runNotifications('check', dir, { ...opts, dryRun: false }, () => {}, { send: async () => { assert.equal(await readFile(path, 'utf8'), before); } }); assert.equal(JSON.parse(await readFile(path, 'utf8')).orders.ORDER0.lastAlertedPriority, 'URGENT'); });
test('atomic replacement leaves old inode intact and no temporary file', async t => { const dir = await setup(t), path = join(dir, 'notification-state.json'); await writeFile(path, 'old'); const old = await open(path, 'r'); try { await writeNotificationState(path, { version: 1, orders: {} }); assert.equal(await old.readFile('utf8'), 'old'); assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1); assert.deepEqual(await readdir(dir), ['notification-state.json']); } finally { await old.close(); } });
test('PII fields absent from daily and alert', () => { const q = fixture([12]); Object.assign(q.orders[0]!, { buyerName: 'Secret Person', buyerAccount: 'private@x', address: 'Hidden Road', phone: '99999999999', tracking: 'TRACKSECRET', cpf: '12345678900', token: 'token-secret', cookie: 'cookie-secret' }); const s = aggregateProduction(q); const m = buildOperationalMessage(s, q, opts) + buildPriorityAlert('NEW_URGENT', q.orders[0]!, s, opts); for (const v of ['Secret Person', 'private@x', 'Hidden Road', '99999999999', 'TRACKSECRET', '12345678900', 'token-secret', 'cookie-secret', 'ORDER0']) assert.ok(!m.includes(v)); });
for (const file of ['production-queue.json', 'production-summary.json']) test(file + ' invalid fails closed without state/logs', async t => { const dir = await setup(t); await snapshot(dir, fixture()); await writeFile(join(dir, file), '{}'); const logs: unknown[] = []; await assert.rejects(runNotifications('check', dir, opts, e => logs.push(e))); assert.equal(logs.length, 0); assert.ok(!(await readdir(dir)).includes('notification-state.json')); });
test('inconsistent summary rejected', () => { const q = fixture(), s = aggregateProduction(q); s.totals.units++; assert.throws(() => validateSnapshot(q, s)); });
test('duplicate order rejected', () => { const q = fixture(); q.orders.push(q.orders[0]!); assert.throws(() => validateSnapshot(q, aggregateProduction(q))); });
test('corrupt state is not silently bootstrapped', async t => { const dir = await setup(t); await snapshot(dir, fixture()); const path = join(dir, 'notification-state.json'); await writeFile(path, '{}'); await assert.rejects(runNotifications('check', dir, opts, () => {})); assert.equal(await readFile(path, 'utf8'), '{}'); });
test('disabled real sender fails closed', async t => { const dir = await setup(t); await snapshot(dir, fixture()); await assert.rejects(runNotifications('daily', dir, { ...opts, dryRun: false }, () => {}), /NOT_CONFIGURED/); });
test('ConsoleNotificationSender logs only message', async () => { const logs: unknown[] = []; await new ConsoleNotificationSender(e => logs.push(e)).send('safe'); assert.deepEqual(logs, [{ event: 'notification_dry_run', message: 'safe' }]); });
test('CLI daily and check execute standalone', async t => { const dir = await setup(t); await snapshot(dir, fixture()); for (const mode of ['daily', 'check']) { const output = execFileSync(process.execPath, ['--import', 'tsx', 'apps/collector/src/notify-cli.ts', mode], { env: { ...process.env, DATA_DIR: dir, NOTIFICATION_DRY_RUN: 'true', NOTIFICATION_BOOTSTRAP_MODE: 'silent' }, encoding: 'utf8' }); assert.match(output, mode === 'daily' ? /DAILY_SUMMARY/ : /notification_bootstrap/); } });

test('dry-run preserves exact state and does not create a bootstrap state', async t => {
  const dir = await setup(t); await snapshot(dir, fixture([12]));
  await runNotifications('check', dir, opts, () => {});
  await assert.rejects(readFile(join(dir, 'notification-state.json')), { code: 'ENOENT' });
  const path = join(dir, 'notification-state.json');
  await writeNotificationState(path, { version: 1, orders: { ORDER0: { lastPriority: 'ATTENTION', lastAlertedPriority: null } } });
  const before = await readFile(path, 'utf8');
  await runNotifications('check', dir, opts, () => {});
  assert.equal(await readFile(path, 'utf8'), before);
});

for (const mode of ['daily', 'check'] as const) test(`CLI ${mode}: Evolution delivery, failure and disabled state safety`, async t => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const dir = await setup(t); await snapshot(dir, fixture([12]));
  const path = join(dir, 'notification-state.json');
  await writeNotificationState(path, { version: 1, orders: { ORDER0: { lastPriority: 'ATTENTION', lastAlertedPriority: null } } });
  const before = await readFile(path, 'utf8');
  let status = 500, calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, '/message/sendText/test');
    assert.equal(req.headers.apikey, 'private-test-key');
    assert.equal(req.headers['content-type'], 'application/json');
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); assert.equal(data.number, '123456789@g.us'); assert.equal(typeof data.text, 'string');
    assert.deepEqual(Object.keys(data).sort(), ['number', 'text']);
    res.writeHead(status); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { ...process.env, DATA_DIR: dir, NOTIFICATION_DRY_RUN: 'false', WHATSAPP_ENABLED: 'true', NOTIFICATION_BOOTSTRAP_MODE: 'silent', EVOLUTION_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, EVOLUTION_API_KEY: 'private-test-key', EVOLUTION_INSTANCE: 'test', WHATSAPP_RECIPIENT_JID: '123456789@g.us' };
  const run = (extra = {}) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'apps/collector/src/notify-cli.ts', mode], { env: { ...env, ...extra } });
  await assert.rejects(run({ WHATSAPP_ENABLED: 'false' })); assert.equal(calls, 0);
  await run({ NOTIFICATION_DRY_RUN: 'true' }); assert.equal(calls, 0);
  assert.equal(await readFile(path, 'utf8'), before);
  await assert.rejects(run()); assert.equal(calls, 1); assert.equal(await readFile(path, 'utf8'), before);
  status = 201;
  const result = await run(); assert.equal(calls, 2);
  assert.ok(!result.stdout.includes('private-test-key')); assert.ok(!result.stdout.includes('123456789@g.us'));
  if (mode === 'check') assert.equal(JSON.parse(await readFile(path, 'utf8')).orders.ORDER0.lastAlertedPriority, 'URGENT');
  else assert.equal(await readFile(path, 'utf8'), before);
});
