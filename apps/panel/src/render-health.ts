import type { Alert } from '../../collector/src/health-alerts.js';
import { esc, time } from './render.js';

export function renderHealth(alerts: Alert[], lastRunAt: string | null, timezone: string, production: boolean) {
  if (!alerts.length) return production && lastRunAt ? `<p class="monitor-ok">Monitor: tudo OK · última coleta ${esc(time(Date.parse(lastRunAt), timezone))}</p>` : undefined;
  return `<section aria-label="Alertas do monitor">${alerts.map(a =>
    `<div class="monitor-line${a.severity === 'warning' ? ' monitor-warning' : ''}"><strong>${esc(a.title)}</strong> · ${esc(a.detail)}</div>`).join('')}</section>`;
}
