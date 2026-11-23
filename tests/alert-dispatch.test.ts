import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { test, type TestContext } from 'node:test';
import { dispatchAlerts, planDispatch, readAlertState } from '../apps/collector/src/alert-dispatch.js';
import { MemoryAlertNotifier } from '../apps/collector/src/alert-notifier.js';
import type { Alert } from '../apps/collector/src/health-alerts.js';
import { readNotifyHealth } from '../apps/collector/src/notify-health.js';

const now = Date.parse('2026-11-23T12:00Z'), day = 86400000;
const warning: Alert = { id: 'session_expiring:Principal', severity: 'warning', title: 'Sessão da conta Principal', detail: 'Vence em breve' };
async function setup(t: TestContext) {
  const dir = await mkdtemp('.alert-dispatch-test-'); t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, notifier: new MemoryAlertNotifier(), now, alerts: [warning] };
}

test('ten runs send once, then severity change and resolution send once each', async t => {
  const options = await setup(t);
  const first = planDispatch(null, options.alerts, now);
  assert.deepEqual(first.newAlerts, [warning]);
  assert.equal(first.nextState.alerts[warning.id]?.lastSentSeverity, 'warning');
  const panelUrl = 'https://example.invalid/p/test-token';
  for (let i = 0; i < 10; i++) await dispatchAlerts({ ...options, now: now + i, panelUrl });
  assert.equal(options.notifier.messages.length, 1);
  assert.match(options.notifier.messages[0]!.text, /Painel: https:\/\/example.invalid\/p\/test-token/);
  const critical = { ...options, now: now + 10, alerts: [{ ...warning, severity: 'critical' as const }] };
  await dispatchAlerts(critical);
  await dispatchAlerts(critical);
  assert.equal(options.notifier.messages.length, 2);
  assert.match(options.notifier.messages[1]!.subject, /mudança de gravidade/);
  await dispatchAlerts({ ...options, alerts: [], now: now + 11 });
  await dispatchAlerts({ ...options, alerts: [], now: now + 12 });
  assert.equal(options.notifier.messages.length, 3);
  assert.match(options.notifier.messages[2]!.subject, /1 resolvido/);
  assert.deepEqual((await readAlertState(options.dir))?.alerts, {});
});

test('reminder sends once after 24 hours', async t => {
  const options = await setup(t);
  await dispatchAlerts(options);
  await dispatchAlerts({ ...options, now: now + day - 1 });
  assert.equal(options.notifier.messages.length, 1);
  await dispatchAlerts({ ...options, now: now + day });
  await dispatchAlerts({ ...options, now: now + day + 1 });
  assert.equal(options.notifier.messages.length, 2);
  assert.match(options.notifier.messages[1]!.subject, /lembrete/);
});

test('failed send retries, disabled notifier leaves state unadvanced', async t => {
  const options = await setup(t), logs: unknown[] = [];
  await dispatchAlerts({ ...options, notifier: null, log: event => logs.push(event) });
  assert.deepEqual(logs, [{ event: 'alert_email_disabled', pending: 1 }]);
  assert.equal(await readAlertState(options.dir), null);
  assert.equal(await readNotifyHealth(options.dir), null);
  const failed = { channel: 'email', send: async () => { throw new Error('SMTP_TIMEOUT'); } };
  await assert.rejects(dispatchAlerts({ ...options, notifier: failed }), /SMTP_TIMEOUT/);
  assert.equal(await readAlertState(options.dir), null);
  assert.equal((await readNotifyHealth(options.dir))?.channels.email.lastErrorCode, 'SMTP_TIMEOUT');
  await dispatchAlerts(options);
  await dispatchAlerts(options);
  assert.equal(options.notifier.messages.length, 1);
  assert.equal((await readNotifyHealth(options.dir))?.channels.email.lastResult, 'sent');
});
