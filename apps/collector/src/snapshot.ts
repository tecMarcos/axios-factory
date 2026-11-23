import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { validateSnapshot } from './notifications.js';

// Resolve the current generation once to keep queue and summary consistent.
export async function readSnapshot(dir: string) {
  let snapshot: string;
  try { snapshot = await realpath(join(dir, '.current')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; snapshot = dir; }
  const [queue, summary] = await Promise.all(['production-queue.json', 'production-summary.json'].map(async f => JSON.parse(await readFile(join(snapshot, f), 'utf8'))));
  return validateSnapshot(queue, summary);
}
