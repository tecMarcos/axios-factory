import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Alert } from './health-alerts.js';
import type { AlertNotifier } from './alert-notifier.js';
import { errorCode, isCount, isDate, isObject, nullableDate, withLock, writeJson } from './health-files.js';
import { persistNotifyAttempt } from './notify-health.js';

type Entry = Pick<Alert, 'severity' | 'title'> & { firstSeenAt: string; lastSentAt: string | null; lastSentSeverity: Alert['severity'] | null; absentRuns?: number };
export type AlertState = { version: 1; alerts: Record<string, Entry> };

type Keep = (id: string) => boolean;
const emailEligible = (id: string) => !id.startsWith('notify_failing:email');

export function planDispatch(state: AlertState | null, alerts: Alert[], now: number, { reminderHours = 24, keep }: { reminderHours?: number; keep?: Keep } = {}) {
  const newAlerts: Alert[] = [], escalated: Alert[] = [], reminders: Alert[] = [];
  alerts = alerts.filter(alert => emailEligible(alert.id));
  const active = new Set(alerts.map(alert => alert.id));
  const resolved: (Entry & { id: string })[] = [];
  const at = new Date(now).toISOString();
  const nextState: AlertState = { version: 1, alerts: Object.create(null) };
  for (const [id, entry] of Object.entries(state?.alerts ?? {})) {
    if (active.has(id) || !emailEligible(id)) continue;
    if (keep?.(id)) nextState.alerts[id] = entry;
    else if ((entry.absentRuns ?? 0) >= 1) resolved.push({ id, ...entry });
    else nextState.alerts[id] = { ...entry, absentRuns: 1 };
  }
  for (const alert of alerts) {
    const before = state && Object.hasOwn(state.alerts, alert.id) ? state.alerts[alert.id] : undefined;
    const { id, severity, title } = alert;
    const changed = !before?.lastSentAt ? newAlerts
      : severity !== before.lastSentSeverity ? escalated
      : now - Date.parse(before.lastSentAt) >= reminderHours * 3600000 ? reminders : null;
    changed?.push(alert);
    nextState.alerts[id] = {
      severity, title, firstSeenAt: before?.firstSeenAt ?? at,
      lastSentAt: changed ? at : before!.lastSentAt, lastSentSeverity: changed ? severity : before!.lastSentSeverity,
    };
  }
  return { newAlerts, escalated, resolved, reminders, nextState };
}

const logEvent = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

export async function readAlertState(dir: string, log = logEvent): Promise<AlertState | null> {
  let raw: string;
  try { raw = await readFile(join(dir, 'alert-state.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  let state: unknown;
  try { state = JSON.parse(raw); } catch { state = null; }
  const severity = (value: unknown) => value === 'critical' || value === 'warning';
  if (isObject(state) && state.version === 1 && isObject(state.alerts) &&
    Object.values(state.alerts).every(a => isObject(a) && severity(a.severity) && typeof a.title === 'string' && isDate(a.firstSeenAt)
      && (a.absentRuns === undefined || isCount(a.absentRuns)) && nullableDate(a.lastSentAt) && (a.lastSentSeverity === null || severity(a.lastSentSeverity)))) return state as AlertState;
  log({ event: 'alert_state_reset' });
  return null;
}

type DispatchOptions = { dir: string; alerts: Alert[] | (() => Promise<Alert[]>); now: number; notifier: AlertNotifier | null; panelUrl?: string; reminderHours?: number; keep?: Keep; log?: (event: Record<string, unknown>) => void };
export async function dispatchAlerts({ dir, alerts, now, notifier, panelUrl, reminderHours, keep, log = logEvent }: DispatchOptions) {
  return withLock(dir, '.alert.lock', async () => {
    const previous = await readAlertState(dir, log);
    const plan = planDispatch(previous, typeof alerts === 'function' ? await alerts() : alerts, now, { reminderHours, keep });
    const sections = [
      { alerts: plan.newAlerts, title: 'Alertas novos', single: 'alerta novo', plural: 'alertas novos' },
      { alerts: plan.escalated, title: 'Mudanças de gravidade', single: 'mudança de gravidade', plural: 'mudanças de gravidade' },
      { alerts: plan.resolved, title: 'Alertas resolvidos', single: 'resolvido', plural: 'resolvidos' },
      { alerts: plan.reminders, title: 'Lembretes', single: 'lembrete', plural: 'lembretes' },
    ].filter(section => section.alerts.length);
    if (!notifier) {
      log({ event: 'alert_email_disabled', pending: sections.reduce((total, section) => total + section.alerts.length, 0) });
      return false;
    }
    if (!sections.length) {
      if (previous && JSON.stringify(previous) !== JSON.stringify(plan.nextState)) await writeJson(dir, 'alert-state.json', plan.nextState);
      return false;
    }
    const subject = '[Axios Factory] ' + sections.map(s => `${s.alerts.length} ${s.alerts.length === 1 ? s.single : s.plural}`).join(' · ');
    const body = sections.map(s => [s.title, ...s.alerts.map(a => `- ${a.title}${'detail' in a ? ` — ${a.detail}` : ''}`)].join('\n'));
    if (panelUrl) body.push(`Painel: ${panelUrl}`);
    try { await notifier.send(subject, body.join('\n\n')); }
    catch (error) {
      const code = errorCode(error, 'ALERT_EMAIL_FAILED');
      await persistNotifyAttempt(dir, 'email', { at: now, result: 'failed', errorCode: code });
      throw new Error(code);
    }
    try {
      await writeJson(dir, 'alert-state.json', plan.nextState).catch(() => writeJson(dir, 'alert-state.json', plan.nextState));
    } catch (error) {
      log({ event: 'alert_state_write_failed' });
      throw error;
    } finally { await persistNotifyAttempt(dir, 'email', { at: now, result: 'sent' }); }
    return true;
  }, log);
}
