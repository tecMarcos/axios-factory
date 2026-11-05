import { WhatsAppNotificationSender } from './whatsapp-sender.js';
import { resolve } from 'node:path';
import { runNotifications } from './notification-runner.js';
import { parseKeywords } from './orders-view.js';
// The link sent on WhatsApp: PANEL_PUBLIC_URL (e.g. https://pedidos.example.com) + /p/<PANEL_TOKEN>.
function panelLink() {
  const base = process.env.PANEL_PUBLIC_URL?.trim(), token = process.env.PANEL_TOKEN?.trim();
  return base && token ? `${base.replace(/\/+$/, '')}/p/${encodeURIComponent(token)}` : undefined;
}
try {
  const mode = process.argv[2];
  if (mode !== 'daily' && mode !== 'check') throw new Error('INVALID_MODE');
  if ((process.env.NOTIFICATION_BOOTSTRAP_MODE ?? 'silent') !== 'silent') throw new Error('INVALID_BOOTSTRAP_MODE');
  const dry = process.env.NOTIFICATION_DRY_RUN ?? 'true';
  if (dry !== 'true' && dry !== 'false') throw new Error('INVALID_DRY_RUN');
  if (dry === 'false' && process.env.WHATSAPP_ENABLED !== 'true') throw new Error('WHATSAPP_DISABLED');
  await runNotifications(mode, resolve(process.env.DATA_DIR ?? 'data'), { now: Date.now(), timezone: process.env.BUSINESS_TIMEZONE, topProducts: Number(process.env.WHATSAPP_TOP_PRODUCTS ?? 5), listLimit: Number(process.env.WHATSAPP_LIST_LIMIT ?? 8), panelUrl: panelLink(), personalizationKeywords: parseKeywords(process.env.PERSONALIZATION_KEYWORDS), dryRun: dry === 'true' }, event => console.log(JSON.stringify(event)), new WhatsAppNotificationSender());
} catch {
  console.error(JSON.stringify({ event: 'notification_failed' }));
  process.exitCode = 1;
}
