import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { dispatchAlerts, planDispatch, readAlertState } from '../apps/collector/src/alert-dispatch.js';
import { MemoryAlertNotifier } from '../apps/collector/src/alert-notifier.js';
import { defaultHealthConfig, healthConfigFromEnv, type Alert } from '../apps/collector/src/health-alerts.js';
import { withLock, writeJson } from '../apps/collector/src/health-files.js';
import { nextHealth, writeHealth } from '../apps/collector/src/health.js';
import { readNotifyHealth } from '../apps/collector/src/notify-health.js';

const at = Date.parse('2026-11-23T21:00Z'), hour = 3600000;
const iso = (time: number) => new Date(time).toISOString();
const alert = (id: string, severity: Alert['severity'] = 'critical'): Alert => ({ id, severity, title: id, detail: 'fixture' });
const ok = { name: 'A', ok: true, error: null, orders: 0 };
const run = (time: number, statuses = [ok] as Parameters<typeof nextHealth>[1]['statuses']) => ({ at: time, statuses, runError: null });
async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-fixes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, now: at, notifier: new MemoryAlertNotifier() };
}

test('dispatch preserves kept entries, resets absence on reappearance, and resolves after two absences', async t => {
  const options = await setup(t), active = alert('orders_overdue');
  await dispatchAlerts({ ...options, alerts: [active] });
  const original = await readAlertState(options.dir);
  for (let i = 0; i < 2; i++) await dispatchAlerts({ ...options, alerts: [], keep: id => id === active.id });
  assert.deepEqual(await readAlertState(options.dir), original);
  await dispatchAlerts({ ...options, alerts: [] });
  assert.equal((await readAlertState(options.dir))?.alerts[active.id]?.absentRuns, 1);
  assert.equal(options.notifier.messages.length, 1);
  await dispatchAlerts({ ...options, alerts: [active] });
  assert.deepEqual(await readAlertState(options.dir), original);
  await dispatchAlerts({ ...options, alerts: [] });
  assert.equal(options.notifier.messages.length, 1);
  await dispatchAlerts({ ...options, alerts: [] });
  assert.match(options.notifier.messages[1]!.subject, /1 resolvido/);
});

test('dispatch sends once over 23 hours, then sends one reminder at 24 hours', async t => {
  const options = await setup(t), alerts = [alert('collector_stale')];
  for (let h = 0; h <= 23; h++) await dispatchAlerts({ ...options, alerts, now: at + h * hour });
  assert.equal(options.notifier.messages.length, 1);
  await dispatchAlerts({ ...options, alerts, now: at + 24 * hour });
  await dispatchAlerts({ ...options, alerts, now: at + 24 * hour + 1 });
  assert.equal(options.notifier.messages.length, 2);
  assert.match(options.notifier.messages[1]!.subject, /1 lembrete/);
});

function healthCli(dir: string, time: string, enabled = true) {
  const clock = 'data:text/javascript,' + encodeURIComponent(`Date.now = () => Date.parse(${JSON.stringify(time)});`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', clock, 'apps/collector/src/health-cli.ts'], {
    encoding: 'utf8',
    env: {
      ...process.env, DATA_DIR: dir, BUSINESS_TIMEZONE: 'America/Sao_Paulo', HEALTH_WINDOW: '07:20-19:50',
      HEALTH_STALE_MINUTES: '90', SESSION_WARN_DAYS: '12', SESSION_DAYS: '14', ALERT_EMAIL_ENABLED: String(enabled),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_SECURE: 'none', SMTP_TIMEOUT_MS: '500', SMTP_USER: 'fixture',
      SMTP_PASS: 'fixture-password', ALERT_EMAIL_FROM: 'sender@example.invalid', ALERT_EMAIL_TO: 'ops@example.invalid',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('health CLI keeps unreadable snapshot and health alerts, and signals missing health only on ENOENT', async t => {
  const { dir } = await setup(t);
  const alerts = ['orders_overdue', 'account_down:A', 'sync_stale:A', 'session_expiring:A', 'collector_stale'].map(id => alert(id));
  const state = planDispatch(null, alerts, at).nextState;
  await writeJson(dir, 'alert-state.json', state);
  for (const corrupt of ['{', '{"version":1}']) {
    await writeFile(join(dir, 'health.json'), corrupt);
    healthCli(dir, iso(at + 1));
    healthCli(dir, iso(at + 2));
    assert.deepEqual((await readAlertState(dir))?.alerts, { ...state.alerts });
  }
  await rm(join(dir, 'health.json'));
  assert.match(healthCli(dir, iso(at + 3), false), /"pending":1/);
  assert.deepEqual((await readAlertState(dir))?.alerts, { ...state.alerts });
});

test('health CLI retains stale alerts after 19:50 BRT and across the next morning grace period', async t => {
  const { dir } = await setup(t);
  const alerts = [
    { ...alert('collector_stale'), title: 'Coletor sem executar' },
    { ...alert('sync_stale:A', 'warning'), title: 'Sincronização atrasada: A' },
  ];
  const state = planDispatch(null, alerts, at).nextState;
  await writeJson(dir, 'alert-state.json', state);
  await writeHealth(dir, nextHealth(null, run(at - 3 * hour)));
  for (const time of ['2026-11-23T22:51Z', '2026-11-24T10:30Z', '2026-11-24T11:30Z', '2026-11-24T12:00Z']) {
    healthCli(dir, time);
    assert.deepEqual((await readAlertState(dir))?.alerts, { ...state.alerts });
  }
  assert.match(healthCli(dir, '2026-11-24T21:00Z', false), /"pending":2/);
});

test('proactive re-login adopts only a newer seed at or before the run', () => {
  const previous = nextHealth(null, run(at));
  const renewed = nextHealth(previous, run(at + hour), { A: iso(at + 1) });
  assert.equal(renewed.accounts[0]?.sessionStartedAt, iso(at + 1));
  assert.equal(renewed.accounts[0]?.sessionSource, 'seed');
  for (const seed of [iso(at), iso(at + 3 * hour)]) {
    assert.equal(nextHealth(renewed, run(at + 2 * hour), { A: seed }).accounts[0]?.sessionStartedAt, iso(at + 1));
  }
});

test('success restarts session tracking after auth and then transient failure', () => {
  const before = nextHealth(null, run(at));
  const auth = nextHealth(before, run(at + 1, [{ ...ok, ok: false, error: 'AUTH_REQUIRED' }]));
  const transient = nextHealth(auth, run(at + 2, [{ ...ok, ok: false, error: 'INVALID_JSON' }]));
  const recovered = nextHealth(transient, run(at + 3));
  assert.equal(recovered.accounts[0]?.sessionStartedAt, iso(at + 3));
  assert.equal(recovered.accounts[0]?.sessionSource, 'observed');
});

test('account pruning is limited to runs with configured names and statuses', () => {
  const before = nextHealth(null, run(at, [ok, { ...ok, name: 'B' }]));
  assert.deepEqual(nextHealth(before, run(at + 1), {}, ['A']).accounts.map(a => a.name), ['A']);
  assert.deepEqual(nextHealth(before, run(at + 1, []), {}, ['A']).accounts, before.accounts);
  assert.deepEqual(nextHealth(before, run(at + 1)).accounts.map(a => a.name), ['A', 'B']);
});

test('health config falls back for nonpositive stale minutes and inverted session thresholds', () => {
  for (const value of ['0', '-1']) {
    assert.deepEqual(healthConfigFromEnv({ HEALTH_STALE_MINUTES: value, SESSION_WARN_DAYS: '10', SESSION_DAYS: '9' }), defaultHealthConfig);
  }
  assert.deepEqual(healthConfigFromEnv({ HEALTH_STALE_MINUTES: '30', SESSION_WARN_DAYS: '7', SESSION_DAYS: '7' }),
    { ...defaultHealthConfig, staleMinutes: 30, sessionWarnDays: 7, sessionDays: 7 });
});

test('a live lock is preserved and a stale lock is removed with a safe log', async t => {
  const { dir } = await setup(t), name = '.alert.lock', path = join(dir, name), logs: unknown[] = [];
  await writeFile(path, '');
  await assert.rejects(withLock(dir, name, async () => assert.fail()), { code: 'EEXIST' });
  const stale = new Date(Date.now() - 11 * 60000);
  await utimes(path, stale, stale);
  assert.equal(await withLock(dir, name, async () => 42, event => logs.push(event)), 42);
  assert.deepEqual(logs, [{ event: 'stale_lock_removed', lock: name }]);
  assert.equal(await withLock(dir, name, async () => true), true);
});

test('invalid alert state logs a reset and dispatch continues', async t => {
  const options = await setup(t), logs: unknown[] = [], alerts = [alert('orders_overdue')];
  const invalid = planDispatch(null, alerts, at).nextState;
  invalid.alerts.orders_overdue!.absentRuns = -1;
  await writeJson(options.dir, 'alert-state.json', invalid);
  assert.equal(await readAlertState(options.dir, event => logs.push(event)), null);
  await writeFile(join(options.dir, 'alert-state.json'), '{');
  await dispatchAlerts({ ...options, alerts, log: event => logs.push(event) });
  assert.equal(options.notifier.messages.length, 1);
  assert.deepEqual(logs, [{ event: 'alert_state_reset' }, { event: 'alert_state_reset' }]);
});

test('persistent alert-state write failure logs after delivery and records the successful send', async t => {
  const options = await setup(t), logs: unknown[] = [];
  const notifier = { channel: 'email', send: async () => { await mkdir(join(options.dir, 'alert-state.json')); } };
  await assert.rejects(dispatchAlerts({ ...options, notifier, alerts: [alert('orders_overdue')], log: event => logs.push(event) }));
  assert.deepEqual(logs, [{ event: 'alert_state_write_failed' }]);
  assert.equal((await readNotifyHealth(options.dir))?.channels.email.lastResult, 'sent');
});

test('email health alerts are dropped from email dispatch, including legacy state entries', async t => {
  const options = await setup(t), self = alert('notify_failing:email');
  const legacy = planDispatch(null, [alert('legacy')], at).nextState;
  legacy.alerts[self.id] = { ...legacy.alerts.legacy!, absentRuns: 1 };
  delete legacy.alerts.legacy;
  await writeJson(options.dir, 'alert-state.json', legacy);
  await dispatchAlerts({ ...options, alerts: [self], now: at + 24 * hour });
  await dispatchAlerts({ ...options, alerts: [], now: at + 25 * hour });
  assert.deepEqual((await readAlertState(options.dir))?.alerts, {});
  assert.equal(options.notifier.messages.length, 0);
});

test('notify CLI configuration failures leave WhatsApp delivery health untouched', async t => {
  const { dir } = await setup(t);
  for (const [mode, dry] of [['invalid', 'true'], ['daily', 'invalid'], ['daily', 'false']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/collector/src/notify-cli.ts', mode!], {
      env: { ...process.env, DATA_DIR: dir, NOTIFICATION_BOOTSTRAP_MODE: 'silent', NOTIFICATION_DRY_RUN: dry, WHATSAPP_ENABLED: 'false' },
    });
    assert.equal(result.status, 1);
    assert.equal(await readNotifyHealth(dir), null);
  }
});

test('health CLI keeps notify_failing alerts while notify-health.json is corrupt', async t => {
  const { dir } = await setup(t);
  await writeHealth(dir, nextHealth(null, run(at)));
  const state = planDispatch(null, [alert('notify_failing:whatsapp')], at).nextState;
  await writeJson(dir, 'alert-state.json', state);
  await writeFile(join(dir, 'notify-health.json'), '{');
  healthCli(dir, iso(at + 1));
  healthCli(dir, iso(at + 2));
  assert.deepEqual((await readAlertState(dir))?.alerts, { ...state.alerts });
});

test('an old session seed is not adopted after a re-login that follows an auth failure', () => {
  const seeds = { A: iso(at - 20 * 24 * hour) };
  const down = nextHealth(nextHealth(null, run(at - 30 * 24 * hour)), run(at - hour, [{ name: 'A', ok: false, error: 'AUTH_REQUIRED', orders: 0 }]));
  const back = nextHealth(down, run(at), seeds).accounts[0]!;
  assert.equal(back.sessionSource, 'observed');
  assert.equal(back.sessionStartedAt, iso(at));
  const fresh = nextHealth(down, run(at), { A: iso(at - 10 * 60000) }).accounts[0]!;
  assert.equal(fresh.sessionSource, 'seed');
});
