import { aggregateProduction, calculatePriority, defaultTimezone, priorities, validateTimezone, type buildProductionQueue, type Priority } from './operational.js';
import { isDeepStrictEqual } from 'node:util';
import { cleanText, defaultPersonalizationKeywords, displayOrderId, formatRemaining, personalizationStatus, platformLabel } from './orders-view.js';
export type Queue = ReturnType<typeof buildProductionQueue>;
export type Summary = ReturnType<typeof aggregateProduction>;
export type AlertType = 'NEW_URGENT' | 'NEW_CRITICAL' | 'NEW_OVERDUE';
export type MessageOptions = { now: number; timezone?: string; topProducts?: number; panelUrl?: string; listLimit?: number; personalizationKeywords?: string[] };
const fail = (): never => { throw new Error('INVALID_NOTIFICATION_SNAPSHOT'); };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const iso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const nullableText = (v: unknown) => v === null || typeof v === 'string';
const optionalText = (v: unknown) => v === undefined || nullableText(v);
// Validate at the boundary, then compare the supplied summary with the existing V0.3 aggregator.
export function validateSnapshot(q: unknown, s: unknown): { queue: Queue; summary: Summary } {
  if (!record(q) || !iso(q.generatedAt) || !Array.isArray(q.orders)) return fail();
  if (q.accounts !== undefined && (!Array.isArray(q.accounts) || q.accounts.length > 10 || q.accounts.some(a => !record(a) || typeof a.name !== 'string' || !a.name.trim() || typeof a.ok !== 'boolean' || !nullableText(a.error) || !Number.isSafeInteger(a.orders) || (a.orders as number) < 0))) return fail();
  const ids = new Set<string>();
  for (const o of q.orders) {
    if (!record(o) || typeof o.orderNumber !== 'string' || !o.orderNumber.trim() || ids.has(o.orderNumber) || !priorities.includes(o.priority as Priority) || !Array.isArray(o.items)) return fail();
    ids.add(o.orderNumber);
    if (o.deadlineEpoch !== null && (typeof o.deadlineEpoch !== 'number' || !Number.isSafeInteger(o.deadlineEpoch) || o.deadlineEpoch <= 0 || o.deadlineEpoch > 8640000000000000)) return fail();
    const epoch = o.deadlineEpoch as number | null;
    if (o.deadline !== (epoch === null ? null : new Date(epoch).toISOString()) || o.priority !== calculatePriority(epoch, Date.parse(q.generatedAt)) || o.hoursRemaining !== (epoch === null ? null : (epoch - Date.parse(q.generatedAt)) / 3600000)) return fail();
    if (!Array.isArray(o.queues) || !o.queues.length || o.queues.some(p => !['TO_INVOICE', 'TO_SHIP', 'TO_PRINT', 'TO_PICKUP'].includes(p)) || typeof o.operationalStage !== 'string') return fail();
    // Panel fields are optional so snapshots written before they existed stay valid.
    if (![o.platform, o.shopName, o.platformOrderId, o.note, o.printLabelState].every(optionalText)) return fail();
    if (o.account !== undefined && (typeof o.account !== 'string' || !o.account.trim())) return fail();
    if (o.scanKeys !== undefined && (!Array.isArray(o.scanKeys) || o.scanKeys.length > 20 || o.scanKeys.some(k => typeof k !== 'string' || !/^[0-9a-f]{32}$/.test(k)))) return fail();
    for (const i of o.items) {
      if (!record(i) || typeof i.productName !== 'string' || !i.productName.trim() || !nullableText(i.productAttr) || !nullableText(i.productId) || !nullableText(i.variationId) || typeof i.quantity !== 'number' || !Number.isSafeInteger(i.quantity) || i.quantity < 0) return fail();
      if (!optionalText(i.productSku) || !optionalText(i.productImg)) return fail();
    }
  }
  const queue = q as Queue, expected = aggregateProduction(queue);
  if (!record(s) || !isDeepStrictEqual(s, expected)) return fail();
  return { queue, summary: expected };
}
const labels: Record<Priority, string> = { OVERDUE: '🚨 Atrasados', CRITICAL: '🔴 Críticos', URGENT: '⚠️ Urgentes', ATTENTION: '🟡 Atenção', NORMAL: '🟢 Normal', UNKNOWN: '❔ Desconhecidos' };
export function validateMessageOptions(o: MessageOptions) {
  const timezone = validateTimezone(o.timezone ?? defaultTimezone), topProducts = o.topProducts ?? 5, listLimit = o.listLimit ?? 8;
  if (!Number.isFinite(o.now) || !Number.isSafeInteger(topProducts) || topProducts < 1 || !Number.isSafeInteger(listLimit) || listLimit < 0) throw new Error('INVALID_NOTIFICATION_OPTIONS');
  const panelUrl = o.panelUrl?.trim() ? validatePanelUrl(o.panelUrl.trim()) : undefined;
  return { ...o, timezone, topProducts, listLimit, panelUrl, personalizationKeywords: o.personalizationKeywords ?? defaultPersonalizationKeywords };
}
function validatePanelUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('INVALID_PANEL_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || /\s/.test(value)) throw new Error('INVALID_PANEL_URL');
  return url.href;
}
const short = (s: string, max = 40) => { const t = cleanText(s); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
function orderLine(order: Queue['orders'][number], now: number, keywords: string[]) {
  const [first] = order.items, extra = order.items.length - 1;
  const what = first ? `${first.quantity}x ${short(first.productName)}${extra > 0 ? ` +${extra} ${extra === 1 ? 'item' : 'itens'}` : ''}` : 'sem itens';
  const missing = personalizationStatus(order, keywords) === 'MISSING' ? ' ⚠️ sem nome' : '';
  return `• ${platformLabel(order.platform)} ${displayOrderId(order)}${order.account ? ` (${cleanText(order.account)})` : ''} — ${what} · ${formatRemaining(order.deadlineEpoch === null ? null : (order.deadlineEpoch - now) / 3600000)}${missing}`;
}
const listed: Priority[] = ['OVERDUE', 'CRITICAL', 'URGENT'];
function orderLists(queue: Queue, o: ReturnType<typeof validateMessageOptions>) {
  if (o.listLimit === 0) return [];
  return listed.flatMap(p => {
    const orders = queue.orders.filter(order => order.priority === p);
    if (!orders.length) return [];
    return ['', `${labels[p]} (${orders.length})`, ...orders.slice(0, o.listLimit).map(order => orderLine(order, o.now, o.personalizationKeywords)), ...(orders.length > o.listLimit ? [`+ ${orders.length - o.listLimit} outros no painel`] : [])];
  });
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
  const missingNames = queue.orders.filter(order => personalizationStatus(order, o.personalizationKeywords) === 'MISSING').length;
  const failed = (queue.accounts ?? []).filter(a => !a.ok).map(a => `⚠️ Conta ${cleanText(a.name)}: ${a.error === 'AUTH_REQUIRED' || a.error === 'API_REJECTED_OR_SESSION_EXPIRED' ? 'login no UpSeller expirou' : 'falha ao ler pedidos'} — pedidos dela não estão na lista`);
  return ['Axios Factory — Prioridades', ...(failed.length ? ['', ...failed] : []), '', ...counts(summary), ...orderLists(queue, o), ...(missingNames ? ['', `✏️ Personalizados sem nome no UpSeller: ${missingNames}`] : []), '', 'Produção prioritária:', ...products(summary, o.topProducts), '', ...(past.length ? [`Atraso mais antigo: ${Math.floor((o.now - Math.min(...past)) / 3600000)}h`] : []), `Próximo prazo: ${future.length ? date(Math.min(...future), o.timezone) : 'nenhum conhecido'}`, '', `Pedidos: ${summary.totals.orders}`, `Unidades: ${summary.totals.units}`, ...(o.panelUrl ? ['', `📋 Painel: ${o.panelUrl}`] : [])].join('\n');
}
export function buildPriorityAlert(type: AlertType, order: Queue['orders'][number], summary: Summary, input: MessageOptions): string {
  const o = validateMessageOptions(input);
  if (`NEW_${order.priority}` !== type) throw new Error('INVALID_ALERT_TYPE');
  const missing = personalizationStatus(order, o.personalizationKeywords) === 'MISSING';
  return [`Axios Factory — ${type}`, `${platformLabel(order.platform)} ${displayOrderId(order)}${missing ? ' ⚠️ sem nome no UpSeller' : ''}`, '', ...order.items.slice(0, o.topProducts).map(i => product(i.quantity, i.productName, i.productAttr)), ...(order.items.length > o.topProducts ? [`+ ${order.items.length - o.topProducts} outros itens na fila`] : []), `Prazo: ${order.deadlineEpoch === null ? 'desconhecido' : date(order.deadlineEpoch, o.timezone)}`, ...(order.deadlineEpoch !== null && order.deadlineEpoch <= o.now ? [`Atraso: ${Math.floor((o.now - order.deadlineEpoch) / 60000)}min`] : []), '', 'Fila atual:', ...counts(summary), ...(o.panelUrl ? ['', `📋 Painel: ${o.panelUrl}`] : [])].join('\n');
}
export type NotificationState = { version: 1; orders: Record<string, { lastPriority: Priority; lastAlertedPriority: Priority | null }> };
export function transition(previous: Priority, current: Priority): AlertType | null {
  if (priorities.indexOf(current) >= priorities.indexOf(previous)) return null;
  return current === 'URGENT' || current === 'CRITICAL' || current === 'OVERDUE' ? `NEW_${current}` : null;
}
