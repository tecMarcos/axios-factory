import { resolve } from 'node:path';
import { runNotifications } from './notification-runner.js';
try {
  const mode = process.argv[2];
  if (mode !== 'daily' && mode !== 'check') throw new Error('INVALID_MODE');
  if ((process.env.NOTIFICATION_BOOTSTRAP_MODE ?? 'silent') !== 'silent') throw new Error('INVALID_BOOTSTRAP_MODE');
  const dry = process.env.NOTIFICATION_DRY_RUN ?? 'true';
  if (dry !== 'true' && dry !== 'false') throw new Error('INVALID_DRY_RUN');
  await runNotifications(mode, resolve(process.env.DATA_DIR ?? 'data'), { now: Date.now(), timezone: process.env.BUSINESS_TIMEZONE, topProducts: Number(process.env.WHATSAPP_TOP_PRODUCTS ?? 5), dryRun: dry === 'true' }, event => console.log(JSON.stringify(event)));
} catch {
  console.error(JSON.stringify({ event: 'notification_failed' }));
  process.exitCode = 1;
}
