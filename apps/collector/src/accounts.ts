import { isAbsolute } from 'node:path';
import { CollectorError } from './core.js';

/** One UpSeller login = one private browser profile (like using Chrome for one account and Opera for another). */
export type Account = { name: string; profileDir: string };
export type AccountStatus = { name: string; ok: boolean; error: string | null; orders: number };

export const defaultProfileDir = '/opt/axios-factory-runtime/upseller-profile';
const namePattern = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,29}$/u;

/**
 * UPSELLER_ACCOUNTS="Principal=/opt/.../upseller-profile;Segunda=/opt/.../upseller-profile-2".
 * Without it there is a single account named "Principal" using UPSELLER_PROFILE_DIR (previous behaviour).
 */
export function parseAccounts(env: NodeJS.ProcessEnv = process.env): Account[] {
  const raw = env.UPSELLER_ACCOUNTS?.trim();
  if (!raw) return [{ name: 'Principal', profileDir: env.UPSELLER_PROFILE_DIR?.trim() || defaultProfileDir }];
  const accounts = raw.split(';').map(s => s.trim()).filter(Boolean).map(entry => {
    const i = entry.indexOf('=');
    const name = i < 0 ? '' : entry.slice(0, i).trim(), profileDir = i < 0 ? '' : entry.slice(i + 1).trim();
    if (!namePattern.test(name) || !isAbsolute(profileDir)) throw new CollectorError('INVALID_ACCOUNTS');
    return { name, profileDir };
  });
  const lower = (s: string) => s.toLocaleLowerCase('pt-BR');
  if (!accounts.length || accounts.length > 10
    || new Set(accounts.map(a => lower(a.name))).size !== accounts.length
    || new Set(accounts.map(a => a.profileDir)).size !== accounts.length) throw new CollectorError('INVALID_ACCOUNTS');
  return accounts;
}

export function findAccount(accounts: Account[], name: string | undefined): Account {
  if (!name) return accounts[0]!;
  const found = accounts.find(a => a.name.toLocaleLowerCase('pt-BR') === name.trim().toLocaleLowerCase('pt-BR'));
  if (!found) throw new CollectorError('UNKNOWN_ACCOUNT');
  return found;
}
