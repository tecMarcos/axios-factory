import { normalizeDeadline, defaultTimezone, buildProductionQueue, aggregateProduction } from './operational.js';
export class CollectorError extends Error {
  constructor(public code: string) { super(code); }
}
export const profiles = {
  TO_INVOICE: { timeType: 0, searchType: 0, searchValue: '', sortName: 1, sortValue: 1, orderState: 'invoice_pending', isVoided: 0, invoiceStatus: 'to_issue', pageNum: 1, pageSize: 50 },
  TO_SHIP: { timeType: 0, searchType: 0, searchValue: '', sortName: 1, sortValue: 1, orderState: 'to_ship', isVoided: 0, arrangeStatus: 'to_arrange', pageNum: 1, pageSize: 50 },
  TO_PRINT: { timeType: 0, searchType: 0, searchValue: '', sortName: 1, sortValue: 1, orderState: 'in_process', isVoided: 0, labelStatus: 'success', pageNum: 1, pageSize: 50, warehouseType: 0 },
  TO_PICKUP: { timeType: 0, searchType: 0, searchValue: '', sortName: 1, sortValue: 1, orderState: 'to_pickup', isVoided: 0, pickupStatus: 'to_pickup', pageNum: 1, pageSize: 50 },
} as const;
export type Profile = keyof typeof profiles;
type Row = Record<string, unknown>;
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CollectorError('INVALID_SCHEMA');
  return value as Row;
}
function text(value: unknown, required = false): string | null {
  if (value == null && !required) return null;
  if ((typeof value !== 'string' && typeof value !== 'number') || (required && String(value).trim() === '')) throw new CollectorError('INVALID_FIELD');
  return String(value);
}
export type PrintLabelState = 'PRINT_LABEL_NOT_PRINTED' | 'PRINT_LABEL_PRINTED';
export function normalize(value: unknown, profile?: Profile, timezone = defaultTimezone) {
  const row = object(value);
  if (!Array.isArray(row.orderItemList)) throw new CollectorError('INVALID_ITEMS');
  let printLabelState: PrintLabelState | undefined;
  if (profile === 'TO_PRINT') {
    if (row.isPrintLabel !== 0 && row.isPrintLabel !== 1) throw new CollectorError('INVALID_PRINT_LABEL_STATE');
    printLabelState = row.isPrintLabel === 0 ? 'PRINT_LABEL_NOT_PRINTED' : 'PRINT_LABEL_PRINTED';
  }
  return {
    ...normalizeDeadline(row.orderTimeoutTime, row.orderTimeoutTimeStr, timezone),
    ...(printLabelState === undefined ? {} : { printLabelState }),
    orderNumber: text(row.orderNumber, true)!, platform: text(row.platform), shopName: text(row.shopName),
    orderCreateTime: text(row.orderCreateTime), orderPayTime: text(row.orderPayTime),
    orderTimeoutTimeStr: text(row.orderTimeoutTimeStr), orderState: text(row.orderState), providerName: text(row.providerName),
    orderItemList: row.orderItemList.map(value => {
      const item = object(value);
      if (!['number', 'string'].includes(typeof item.productCount) || String(item.productCount).trim() === '') throw new CollectorError('INVALID_QUANTITY');
      const count = Number(item.productCount);
      if (!Number.isSafeInteger(count) || count < 0) throw new CollectorError('INVALID_QUANTITY');
      return { productId: text(item.productId), productName: text(item.productName, true)!, variationId: text(item.variationId), productCount: count, price: text(item.price), productAttr: text(item.productAttr) };
    }),
  };
}
export type Order = ReturnType<typeof normalize>;
export type Contract = { ordersPath: string; totalPath: string; successPath: string; successValue: unknown };
function at(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, key) => object(v)[key], value);
}
export function parseResponse(status: number, contentType: string, body: unknown, contract: Contract, profile?: Profile, timezone = defaultTimezone) {
  if ([401, 403].includes(status) || (status >= 300 && status < 400) || contentType.includes('text/html')) throw new CollectorError('AUTH_REQUIRED');
  if (status !== 200) throw new CollectorError('HTTP_ERROR');
  if (!contentType.includes('application/json')) throw new CollectorError('INVALID_CONTENT_TYPE');
  if ([401, 403, '401', '403'].includes(at(body, contract.successPath) as string | number)) throw new CollectorError('AUTH_REQUIRED');
  if (at(body, contract.successPath) !== contract.successValue) throw new CollectorError('API_REJECTED_OR_SESSION_EXPIRED');
  const list = at(body, contract.ordersPath), rawTotal = at(body, contract.totalPath);
  if (!Array.isArray(list) || !['string', 'number'].includes(typeof rawTotal) || String(rawTotal).trim() === '') throw new CollectorError('INVALID_SCHEMA');
  const total = Number(rawTotal);
  if (!Number.isSafeInteger(total) || total < 0) throw new CollectorError('INVALID_TOTAL');
  return { orders: list.map(value => normalize(value, profile, timezone)), total };
}
export type FetchPage = (profile: Profile, page: number) => Promise<{ orders: Order[]; total: number }>;
export async function collect(fetchPage: FetchPage, maxPages = 1000, now = Date.now()) {
  const unique = new Map<string, Order & { queues: Profile[] }>();
  const counts = { TO_INVOICE: 0, TO_SHIP: 0, TO_PRINT: 0, TO_PICKUP: 0 };
  const print = { notPrinted: 0, printed: 0 };
  for (const profile of Object.keys(profiles) as Profile[]) {
    const seen = new Set<string>();
    let expected: number | undefined;
    let complete = false;
    for (let page = 1; page <= maxPages; page++) {
      const result = await fetchPage(profile, page);
      expected ??= result.total;
      if (expected !== result.total) throw new CollectorError('TOTAL_CHANGED_RETRY');
      if (result.orders.length > 50) throw new CollectorError('INVALID_PAGE_SIZE');
      for (const order of result.orders) {
        if (seen.has(order.orderNumber)) throw new CollectorError('PAGINATION_OVERLAP_RETRY');
        seen.add(order.orderNumber);
        const previous = unique.get(order.orderNumber);
        if (previous && JSON.stringify(previous.orderItemList) !== JSON.stringify(order.orderItemList)) throw new CollectorError('ORDER_CHANGED_RETRY');
        if (profile === 'TO_PRINT') {
          if (order.printLabelState === 'PRINT_LABEL_NOT_PRINTED') print.notPrinted++;
          else if (order.printLabelState === 'PRINT_LABEL_PRINTED') print.printed++;
          else throw new CollectorError('INVALID_PRINT_LABEL_STATE');
        }
        // Preserve later-profile metadata and all memberships without adding units.
        unique.set(order.orderNumber, {
          ...order,
          ...(previous?.printLabelState ? { printLabelState: previous.printLabelState } : {}),
          queues: [...(previous?.queues ?? []), profile],
        });
      }
      if (seen.size > expected) throw new CollectorError('TOTAL_MISMATCH');
      if (seen.size === expected) { complete = true; break; }
      if (result.orders.length === 0) throw new CollectorError('INCOMPLETE_PAGINATION');
    }
    if (!complete) throw new CollectorError('MAX_PAGES_EXCEEDED');
    counts[profile] = seen.size;
  }
  const orders = [...unique.values()].sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));
  const products = new Map<string, number>();
  let units = 0;
  for (const order of orders) for (const item of order.orderItemList) {
    units += item.productCount;
    if (!Number.isSafeInteger(units)) throw new CollectorError('QUANTITY_OVERFLOW');
    products.set(item.productName, (products.get(item.productName) ?? 0) + item.productCount);
  }
  const productionQueue = buildProductionQueue(orders, now);
  const productionSummary = aggregateProduction(productionQueue);
  return { orders, productionQueue, productionSummary, summary: { collectedAt: new Date(now).toISOString(), counts, queues: { ...counts }, print, uniqueOrders: orders.length, units, products: [...products].map(([name, units]) => ({ name, units })).sort((a,b) => a.name.localeCompare(b.name)) } };
}
