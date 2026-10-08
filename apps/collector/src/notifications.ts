import { aggregateProduction, calculatePriority, defaultTimezone, priorities, validateTimezone, type buildProductionQueue, type Priority } from './operational.js';
import { isDeepStrictEqual } from 'node:util';
export type Queue = ReturnType<typeof buildProductionQueue>;
export type Summary = ReturnType<typeof aggregateProduction>;
export type AlertType = 'NEW_URGENT' | 'NEW_CRITICAL' | 'NEW_OVERDUE';
export type MessageOptions = { now: number; timezone?: string; topProducts?: number };
const fail = (): never => { throw new Error('INVALID_NOTIFICATION_SNAPSHOT'); };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const iso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const nullableText = (v: unknown) => v === null || typeof v === 'string';
// Validate at the boundary, then compare the supplied summary with the existing V0.3 aggregator.
export function validateSnapshot(q: unknown, s: unknown): { queue: Queue; summary: Summary } {
  if (!record(q) || !iso(q.generatedAt) || !Array.isArray(q.orders)) return fail();
  const ids = new Set<string>();
  for (const o of q.orders) {
    if (!record(o) || typeof o.orderNumber !== 'string' || !o.orderNumber.trim() || ids.has(o.orderNumber) || !priorities.includes(o.priority as Priority) || !Array.isArray(o.items)) return fail();
    ids.add(o.orderNumber);
    if (o.deadlineEpoch !== null && (typeof o.deadlineEpoch !== 'number' || !Number.isSafeInteger(o.deadlineEpoch) || o.deadlineEpoch <= 0 || o.deadlineEpoch > 8640000000000000)) return fail();
    const epoch = o.deadlineEpoch as number | null;
    if (o.deadline !== (epoch === null ? null : new Date(epoch).toISOString()) || o.priority !== calculatePriority(epoch, Date.parse(q.generatedAt)) || o.hoursRemaining !== (epoch === null ? null : (epoch - Date.parse(q.generatedAt)) / 3600000)) return fail();
    if (!Array.isArray(o.queues) || !o.queues.length || o.queues.some(p => !['TO_INVOICE', 'TO_SHIP', 'TO_PRINT', 'TO_PICKUP'].includes(p)) || typeof o.operationalStage !== 'string') return fail();
    for (const i of o.items) {
      if (!record(i) || typeof i.productName !== 'string' || !i.productName.trim() || !nullableText(i.productAttr) || !nullableText(i.productId) || !nullableText(i.variationId) || typeof i.quantity !== 'number' || !Number.isSafeInteger(i.quantity) || i.quantity < 0) return fail();
    }
  }
  const queue = q as Queue, expected = aggregateProduction(queue);
  if (!record(s) || !isDeepStrictEqual(s, expected)) return fail();
  return { queue, summary: expected };
}
const labels: Record<Priority, string> = { OVERDUE: '🚨 Atrasados', CRITICAL: '🔴 Críticos', URGENT: '⚠️ Urgentes', ATTENTION: '🟡 Atenção', NORMAL: '🟢 Normal', UNKNOWN: '❔ Desconhecidos' };
export function validateMessageOptions(o: MessageOptions) {
  const timezone = validateTimezone(o.timezone ?? defaultTimezone), topProducts = o.topProducts ?? 5;
  if (!Number.isFinite(o.now) || !Number.isSafeInteger(topProducts) || topProducts < 1) throw new Error('INVALID_NOTIFICATION_OPTIONS');
  return { ...o, timezone, topProducts };
}
// Only allowlisted product display fields reach messages. Remove control/log injection characters.
const clean = (s: string | null) => (s ?? '').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').trim();
const product = (quantity: number, name: string, attr: string | null) => `• ${quantity}x ${clean(name)}${attr ? ` — ${clean(attr)}` : ''}`;
const counts = (s: Summary) => priorities.filter(p => s.priorityCounts[p] > 0).map(p => `${labels[p]}: ${s.priorityCounts[p]}`);
const date = (epoch: number, timezone: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(epoch);
function products(s: Summary, top: number) {
  return [...s.products.slice(0, top).map(p => product(p.totalQuantity, p.productName, p.productAttr)), ...(s.products.length > top ? [`+ ${s.products.length - top} outros itens na fila`] : [])];
}
export function buildOperationalMessage(summary: Summary, queue: Queue, input: MessageOptions): string {
  const o = validateMessageOptions(input); validateSnapshot(queue, summary);
  const deadlines = queue.orders.flatMap(order => order.deadlineEpoch === null ? [] : [order.deadlineEpoch]);
  const past = deadlines.filter(d => d <= o.now), future = deadlines.filter(d => d > o.now);
  return ['Axios Factory — Prioridades', '', ...counts(summary), '', 'Produção prioritária:', ...products(summary, o.topProducts), '', ...(past.length ? [`Atraso mais antigo: ${Math.floor((o.now - Math.min(...past)) / 3600000)}h`] : []), `Próximo prazo: ${future.length ? date(Math.min(...future), o.timezone) : 'nenhum conhecido'}`, '', `Pedidos: ${summary.totals.orders}`, `Unidades: ${summary.totals.units}`].join('\n');
}
export function buildPriorityAlert(type: AlertType, order: Queue['orders'][number], summary: Summary, input: MessageOptions): string {
  const o = validateMessageOptions(input);
  if (`NEW_${order.priority}` !== type) throw new Error('INVALID_ALERT_TYPE');
  return [`Axios Factory — ${type}`, '', ...order.items.slice(0, o.topProducts).map(i => product(i.quantity, i.productName, i.productAttr)), ...(order.items.length > o.topProducts ? [`+ ${order.items.length - o.topProducts} outros itens na fila`] : []), `Prazo: ${order.deadlineEpoch === null ? 'desconhecido' : date(order.deadlineEpoch, o.timezone)}`, ...(order.deadlineEpoch !== null && order.deadlineEpoch <= o.now ? [`Atraso: ${Math.floor((o.now - order.deadlineEpoch) / 60000)}min`] : []), '', 'Fila atual:', ...counts(summary)].join('\n');
}
export type NotificationState = { version: 1; orders: Record<string, { lastPriority: Priority; lastAlertedPriority: Priority | null }> };
export function transition(previous: Priority, current: Priority): AlertType | null {
  if (priorities.indexOf(current) >= priorities.indexOf(previous)) return null;
  return current === 'URGENT' || current === 'CRITICAL' || current === 'OVERDUE' ? `NEW_${current}` : null;
}
