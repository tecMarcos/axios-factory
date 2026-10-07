import { chromium } from 'playwright';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CollectorError } from './core.js';

export async function privateProfile(path: string, project = fileURLToPath(new URL('../../../', import.meta.url))) {
  if (!isAbsolute(path)) throw new CollectorError('PROFILE_MUST_BE_EXTERNAL');
  const inside = (root: string, candidate: string) => {
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel));
  };
  if (inside(await realpath(project), resolve(path))) throw new CollectorError('PROFILE_MUST_BE_EXTERNAL');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const canonical = await realpath(path);
  if (inside(await realpath(project), canonical)) throw new CollectorError('PROFILE_MUST_BE_EXTERNAL');
  const info = await stat(canonical);
  if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new CollectorError('PROFILE_PERMISSIONS_REQUIRED');
  return canonical;
}

export async function openSession(headless = true) {
  process.umask(0o077);
  const profile = await privateProfile(process.env.UPSELLER_PROFILE_DIR ?? '/opt/axios-factory-runtime/upseller-profile');
  return chromium.launchPersistentContext(profile, { headless, acceptDownloads: false });
}
