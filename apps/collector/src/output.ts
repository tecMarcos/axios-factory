import { mkdir, writeFile, symlink, rename, unlink, readlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { collect } from './core.js';
export async function save(result: Awaited<ReturnType<typeof collect>>, dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const generation = `.snapshot-${randomUUID()}`;
  const snapshot = join(dir, generation);
  await mkdir(snapshot, { mode: 0o700 });
  let published = false;
  const pending = join(dir, `.current-${randomUUID()}`);
  try {
    for (const name of ['orders', 'summary'] as const) {
      await writeFile(join(snapshot, `${name}.json`), JSON.stringify(result[name], null, 2) + '\n', { mode: 0o600 });
      const target = `.current/${name}.json`;
      try { await symlink(target, join(dir, `${name}.json`)); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || await readlink(join(dir, `${name}.json`)) !== target) throw e;
      }
    }
    await symlink(generation, pending);
    await rename(pending, join(dir, '.current'));
    published = true;
  } finally {
    await unlink(pending).catch(() => {});
    if (!published) await rm(snapshot, { recursive: true, force: true });
  }
}
