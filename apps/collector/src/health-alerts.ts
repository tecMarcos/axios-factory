import { authError, type Health } from './health.js';
import type { NotifyHealth } from './notify-health.js';
import type { Queue } from './notifications.js';
import { calculatePriority, normalizeDeadline } from './operational.js';

export type Alert = { id: string; severity: 'critical' | 'warning'; title: string; detail: string };
export type HealthConfig = { window: string; staleMinutes: number; sessionWarnDays: number; sessionDays: number };
export const defaultHealthConfig: HealthConfig = { window: '07:20-19:50', staleMinutes: 90, sessionWarnDays: 12, sessionDays: 14 };
const validWindow = (value: string) => /^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
  && value.slice(0, 5) < value.slice(6);
export function healthConfigFromEnv(env: NodeJS.ProcessEnv): HealthConfig {
  const number = (value: string | undefined, fallback: number) => value?.trim() && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
  const sessionWarnDays = number(env.SESSION_WARN_DAYS, defaultHealthConfig.sessionWarnDays);
  const sessionDays = number(env.SESSION_DAYS, defaultHealthConfig.sessionDays);
  return {
    window: env.HEALTH_WINDOW && validWindow(env.HEALTH_WINDOW) ? env.HEALTH_WINDOW : defaultHealthConfig.window,
    staleMinutes: number(env.HEALTH_STALE_MINUTES, defaultHealthConfig.staleMinutes) || defaultHealthConfig.staleMinutes,
    sessionWarnDays: sessionWarnDays <= sessionDays ? sessionWarnDays : defaultHealthConfig.sessionWarnDays,
    sessionDays: sessionWarnDays <= sessionDays ? sessionDays : defaultHealthConfig.sessionDays,
  };
}
const day = 86400000;
export const sessionAgeDays = (start: string | null, now: number) => start === null ? null : Math.max(0, Math.floor((now - Date.parse(start)) / day));

export function windowStart(now: number, timeZone: string, window: string) {
  if (!validWindow(window)) return null;
  const [start, end] = window.split('-');
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(date.formatToParts(now).map(part => [part.type, part.value]));
  const clock = `${p.hour}:${p.minute}`;
  return clock >= start! && clock <= end! ? normalizeDeadline(null, `${p.year}-${p.month}-${p.day} ${start}`, timeZone).deadlineEpoch : null;
}

export function evaluateAlerts({ health, notify, queue, now, timezone, config = {} }: {
  health: Health | null; notify: NotifyHealth | null; queue: Queue | null; now: number; timezone: string; config?: Partial<HealthConfig>;
}): Alert[] {
  const { window, staleMinutes, sessionWarnDays, sessionDays } = { ...defaultHealthConfig, ...config };
  const alerts: Alert[] = [];
  const add = (id: string, severity: Alert['severity'], title: string, detail: string) => alerts.push({ id, severity, title, detail });
  const date = new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, day: '2-digit', month: '2-digit' });
  const clock = new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const format = (at: string | null) => at === null ? 'sem registro' : `${date.format(Date.parse(at))} ${clock.format(Date.parse(at))}`;
  const start = windowStart(now, timezone, window);
  const stale = (at: string | null) => start !== null && now - Math.max(at === null ? -Infinity : Date.parse(at), start) > staleMinutes * 60000;
  if (!health) add('monitor_missing', 'warning', 'Monitor sem dados', 'O coletor ainda não gravou health.json');
  else if (stale(health.lastRunAt)) add('collector_stale', 'critical', 'Coletor sem executar', `Última coleta: ${format(health.lastRunAt)}`);
  for (const account of health?.accounts ?? []) {
    const { name, ok, error, consecutiveFailures, lastSuccessAt, sessionStartedAt, sessionSource } = account;
    const last = `Última sincronização OK: ${format(lastSuccessAt)}`;
    const failure = `${last} · Falhas seguidas: ${consecutiveFailures}`;
    if (!ok && authError(error)) add(`account_down:${name}`, 'critical', `Conta desconectada: ${name}`, failure);
    else if (!ok && consecutiveFailures >= 2) add(`sync_failing:${name}`, 'critical', `Falha de sincronização: ${name}`, failure);
    if (stale(lastSuccessAt)) add(`sync_stale:${name}`, 'warning', `Sincronização atrasada: ${name}`, last);
    const age = sessionAgeDays(sessionStartedAt, now);
    if (sessionStartedAt && age !== null && age >= sessionWarnDays) {
      const login = Date.parse(sessionStartedAt);
      add(`session_expiring:${name}`, age >= sessionDays ? 'critical' : 'warning', `Sessão da conta ${name}`,
        `Login de ${date.format(login)}, vence por volta de ${date.format(login + sessionDays * day)}${sessionSource === 'observed' ? ' (estimado)' : ''}`);
    }
  }
  let overdue = 0, critical = 0;
  for (const order of queue?.orders ?? []) {
    const priority = calculatePriority(order.deadlineEpoch, now);
    if (priority === 'OVERDUE') overdue++;
    if (priority === 'CRITICAL') critical++;
  }
  if (overdue) add('orders_overdue', 'critical', overdue === 1 ? '1 pedido atrasado' : `${overdue} pedidos atrasados`, 'O prazo de envio já passou.');
  if (critical) add('orders_critical', 'warning', critical === 1 ? '1 pedido com prazo crítico' : `${critical} pedidos com prazo crítico`, 'O prazo de envio vence em até 6 horas.');
  for (const [channel, status] of Object.entries(notify?.channels ?? {})) {
    if (status.consecutiveFailures >= 1) add(`notify_failing:${channel}`, 'critical', `Falha no envio por ${channel === 'email' ? 'e-mail' : 'WhatsApp'}`,
      `${status.lastErrorCode ?? 'Erro desconhecido'}${status.httpStatus === null ? '' : ` (HTTP ${status.httpStatus})`} · Último envio: ${format(status.lastSentAt)}`);
  }
  return alerts.sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical') || (a.id < b.id ? -1 : Number(a.id > b.id)));
}
