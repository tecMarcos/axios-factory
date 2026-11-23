import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextHealth } from '../apps/collector/src/health.js';
import { evaluateAlerts, healthConfigFromEnv } from '../apps/collector/src/health-alerts.js';
import { recordNotify } from '../apps/collector/src/notify-health.js';
import { normalize } from '../apps/collector/src/core.js';
import { buildProductionQueue } from '../apps/collector/src/operational.js';

const now = Date.parse('2026-11-23T11:51Z'), day = 86400000;
const run = (at: number, error: string | null = null) => ({ at, statuses: [{ name: 'Principal', ok: error === null, error, orders: 0 }], runError: null });
const args = { health: null, notify: null, queue: null, now, timezone: 'America/Sao_Paulo' };
const ids = (alerts: ReturnType<typeof evaluateAlerts>) => alerts.map(a => a.id);

test('missing monitor and auth failure alert immediately, other failures require two runs', () => {
  assert.deepEqual(ids(evaluateAlerts(args)), ['monitor_missing']);
  const good = nextHealth(null, run(now - 60000));
  for (const code of ['AUTH_REQUIRED', 'API_REJECTED_OR_SESSION_EXPIRED']) {
    const health = nextHealth(good, run(now, code)), alerts = evaluateAlerts({ ...args, health });
    assert.deepEqual(ids(alerts), ['account_down:Principal']);
    assert.match(alerts[0]!.detail, /23\/11 08:50.*Falhas seguidas: 1/);
  }
  const first = nextHealth(good, run(now, 'INVALID_JSON'));
  assert.deepEqual(evaluateAlerts({ ...args, health: first }), []);
  const second = nextHealth(first, run(now, 'INVALID_JSON'));
  assert.deepEqual(ids(evaluateAlerts({ ...args, health: second })), ['sync_failing:Principal']);
});

test('stale alerts use the business window and grace from its start', () => {
  const health = nextHealth(null, run(now - day));
  for (const time of ['10:19', '10:25', '11:50', '23:00']) {
    assert.deepEqual(evaluateAlerts({ ...args, health, now: Date.parse(`2026-11-23T${time}Z`) }), []);
  }
  assert.deepEqual(ids(evaluateAlerts({ ...args, health })), ['collector_stale', 'sync_stale:Principal']);
  const config = healthConfigFromEnv({ HEALTH_WINDOW: '08:30-19:50', HEALTH_STALE_MINUTES: '21', SESSION_WARN_DAYS: '10', SESSION_DAYS: '15' });
  assert.deepEqual(config, { window: '08:30-19:50', staleMinutes: 21, sessionWarnDays: 10, sessionDays: 15 });
  assert.deepEqual(evaluateAlerts({ ...args, health, config }), []);
});

test('session age crosses warning at 12 days and critical at 14, with estimate label', () => {
  for (const [age, severity] of [[11, null], [12, 'warning'], [14, 'critical']] as const) {
    const health = nextHealth(nextHealth(null, run(now - age * day)), run(now));
    const alerts = evaluateAlerts({ ...args, health });
    assert.equal(alerts[0]?.severity ?? null, severity);
    if (severity) {
      assert.deepEqual(ids(alerts), ['session_expiring:Principal']);
      assert.match(alerts[0]!.detail, /login de \d\d\/\d\d, vence por volta de \d\d\/\d\d \(estimado\)/i);
    }
  }
  const health = nextHealth(null, run(now), { Principal: new Date(now - 12 * day).toISOString() });
  assert.doesNotMatch(evaluateAlerts({ ...args, health })[0]!.detail, /estimado/);
});

test('live priorities drive counts and notify failures expose safe status', () => {
  const queue = buildProductionQueue([-1, 0, 2, 7].map((hours, i) => ({
    ...normalize({ orderNumber: String(i), orderItemList: [] }), queues: ['TO_SHIP'],
    deadlineEpoch: now + hours * 3600000,
  })), now - day);
  assert.ok(queue.orders.every(o => o.priority !== 'OVERDUE' && o.priority !== 'CRITICAL'));
  const sent = recordNotify(null, 'whatsapp', { at: now - 60000, result: 'sent' });
  const notify = recordNotify(sent, 'whatsapp', { at: now, result: 'failed', errorCode: 'WHATSAPP_HTTP_ERROR', httpStatus: 500 });
  const alerts = evaluateAlerts({ ...args, health: nextHealth(null, run(now)), queue, notify });
  assert.deepEqual(ids(alerts), ['notify_failing:whatsapp', 'orders_overdue', 'orders_critical']);
  assert.match(alerts[0]!.detail, /WHATSAPP_HTTP_ERROR \(HTTP 500\).*23\/11 08:50/);
  assert.equal(alerts[1]!.title, '2 pedidos atrasados');
  assert.equal(alerts[2]!.title, '1 pedido com prazo crítico');
});
