import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { computeSyncHealth, loadSyncHistory } from '../apps/production/src/sync-health.js';

const now = Date.parse('2026-11-23T12:00:00Z');
const ago = (minutes: number) => new Date(now - minutes * 60000).toISOString();
const snapshot = (minutes: number, ok: boolean) => ({
  generatedAt: ago(minutes),
  accounts: [{ name: 'Conta A', ok, error: ok ? null : 'AUTH_REQUIRED', orders: 0 }],
});

test('sync health sorts and dedupes snapshots and ignores unknown account history', () => {
  const health = computeSyncHealth([
    snapshot(100, false), snapshot(120, true), snapshot(110, false),
    { generatedAt: ago(105) }, snapshot(110, false), snapshot(101, false), { generatedAt: 'invalid' },
  ], now);
  assert.deepEqual(health.accounts['Conta A'], {
    name: 'Conta A', lastOkAt: ago(120), lastAttemptAt: ago(100), failureStreak: 3,
    lastError: 'AUTH_REQUIRED', down: true, stale: true, absent: false,
  });
  assert.equal(health.latestGeneratedAt, ago(100));
  assert.equal(health.snapshotAgeMinutes, 100);
  assert.equal(health.snapshotStale, true);
  const recovered = computeSyncHealth([snapshot(120, false), snapshot(90, true)], now);
  assert.equal(recovered.accounts['Conta A']!.failureStreak, 0);
  assert.equal(recovered.accounts['Conta A']!.stale, false);
  assert.equal(recovered.snapshotStale, false);
  assert.equal(computeSyncHealth([snapshot(10, false)], now).accounts['Conta A']!.lastOkAt, null);
});

test('history skips corrupt snapshots and refreshes after .current changes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'production-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  async function write(name: string, value: string) {
    await mkdir(join(dir, name));
    await writeFile(join(dir, name, 'production-queue.json'), value);
  }
  const first = snapshot(120, true), second = snapshot(100, false);
  await write('.snapshot-good', JSON.stringify({ ...first, orders: ['ignored'] }));
  await write('.snapshot-bad', '{x}');
  await write('.snapshot-invalid', JSON.stringify({ ...second, accounts: [{ name: 'Conta A' }] }));
  const link = join(dir, '.current');
  await symlink('.snapshot-good', link);
  assert.deepEqual(await loadSyncHistory(dir), [first]);
  await write('.snapshot-next', JSON.stringify(second));
  assert.deepEqual(await loadSyncHistory(dir), [first]);
  await unlink(link);
  await symlink('.snapshot-next', link);
  assert.deepEqual((await loadSyncHistory(dir)).map(s => s.generatedAt).sort(), [first.generatedAt, second.generatedAt]);
});
