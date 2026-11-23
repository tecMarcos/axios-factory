import { setTimeout } from 'node:timers/promises';
import { fileErrorCode, isCount, isObject, nullableCode, nullableDate, readJson, withLock, writeJson } from './health-files.js';

const channels = ['whatsapp', 'email'] as const;
type Channel = typeof channels[number];
type Result = 'sent' | 'dry_run' | 'failed';
type Attempt = { at: number; result: Result; errorCode?: string; httpStatus?: number };
type ChannelHealth = {
  lastAttemptAt: string | null; lastSentAt: string | null; lastResult: Result | null;
  lastErrorCode: string | null; httpStatus: number | null; consecutiveFailures: number;
};
export type NotifyHealth = { version: 1; channels: Record<Channel, ChannelHealth> };
const blank = (): ChannelHealth => ({ lastAttemptAt: null, lastSentAt: null, lastResult: null, lastErrorCode: null, httpStatus: null, consecutiveFailures: 0 });
export const emptyNotifyHealth = (): NotifyHealth => ({ version: 1, channels: { whatsapp: blank(), email: blank() } });
export function recordNotify(previous: NotifyHealth | null, channel: Channel, attempt: Attempt): NotifyHealth {
  const state = previous ?? emptyNotifyHealth(), before = state.channels[channel], at = new Date(attempt.at).toISOString();
  return { version: 1, channels: { ...state.channels, [channel]: {
    lastAttemptAt: at, lastSentAt: attempt.result === 'sent' ? at : before.lastSentAt,
    lastResult: attempt.result, lastErrorCode: attempt.result === 'failed' ? attempt.errorCode ?? null : null,
    httpStatus: attempt.httpStatus ?? null, consecutiveFailures: attempt.result === 'failed' ? before.consecutiveFailures + 1 : 0,
  } } };
}
function validChannel(c: unknown): c is ChannelHealth {
  return isObject(c) && nullableDate(c.lastAttemptAt) && nullableDate(c.lastSentAt)
    && [null, 'sent', 'dry_run', 'failed'].includes(c.lastResult as Result | null) && nullableCode(c.lastErrorCode)
    && (c.httpStatus === null || isCount(c.httpStatus)) && isCount(c.consecutiveFailures);
}
export async function readNotifyHealth(dir: string): Promise<NotifyHealth | null> {
  const h = await readJson(dir, 'notify-health.json');
  if (!isObject(h) || h.version !== 1 || !isObject(h.channels)) return null;
  const { whatsapp, email } = h.channels;
  if (!validChannel(whatsapp) || !validChannel(email)) return null;
  const summary = ({ lastAttemptAt, lastSentAt, lastResult, lastErrorCode, httpStatus, consecutiveFailures }: ChannelHealth) =>
    ({ lastAttemptAt, lastSentAt, lastResult, lastErrorCode, httpStatus, consecutiveFailures });
  return { version: 1, channels: { whatsapp: summary(whatsapp), email: summary(email) } };
}
export const writeNotifyHealth = (dir: string, health: NotifyHealth) => writeJson(dir, 'notify-health.json', health);
export async function persistNotifyAttempt(dir: string, channel: Channel, attempt: Attempt) {
  try {
    for (let retry = 0; ; retry++) {
      try {
        await withLock(dir, '.notify-health.lock', async () => writeNotifyHealth(dir, recordNotify(await readNotifyHealth(dir), channel, attempt)));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || retry === 20) throw error;
        await setTimeout(25);
      }
    }
  } catch (error) { console.error(JSON.stringify({ event: 'health_write_failed', code: fileErrorCode(error) })); }
}
