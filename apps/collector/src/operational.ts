import type { Order, Profile } from './core.js';
export const priorities = ['OVERDUE', 'CRITICAL', 'URGENT', 'ATTENTION', 'NORMAL', 'UNKNOWN'] as const;
export type Priority = typeof priorities[number];
export const defaultTimezone = 'America/Sao_Paulo';
export function validateTimezone(timeZone: string) { new Intl.DateTimeFormat('en', { timeZone }).format(0); return timeZone; }
function parts(epoch: number, timeZone: string) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(epoch).map(p => [p.type, p.value]));
}
function parseLocal(value: unknown, zone: string): { epoch: number; minutePrecision: boolean } | null {
  if (typeof value !== 'string') return null;
  const brazilian = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(value);
  const m = brazilian
    ? [brazilian[0], brazilian[3], brazilian[2], brazilian[1], brazilian[4], brazilian[5]]
    : /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m || m[0] !== value) return null;
  const [, y, mo, d, h, mi, s = '00'] = m;
  if (+y! < 1 || +mo! < 1 || +mo! > 12 || +d! < 1 || +d! > 31 || +h! > 23 || +mi! > 59 || +s > 59) return null;
  const base = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s);
  const candidates = new Set<number>();
  // Probe offsets on both sides to reject ambiguous/nonexistent DST wall times.
  for (const shift of [-86400000, 0, 86400000]) {
    const probe = base + shift, p = parts(probe, zone);
    const offset = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - probe;
    const candidate = base - offset, c = parts(candidate, zone);
    if (c.year === y && c.month === mo && c.day === d && c.hour === h && c.minute === mi && c.second === s) candidates.add(candidate);
  }
  return candidates.size === 1 ? { epoch: [...candidates][0]!, minutePrecision: m[6] === undefined } : null;
}
export function normalizeDeadline(timestamp: unknown, formatted: unknown, zone = defaultTimezone) {
  validateTimezone(zone);
  const present = (v: unknown) => v != null && v !== '';
  let epoch: number | null = null;
  if (present(timestamp)) {
    const n = typeof timestamp === 'number' || (typeof timestamp === 'string' && /^\d+(\.\d+)?$/.test(timestamp)) ? Number(timestamp) : NaN;
    const ms = n < 100000000000 ? n * 1000 : n;
    if (Number.isSafeInteger(ms) && ms > 0 && ms <= 8640000000000000) epoch = ms;
  }
  const local = present(formatted) ? parseLocal(formatted, zone) : null;
  let warning: string | null = null;
  if (present(timestamp) && epoch === null) warning = 'INVALID_DEADLINE';
  else if (present(formatted) && local === null) warning = 'INVALID_DEADLINE_TEXT';
  else if (epoch !== null && local !== null) {
    const sameMinute = Math.floor(epoch / 60000) === Math.floor(local.epoch / 60000);
    // Minute-only text may round up an epoch ending in :59; retain the original epoch.
    const roundedMinute = local.minutePrecision && epoch < local.epoch && local.epoch - epoch <= 1000;
    if (!sameMinute && !roundedMinute) warning = 'DEADLINE_MISMATCH';
  }
  if (warning) epoch = null;
  else epoch ??= local?.epoch ?? null;
  return { deadline: epoch === null ? null : new Date(epoch).toISOString(), deadlineEpoch: epoch, deadlineWarning: warning };
}
export function calculateHoursRemaining(deadline: number | null, now: number) {
  if (!Number.isFinite(now)) throw new Error('INVALID_COLLECTION_TIME');
  return deadline === null || !Number.isFinite(deadline) ? null : (deadline - now) / 3600000;
}
export function classifyPriority(hours: number | null): Priority {
  if (hours === null || !Number.isFinite(hours)) return 'UNKNOWN';
  if (hours <= 0) return 'OVERDUE';
  return hours <= 6 ? 'CRITICAL' : hours <= 24 ? 'URGENT' : hours <= 48 ? 'ATTENTION' : 'NORMAL';
}
export function calculatePriority(deadline: number | null, now: number) { return classifyPriority(calculateHoursRemaining(deadline, now)); }
export function selectOperationalStage(queues: Profile[]) {
  if (queues.includes('TO_INVOICE')) return 'NEEDS_INVOICE';
  if (queues.includes('TO_SHIP')) return 'NEEDS_SHIPPING';
  if (queues.includes('TO_PRINT')) return 'NEEDS_PRINT_PROCESSING';
  if (queues.includes('TO_PICKUP')) return 'NEEDS_PICKUP';
  return 'UNKNOWN';
}
const rank = (p: Priority) => priorities.indexOf(p);
export function sortOperationalOrders<T extends { priority: Priority; deadlineEpoch: number | null }>(orders: T[]): T[] {
  return [...orders].sort((a, b) => rank(a.priority) - rank(b.priority) || (a.deadlineEpoch ?? Infinity) - (b.deadlineEpoch ?? Infinity));
}
export function buildProductionQueue(orders: (Order & { queues: Profile[] })[], now: number) {
  return { generatedAt: new Date(now).toISOString(), orders: sortOperationalOrders(orders.map(o => ({
    orderNumber: o.orderNumber, priority: calculatePriority(o.deadlineEpoch, now), deadline: o.deadline,
    deadlineEpoch: o.deadlineEpoch, hoursRemaining: calculateHoursRemaining(o.deadlineEpoch, now),
    queues: [...o.queues], operationalStage: selectOperationalStage(o.queues),
    items: o.orderItemList.map(i => ({ productId: i.productId, variationId: i.variationId, productName: i.productName, productAttr: i.productAttr, quantity: i.productCount })),
  }))) };
}
export function aggregateProduction(queue: ReturnType<typeof buildProductionQueue>) {
  type Item = typeof queue.orders[number]['items'][number];
  type Product = Omit<Item, 'quantity'> & { totalQuantity: number; highestPriority: Priority; nearestDeadline: string | null; orderCount: number };
  const groups = new Map<string, { product: Product; orders: Set<string>; epoch: number | null }>();
  const priorityCounts = Object.fromEntries(priorities.map(p => [p, 0])) as Record<Priority, number>;
  let units = 0;
  for (const order of queue.orders) {
    priorityCounts[order.priority]++;
    order.items.forEach((item, index) => {
      // Missing identifiers stay isolated by order/item; never merge by a display name.
      const key = JSON.stringify(item.productId && item.variationId ? ['ids', item.productId, item.variationId] : ['unresolved', order.orderNumber, index]);
      const group = groups.get(key) ?? { product: { productId: item.productId, variationId: item.variationId, productName: item.productName, productAttr: item.productAttr, totalQuantity: 0, highestPriority: order.priority, nearestDeadline: order.deadline, orderCount: 0 }, orders: new Set<string>(), epoch: order.deadlineEpoch };
      units += item.quantity;
      if (!Number.isSafeInteger(units)) throw new Error('QUANTITY_OVERFLOW');
      group.product.totalQuantity += item.quantity;
      group.orders.add(order.orderNumber);
      group.product.orderCount = group.orders.size;
      if (rank(order.priority) < rank(group.product.highestPriority)) group.product.highestPriority = order.priority;
      if (order.deadlineEpoch !== null && (group.epoch === null || order.deadlineEpoch < group.epoch)) { group.epoch = order.deadlineEpoch; group.product.nearestDeadline = order.deadline; }
      groups.set(key, group);
    });
  }
  const products = [...groups.values()].sort((a, b) => rank(a.product.highestPriority) - rank(b.product.highestPriority) || (a.epoch ?? Infinity) - (b.epoch ?? Infinity) || b.product.totalQuantity - a.product.totalQuantity).map(g => g.product);
  return { generatedAt: queue.generatedAt, totals: { orders: queue.orders.length, units }, priorityCounts, products };
}
export function operationalSummary(summary: ReturnType<typeof aggregateProduction>, zone = defaultTimezone, topN = 10) {
  validateTimezone(zone);
  if (!Number.isSafeInteger(topN) || topN < 0) throw new Error('INVALID_OPERATIONAL_TOP_N');
  const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ');
  return ['Axios Factory - Operational Summary', `Pedidos únicos: ${summary.totals.orders}`, `Unidades: ${summary.totals.units}`, ...priorities.map(p => `${p}: ${summary.priorityCounts[p]}`), 'Produção prioritária (necessidade potencial; sem estoque):', ...summary.products.slice(0, topN).map(p => `[${p.highestPriority}] ${clean(p.productName)} - ${clean(p.productAttr ?? '')}: ${p.totalQuantity} un\nPrazo mais próximo: ${p.nearestDeadline ? `${calculateHoursRemaining(Date.parse(p.nearestDeadline), Date.parse(summary.generatedAt))!.toFixed(2)}h (${new Intl.DateTimeFormat('pt-BR', { timeZone: zone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(p.nearestDeadline))}, ${zone})` : 'desconhecido'}`)].join('\n');
}
