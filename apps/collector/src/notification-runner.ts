import { open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { priorities } from './operational.js';
import { buildOperationalMessage, buildPriorityAlert, transition, validateSnapshot, validateMessageOptions, type MessageOptions, type NotificationState } from './notifications.js';
export interface NotificationSender { send(message: string): Promise<void> }
export type Log = (event: Record<string, unknown>) => void;
export class ConsoleNotificationSender implements NotificationSender {
  constructor(private log: Log) {}
  async send(message: string) { this.log({ event: 'notification_dry_run', message }); }
}
export async function writeNotificationState(path: string, state: NotificationState) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(state, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
async function readState(path: string): Promise<NotificationState | null> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  const s = JSON.parse(text);
  if (s?.version !== 1 || !s.orders || typeof s.orders !== 'object' || Array.isArray(s.orders)) throw new Error('INVALID_NOTIFICATION_STATE');
  for (const value of Object.values(s.orders) as NotificationState['orders'][string][]) {
    if (!value || !priorities.includes(value.lastPriority) || (value.lastAlertedPriority !== null && !priorities.includes(value.lastAlertedPriority))) throw new Error('INVALID_NOTIFICATION_STATE');
  }
  return s;
}
export async function runNotifications(mode: 'daily' | 'check', dir: string, options: MessageOptions & { dryRun: boolean }, log: Log, sender?: NotificationSender) {
  validateMessageOptions(options);
  // Resolve the collector's atomic generation once, so a concurrent collection cannot mix snapshots.
  let snapshot: string;
  try { snapshot = await realpath(join(dir, '.current')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; snapshot = dir; }
  const { queue, summary } = validateSnapshot(JSON.parse(await readFile(join(snapshot, 'production-queue.json'), 'utf8')), JSON.parse(await readFile(join(snapshot, 'production-summary.json'), 'utf8')));
  if (!options.dryRun && !sender) throw new Error('NOTIFICATION_SENDER_NOT_CONFIGURED');
  const deliver = async (type: string, message: string) => {
    log({ event: 'notification_generated', type });
    if (options.dryRun) log({ event: 'notification_dry_run', type, message });
    else { await sender!.send(message); log({ event: 'notification_sent', type }); }
  };
  if (mode === 'daily') { await deliver('DAILY_SUMMARY', buildOperationalMessage(summary, queue, options)); return; }
  const lockPath = join(dir, '.notification.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    const statePath = join(dir, 'notification-state.json'), previous = await readState(statePath);
    const next: NotificationState = { version: 1, orders: Object.create(null) };
    for (const order of queue.orders) {
      const before = previous && Object.hasOwn(previous.orders, order.orderNumber) ? previous.orders[order.orderNumber] : undefined;
      const type = before ? transition(before.lastPriority, order.priority) : null;
      if (type) await deliver(type, buildPriorityAlert(type, order, summary, options));
      next.orders[order.orderNumber] = { lastPriority: order.priority, lastAlertedPriority: type && !options.dryRun ? order.priority : before?.lastAlertedPriority ?? null };
    }
    // No state is committed until all deliveries succeed. A partial batch can retry successful messages.
    await writeNotificationState(statePath, next);
    log({ event: previous ? 'notification_skipped' : 'notification_bootstrap', mode: previous ? 'check_complete' : 'silent' });
  } finally { await lock.close(); await unlink(lockPath); }
}
