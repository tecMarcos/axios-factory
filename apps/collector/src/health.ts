import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountStatus } from './accounts.js';
import { fileErrorCode, isCount, isDate, isObject, nullableCode, nullableDate, writeJson } from './health-files.js';

export type AccountHealth = {
  name: string; ok: boolean; error: string | null; lastAttemptAt: string; lastSuccessAt: string | null;
  consecutiveFailures: number; sessionStartedAt: string | null; sessionSource: 'seed' | 'observed' | null;
};
export type Health = { version: 1; lastRunAt: string; lastRunOk: boolean; lastRunError: string | null; accounts: AccountHealth[] };
type Run = { at: number; statuses: AccountStatus[]; runError: string | null };
export const authError = (code: string | null) => code === 'AUTH_REQUIRED' || code === 'API_REJECTED_OR_SESSION_EXPIRED';

export function parseSessionSeeds(raw?: string): Record<string, string> {
  const seeds: [string, string][] = [];
  for (const entry of raw?.split(';') ?? []) {
    const [key, value, ...extra] = entry.split('=');
    const name = key?.trim(), date = value?.trim();
    if (extra.length || !name || !isDate(date) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(date)) continue;
    const day = date.slice(0, 10);
    const midnight = `${day}T00:00:00Z`;
    if (isDate(midnight) && new Date(midnight).toISOString().slice(0, 10) === day) seeds.push([name, new Date(date).toISOString()]);
  }
  return Object.fromEntries(seeds);
}

export function nextHealth(previous: Health | null, run: Run, seeds: Record<string, string> = {}, configuredNames?: readonly string[]): Health {
  const at = new Date(run.at).toISOString();
  const accounts = new Map(previous?.accounts.map(a => [a.name, a]));
  for (const status of run.statuses) {
    const { name, ok } = status, before = accounts.get(name);
    const error = ok ? null : status.error;
    let sessionStartedAt = before?.sessionStartedAt ?? null, sessionSource = before?.sessionSource ?? null;
    const seed = Object.hasOwn(seeds, name) ? seeds[name] : undefined;
    // A seed only counts if it is newer than what we know: the current session, or (after the session was lost)
    // the last failed attempt, so an old UPSELLER_SESSION_SINCE cannot pre-date a fresh re-login.
    const floor = sessionStartedAt ? Date.parse(sessionStartedAt)
      : before && !before.ok && authError(before.error) ? Date.parse(before.lastAttemptAt)
      : before?.lastSuccessAt && !before.sessionStartedAt ? Date.parse(before.lastSuccessAt) : -Infinity;
    if (ok && isDate(seed) && Date.parse(seed) <= run.at && Date.parse(seed) > floor) {
      sessionStartedAt = seed;
      sessionSource = 'seed';
    } else if (ok && (!before || !before.sessionStartedAt || (!before.ok && authError(before.error)))) {
      sessionStartedAt = at;
      sessionSource = 'observed';
    } else if (!ok && authError(error)) {
      sessionStartedAt = null;
      sessionSource = null;
    }
    accounts.set(name, {
      name, ok, error, lastAttemptAt: at, lastSuccessAt: ok ? at : before?.lastSuccessAt ?? null,
      consecutiveFailures: ok ? 0 : (before?.consecutiveFailures ?? 0) + 1, sessionStartedAt, sessionSource,
    });
  }
  if (configuredNames && run.statuses.length) {
    const configured = new Set(configuredNames);
    for (const name of accounts.keys()) if (!configured.has(name)) accounts.delete(name);
  }
  return { version: 1, lastRunAt: at, lastRunOk: run.runError === null && run.statuses.every(s => s.ok), lastRunError: run.runError, accounts: [...accounts.values()] };
}

function validAccount(a: unknown): a is AccountHealth {
  return isObject(a) && typeof a.name === 'string' && typeof a.ok === 'boolean' && nullableCode(a.error)
    && isDate(a.lastAttemptAt) && nullableDate(a.lastSuccessAt) && isCount(a.consecutiveFailures)
    && nullableDate(a.sessionStartedAt) && [null, 'seed', 'observed'].includes(a.sessionSource as string | null);
}
export async function readHealthInput(dir: string): Promise<{ health: Health | null; missing: boolean }> {
  let h: unknown;
  try { h = JSON.parse(await readFile(join(dir, 'health.json'), 'utf8')); }
  catch (error) { return { health: null, missing: (error as NodeJS.ErrnoException).code === 'ENOENT' }; }
  const health = isObject(h) && h.version === 1 && isDate(h.lastRunAt) && typeof h.lastRunOk === 'boolean' && nullableCode(h.lastRunError)
    && Array.isArray(h.accounts) && h.accounts.every(validAccount) ? h as Health : null;
  return { health, missing: false };
}
export async function readHealth(dir: string): Promise<Health | null> {
  return (await readHealthInput(dir)).health;
}
export const writeHealth = (dir: string, health: Health) => writeJson(dir, 'health.json', health);
export async function persistHealthRun(dir: string, run: Run, seeds: Record<string, string>, onFailure: (code: string) => void, configuredNames?: readonly string[]) {
  try { await writeHealth(dir, nextHealth(await readHealth(dir), run, seeds, configuredNames)); }
  catch (error) { onFailure(fileErrorCode(error)); }
}
