import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { nextHealth, parseSessionSeeds, persistHealthRun, readHealth } from '../apps/collector/src/health.js';
import { persistNotifyAttempt, readNotifyHealth, recordNotify } from '../apps/collector/src/notify-health.js';

const at = Date.parse('2026-11-23T18:30Z'), iso = (n: number) => new Date(n).toISOString();
const success = { name: 'Principal', ok: true, error: null, orders: 2 };
const fail = { ...success, ok: false, error: 'INVALID_JSON', orders: 0 };
const auth = { ...fail, error: 'AUTH_REQUIRED' };

test('success, seeded session, and transient failure streak', () => {
  const seed = '2026-11-23T18:18:00.000Z';
  const seeds = parseSessionSeeds(`Principal=${seed};bad;Segunda=garbage;Terceira=2026-11-20T01:00Z`);
  assert.deepEqual(seeds, { Principal: seed, Terceira: '2026-11-20T01:00:00.000Z' });
  const first = nextHealth(null, { at, statuses: [success], runError: null }, seeds);
  assert.deepEqual(first.accounts[0], { name: 'Principal', ok: true, error: null, lastAttemptAt: iso(at), lastSuccessAt: iso(at), consecutiveFailures: 0, sessionStartedAt: seed, sessionSource: 'seed' });
  const failed = nextHealth(first, { at: at + 1, statuses: [fail], runError: null });
  const again = nextHealth(failed, { at: at + 2, statuses: [fail], runError: null });
  assert.equal(again.lastRunOk, false);
  assert.equal(again.accounts[0]!.consecutiveFailures, 2);
  assert.equal(again.accounts[0]!.lastSuccessAt, iso(at));
  assert.equal(again.accounts[0]!.sessionStartedAt, seed);
  const recovered = nextHealth(again, { at: at + 3, statuses: [success], runError: null });
  assert.equal(recovered.accounts[0]!.consecutiveFailures, 0);
  assert.equal(recovered.accounts[0]!.lastSuccessAt, iso(at + 3));
  assert.equal(recovered.accounts[0]!.sessionStartedAt, seed);
});

test('auth failure clears session and next login observes a fresh start', () => {
  const before = nextHealth(null, { at, statuses: [success], runError: null });
  const failed = nextHealth(before, { at: at + 1, statuses: [auth], runError: null });
  assert.equal(failed.accounts[0]!.sessionStartedAt, null);
  assert.equal(failed.accounts[0]!.sessionSource, null);
  const recovered = nextHealth(failed, { at: at + 2, statuses: [success], runError: null }, { Principal: iso(at + 3) });
  assert.equal(recovered.accounts[0]!.sessionStartedAt, iso(at + 2));
  assert.equal(recovered.accounts[0]!.sessionSource, 'observed');
  assert.deepEqual(nextHealth(recovered, { at: at + 3, statuses: [], runError: 'INVALID_CONFIGURATION' }), {
    ...recovered, lastRunAt: iso(at + 3), lastRunOk: false, lastRunError: 'INVALID_CONFIGURATION',
  });
});

test('CLI helper writes all-accounts failure and tolerates corrupt or unwritable storage', async t => {
  const dir = await mkdtemp('.health-test-'); t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await readHealth(dir), null);
  const path = join(dir, 'health.json');
  await writeFile(path, '{"version":1,"accounts":[null]}');
  assert.equal(await readHealth(dir), null);
  const run = { at, statuses: [auth, { ...fail, name: 'Segunda' }], runError: 'AUTH_REQUIRED' };
  await persistHealthRun(dir, run, {}, assert.fail);
  assert.deepEqual(await readHealth(dir), nextHealth(null, run));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const errors: string[] = [];
  await persistHealthRun(path, run, {}, code => errors.push(code));
  assert.equal(errors.length, 1);
});

test('notification health tracks failure streak, last sent, and channel isolation', async t => {
  const sent = recordNotify(null, 'whatsapp', { at, result: 'sent', httpStatus: 201 });
  const failure = { at: at + 1, result: 'failed', errorCode: 'WHATSAPP_HTTP_ERROR', httpStatus: 500 } as const;
  const failed = recordNotify(recordNotify(sent, 'whatsapp', failure), 'whatsapp', failure);
  assert.deepEqual(failed.channels.whatsapp, { lastAttemptAt: iso(at + 1), lastSentAt: iso(at), lastResult: 'failed', lastErrorCode: 'WHATSAPP_HTTP_ERROR', httpStatus: 500, consecutiveFailures: 2 });
  assert.deepEqual(failed.channels.email, sent.channels.email);
  const dry = recordNotify(failed, 'whatsapp', { at: at + 2, result: 'dry_run' });
  assert.equal(dry.channels.whatsapp.lastSentAt, iso(at));
  assert.equal(dry.channels.whatsapp.consecutiveFailures, 0);
  const dir = await mkdtemp('.notify-health-test-'); t.after(() => rm(dir, { recursive: true, force: true }));
  await Promise.all([persistNotifyAttempt(dir, 'whatsapp', failure), persistNotifyAttempt(dir, 'email', { at, result: 'sent' })]);
  const saved = await readNotifyHealth(dir);
  assert.equal(saved?.channels.whatsapp.httpStatus, 500);
  assert.equal(saved?.channels.email.lastSentAt, iso(at));
});

test('collector CLI records a configuration failure without opening a browser', async t => {
  const dir = await mkdtemp('.collector-health-test-'); t.after(() => rm(dir, { recursive: true, force: true }));
  await persistHealthRun(dir, { at, statuses: [success], runError: null }, {}, assert.fail);
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'apps/collector/src/cli.ts'], {
    env: { ...process.env, OUTPUT_DIR: dir, MAX_PAGES: '0' }, encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /collection_failed.*INVALID_CONFIGURATION/);
  const health = await readHealth(dir);
  assert.equal(health?.lastRunError, 'INVALID_CONFIGURATION');
  assert.equal(health?.lastRunOk, false);
  assert.equal(health?.accounts[0]?.lastSuccessAt, iso(at));
});

test('notify CLI records dry runs and keeps the protected link out of logs', async t => {
  const dir = await mkdtemp('.notify-cli-health-test-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const generatedAt = iso(at);
  await writeFile(join(dir, 'production-queue.json'), JSON.stringify({ generatedAt, orders: [] }));
  await writeFile(join(dir, 'production-summary.json'), JSON.stringify({
    generatedAt, totals: { orders: 0, units: 0 },
    priorityCounts: { OVERDUE: 0, CRITICAL: 0, URGENT: 0, ATTENTION: 0, NORMAL: 0, UNKNOWN: 0 }, products: [],
  }));
  const token = 'sensitive-fixture-token-0000';
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'apps/collector/src/notify-cli.ts', 'daily'], {
    env: { ...process.env, DATA_DIR: dir, NOTIFICATION_DRY_RUN: 'true', NOTIFICATION_BOOTSTRAP_MODE: 'silent', PANEL_TOKEN: token,
      PANEL_PUBLIC_URL: 'https://panel.example.invalid' }, encoding: 'utf8',
  });
  assert.ok(!output.includes(token));
  assert.match(output, /notification_dry_run/);
  assert.equal((await readNotifyHealth(dir))?.channels.whatsapp.lastResult, 'dry_run');
});
