import { WhatsAppNotificationSender } from './whatsapp-sender.js';
import { resolve } from 'node:path';
import { runNotifications } from './notification-runner.js';
import { errorCode } from './health-files.js';
import { persistNotifyAttempt } from './notify-health.js';
import type { Log } from './notification-runner.js';
import { parseKeywords } from './orders-view.js';
// The link sent on WhatsApp: PANEL_PUBLIC_URL (e.g. https://pedidos.example.com) + /p/<PANEL_TOKEN>.
function panelLink() {
  const base = process.env.PANEL_PUBLIC_URL?.trim(), token = process.env.PANEL_TOKEN?.trim();
  return base && token ? `${base.replace(/\/+$/, '')}/p/${encodeURIComponent(token)}` : undefined;
}
const dir = resolve(process.env.DATA_DIR ?? 'data');
let httpStatus: number | undefined;
// Only a real delivery (or dry-run message) counts: a 'check' run with no transitions must not mark the channel healthy.
let delivered = false, started = false;
const panelUrl = panelLink();
const log: Log = event => {
  if (event.event === 'notification_dry_run') delivered = true;
  if (panelUrl && event.event === 'notification_dry_run' && typeof event.message === 'string') {
    event = { ...event, message: event.message.replaceAll(panelUrl, '[link protegido]') };
  }
  console.log(JSON.stringify(event));
};
const senderLog: Log = event => {
  if (event.event === 'notification_sent') delivered = true;
  if (event.event === 'notification_failed' || event.event === 'notification_sent') {
    httpStatus = typeof event.httpStatus === 'number' ? event.httpStatus : undefined;
  }
  log(event);
};
try {
  const mode = process.argv[2];
  if (mode !== 'daily' && mode !== 'check') throw new Error('INVALID_MODE');
  if ((process.env.NOTIFICATION_BOOTSTRAP_MODE ?? 'silent') !== 'silent') throw new Error('INVALID_BOOTSTRAP_MODE');
  const dry = process.env.NOTIFICATION_DRY_RUN ?? 'true';
  if (dry !== 'true' && dry !== 'false') throw new Error('INVALID_DRY_RUN');
  if (dry === 'false' && process.env.WHATSAPP_ENABLED !== 'true') throw new Error('WHATSAPP_DISABLED');
  started = true;
  await runNotifications(mode, dir, { now: Date.now(), timezone: process.env.BUSINESS_TIMEZONE, topProducts: Number(process.env.WHATSAPP_TOP_PRODUCTS ?? 5), listLimit: Number(process.env.WHATSAPP_LIST_LIMIT ?? 8), panelUrl, personalizationKeywords: parseKeywords(process.env.PERSONALIZATION_KEYWORDS), dryRun: dry === 'true' }, log, new WhatsAppNotificationSender(process.env, senderLog));
  if (delivered) await persistNotifyAttempt(dir, 'whatsapp', { at: Date.now(), result: dry === 'true' ? 'dry_run' : 'sent', httpStatus });
} catch (error) {
  console.error(JSON.stringify({ event: 'notification_failed' }));
  process.exitCode = 1;
  if (started && (error as NodeJS.ErrnoException).code !== 'EEXIST') await persistNotifyAttempt(dir, 'whatsapp', { at: Date.now(), result: 'failed', errorCode: errorCode(error, 'NOTIFICATION_FAILED'), httpStatus });
}
