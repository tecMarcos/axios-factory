import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AccountStatus } from '../../collector/src/accounts.js';

export type History = { generatedAt: string; accounts?: AccountStatus[] };
type AccountHealth = {
  name: string; lastOkAt: string | null; lastAttemptAt: string;
  failureStreak: number; lastError: string | null; down: boolean; stale: boolean; absent: boolean;
};

const validIso = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function computeSyncHealth(history: History[], now: number, { staleMinutes = 90 } = {}) {
  const snapshots = new Map<string, History>();
  for (const entry of history) {
    if (validIso(entry.generatedAt) && Date.parse(entry.generatedAt) <= now + 5 * 60000 && (!snapshots.has(entry.generatedAt) || entry.accounts)) snapshots.set(entry.generatedAt, entry);
  }
  const accounts = new Map<string, AccountHealth>();
  const age = (date: string) => (now - Date.parse(date)) / 60000;
  const dates = [...snapshots.keys()].sort((a, b) => Date.parse(a) - Date.parse(b));
  const latestAccounts = snapshots.get(dates.slice().reverse().find(date => snapshots.get(date)?.accounts !== undefined) ?? '')?.accounts;
  const present = new Set(latestAccounts?.map(account => account.name));
  for (const date of dates) {
    for (const status of snapshots.get(date)?.accounts ?? []) {
      const previous = accounts.get(status.name);
      if (previous?.lastAttemptAt === date) continue;
      const lastOkAt = status.ok ? date : previous?.lastOkAt ?? null;
      accounts.set(status.name, {
        name: status.name, absent: !present.has(status.name), lastOkAt, lastAttemptAt: date,
        failureStreak: status.ok ? 0 : (previous?.failureStreak ?? 0) + 1,
        lastError: status.ok ? null : status.error,
        down: !status.ok, stale: lastOkAt === null || age(lastOkAt) > staleMinutes,
      });
    }
  }
  const latestGeneratedAt = dates.at(-1) ?? null;
  const snapshotAgeMinutes = latestGeneratedAt === null ? null : Math.max(0, age(latestGeneratedAt));
  return {
    accounts: Object.fromEntries(accounts), latestGeneratedAt, snapshotAgeMinutes,
    snapshotStale: snapshotAgeMinutes === null || snapshotAgeMinutes > staleMinutes,
  };
}

function isAccount(value: unknown): value is AccountStatus {
  if (!value || typeof value !== 'object') return false;
  const a = value as Partial<AccountStatus>;
  return typeof a.name === 'string' && !!a.name.trim() && typeof a.ok === 'boolean'
    && (a.error === null || typeof a.error === 'string') && typeof a.orders === 'number'
    && Number.isSafeInteger(a.orders) && a.orders >= 0;
}

async function readHistory(dataDir: string, limit: number): Promise<History[]> {
  const entries = await readdir(dataDir, { withFileTypes: true });
  const dirs = await Promise.all(entries.filter(entry => entry.isDirectory() && entry.name.startsWith('.snapshot-')).map(async entry => {
    const path = join(dataDir, entry.name);
    try { return { path, mtime: (await stat(path)).mtimeMs }; }
    catch { return null; }
  }));
  const newest = dirs.filter(dir => dir !== null).sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, limit);
  const snapshots = await Promise.all(newest.map(async ({ path }): Promise<History | null> => {
    try {
      const q = JSON.parse(await readFile(join(path, 'production-queue.json'), 'utf8'));
      if (!q || !validIso(q.generatedAt)) return null;
      if (q.accounts === undefined) return { generatedAt: q.generatedAt };
      if (!Array.isArray(q.accounts) || !q.accounts.every(isAccount)) return null;
      const accounts = (q.accounts as AccountStatus[]).map(({ name, ok, error, orders }) => ({ name, ok, error, orders }));
      return { generatedAt: q.generatedAt, accounts };
    } catch { return null; }
  }));
  return snapshots.filter(snapshot => snapshot !== null);
}

const cache = new Map<string, { generation: string; limit: number; history: Promise<History[]> }>();

export async function loadSyncHistory(dataDir: string, { limit = 300 } = {}): Promise<History[]> {
  const dir = resolve(dataDir);
  const generation = await realpath(join(dir, '.current')).catch(() => null);
  if (!generation) {
    cache.delete(dir);
    return readHistory(dir, limit);
  }
  const cached = cache.get(dir);
  if (cached?.generation === generation && cached.limit === limit) return cached.history;
  const history = readHistory(dir, limit);
  const entry = { generation, limit, history };
  cache.set(dir, entry);
  try { return await history; }
  catch (error) {
    if (cache.get(dir) === entry) cache.delete(dir);
    throw error;
  }
}
