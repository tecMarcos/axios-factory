export class CollectorError extends Error {
  constructor(public code: string) { super(code); }
}
export const profiles = {
  TO_SHIP: { timeType: 0, searchType: 0, searchValue: '', sortName: 1, sortValue: 1, orderState: 'to_ship', isVoided: 0, arrangeStatus: 'to_arrange', pageNum: 1, pageSize: 50 },
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
export function normalize(value: unknown) {
  const row = object(value);
  if (!Array.isArray(row.orderItemList)) throw new CollectorError('INVALID_ITEMS');
  return {
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
export function parseResponse(status: number, contentType: string, body: unknown, contract: Contract) {
  if ([401, 403].includes(status) || (status >= 300 && status < 400) || contentType.includes('text/html')) throw new CollectorError('AUTH_REQUIRED_OR_ACCESS_DENIED');
  if (status !== 200) throw new CollectorError('HTTP_ERROR');
  if (!contentType.includes('application/json')) throw new CollectorError('INVALID_CONTENT_TYPE');
  if (at(body, contract.successPath) !== contract.successValue) throw new CollectorError('API_REJECTED_OR_SESSION_EXPIRED');
  const list = at(body, contract.ordersPath), rawTotal = at(body, contract.totalPath);
  if (!Array.isArray(list) || !['string', 'number'].includes(typeof rawTotal) || String(rawTotal).trim() === '') throw new CollectorError('INVALID_SCHEMA');
  const total = Number(rawTotal);
  if (!Number.isSafeInteger(total) || total < 0) throw new CollectorError('INVALID_TOTAL');
  return { orders: list.map(normalize), total };
}
export type FetchPage = (profile: Profile, page: number) => Promise<{ orders: Order[]; total: number }>;
export async function collect(fetchPage: FetchPage, maxPages = 1000) {
  const unique = new Map<string, Order>();
  const counts = { TO_SHIP: 0, TO_PICKUP: 0 };
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
        // TO_PICKUP is the later workflow stage; prefer it for identical items.
        unique.set(order.orderNumber, order);
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
  return { orders, summary: { collectedAt: new Date().toISOString(), counts, uniqueOrders: orders.length, units, products: [...products].map(([name, units]) => ({ name, units })).sort((a,b) => a.name.localeCompare(b.name)) } };
}
