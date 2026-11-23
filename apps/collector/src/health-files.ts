import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

export async function readJson(dir: string, name: string): Promise<unknown> {
  try { return JSON.parse(await readFile(join(dir, name), 'utf8')); } catch { return null; }
}
export async function writeJson(dir: string, name: string, value: unknown) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
  const file = await open(temp, 'wx', 0o600);
  try {
    try { await file.writeFile(JSON.stringify(value) + '\n'); } finally { await file.close(); }
    await rename(temp, join(dir, name));
  } finally { await unlink(temp).catch(() => {}); }
}
export async function withLock<T>(dir: string, name: string, action: () => Promise<T>, log: (event: Record<string, unknown>) => void = event => console.log(JSON.stringify(event))) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  const acquire = () => open(path, 'wx', 0o600);
  const lock = await acquire().catch(async error => {
    if (error.code !== 'EEXIST') throw error;
    const existing = await stat(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (existing) {
      if (Date.now() - existing.mtimeMs <= 10 * 60000) throw error;
      await unlink(path).then(() => log({ event: 'stale_lock_removed', lock: basename(name) }), error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return acquire();
  });
  try { return await action(); }
  finally {
    try {
      const own = await lock.stat();
      const current = await stat(path).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (current?.ino === own.ino && current.dev === own.dev) await unlink(path);
    } finally { await lock.close(); }
  }
}
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const isDate = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
export const nullableDate = (v: unknown) => v === null || isDate(v);
export const isCode = (v: unknown): v is string => typeof v === 'string' && /^[A-Z_]{2,64}$/.test(v) && !v.endsWith('\n');
export const nullableCode = (v: unknown) => v === null || isCode(v);
export const isCount = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export const errorCode = (error: unknown, fallback: string) => error instanceof Error && isCode(error.message) ? error.message : fallback;
export const fileErrorCode = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return isCode(code) ? code : 'HEALTH_WRITE_FAILED';
};
