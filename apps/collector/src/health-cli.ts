import { join, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { dispatchAlerts } from './alert-dispatch.js';
import { emailNotifierFromEnv } from './alert-notifier.js';
import { evaluateAlerts, healthConfigFromEnv, windowStart } from './health-alerts.js';
import { errorCode } from './health-files.js';
import { readHealthInput } from './health.js';
import { persistNotifyAttempt, readNotifyHealth } from './notify-health.js';
import { defaultTimezone, validateTimezone } from './operational.js';
import { readSnapshot } from './snapshot.js';

const env = process.env, dir = resolve(env.DATA_DIR ?? 'data'), now = Date.now();
try {
  const timezone = validateTimezone(env.BUSINESS_TIMEZONE ?? defaultTimezone);
  const base = env.PANEL_PUBLIC_URL?.trim(), token = env.PANEL_TOKEN?.trim();
  const panelUrl = base && token ? `${base.replace(/\/+$/, '')}/p/${encodeURIComponent(token)}` : undefined;
  let notifier;
  try { notifier = emailNotifierFromEnv(env); }
  catch (error) {
    await persistNotifyAttempt(dir, 'email', { at: now, result: 'failed', errorCode: errorCode(error, 'SMTP_CONFIG_INVALID') });
    throw error;
  }
  const config = healthConfigFromEnv(env);
  const start = windowStart(now, timezone, config.window);
  let inputs: Awaited<ReturnType<typeof readHealthInput>>;
  let snapshotReadable = false, notifyUnreadable = false;
  await dispatchAlerts({
    dir, now, notifier, panelUrl,
    alerts: async () => {
      const [healthInput, notify, snapshot] = await Promise.all([readHealthInput(dir), readNotifyHealth(dir), readSnapshot(dir).catch(() => null)]);
      inputs = healthInput;
      // A corrupt notify-health.json must not resolve notify_failing:* (a missing one means nothing failed yet).
      notifyUnreadable = notify === null && await access(join(dir, 'notify-health.json')).then(() => true, () => false);
      snapshotReadable = snapshot !== null;
      return evaluateAlerts({ health: inputs.health, notify, queue: snapshot?.queue ?? null, now, timezone, config })
        .filter(alert => alert.id !== 'monitor_missing' || inputs.missing);
    },
    keep: id => {
      if (!snapshotReadable && id.startsWith('orders_')) return true;
      if (notifyUnreadable && id.startsWith('notify_failing:')) return true;
      if (!inputs.health && /^(account|sync|session|collector)_/.test(id)) return true;
      if (id === 'monitor_missing') return !inputs.health && !inputs.missing;
      if (id !== 'collector_stale' && !id.startsWith('sync_stale:')) return false;
      if (start === null) return true;
      // A new window's grace period can hide ongoing staleness until the threshold elapses.
      const last = id === 'collector_stale' ? inputs.health?.lastRunAt
        : inputs.health?.accounts.find(account => account.name === id.slice('sync_stale:'.length))?.lastSuccessAt;
      return now - start <= config.staleMinutes * 60000 && (last === null || (last !== undefined && Date.parse(last) < start));
    },
  });
} catch (error) {
  console.error(JSON.stringify({ event: 'alert_dispatch_failed', code: errorCode(error, 'ALERT_DISPATCH_FAILED') }));
  process.exitCode = 1;
}
