import type { Queue } from '../../collector/src/notifications.js';
import { displayOrderId, groupByPriority } from '../../collector/src/orders-view.js';
import { resolveItem, type ComponentMap } from './component-map.js';
import { nameStatuses, validateNames } from './names.js';

type Parts = Record<string, number>;

function addParts(total: Parts, parts: Parts) {
  for (const [id, count] of Object.entries(parts)) total[id] = (Object.hasOwn(total, id) ? total[id]! : 0) + count;
}

type Unmapped = Pick<Queue['orders'][number]['items'][number], 'productId' | 'variationId' | 'productName' | 'productAttr'> & {
  orderCount: number; guess: Parts | null; reason?: string;
};

export function buildProductionView(queue: Queue, map: ComponentMap, now: number) {
  const emptyParts = () => Object.fromEntries(Object.keys(map.componentes).map(id => [id, 0]));
  const totals = { aProduzir: emptyParts(), jaEmbalados: emptyParts(), unconfirmedParts: emptyParts() };
  const nameCounts = Object.fromEntries(nameStatuses.map(status => [status, 0])) as Record<typeof nameStatuses[number], number>;
  const unmapped = new Map<string, Unmapped>();
  const seen = new Set<string>();
  const unique = queue.orders.filter(order => {
    const key = `${order.platform ?? ''}|${order.account ?? ''}|${order.orderNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const orders = [...groupByPriority({ ...queue, orders: unique }, now).values()].flat().flatMap(order => {
    const items = order.items.map(item => ({ ...item, resolution: resolveItem(item, map) }));
    if (items.every(item => item.resolution.kind === 'other')) return [];
    const packed = order.operationalStage === 'NEEDS_PICKUP';
    const parts = emptyParts();
    const variants = new Set<string>();
    let expectedNames = 0, personalizedLines = 0, mappingPending = false;
    for (const item of items) {
      const { resolution, productId, variationId, productName, productAttr } = item;
      if (resolution.kind === 'mapped') {
        addParts(parts, resolution.parts);
        if (!packed && !resolution.confirmed) addParts(totals.unconfirmedParts, resolution.parts);
        expectedNames += resolution.expectedNames;
        if (resolution.expectedNames > 0) personalizedLines++;
        mappingPending ||= !resolution.confirmed || resolution.attrChanged;
      } else if (resolution.kind === 'unmapped_christmas') {
        mappingPending = true;
        const key = JSON.stringify(productId && variationId ? [productId, variationId] : [productId, variationId, productName, productAttr]);
        if (variants.has(key)) continue;
        variants.add(key);
        const entry = unmapped.get(key) ?? { productId, variationId, productName, productAttr, orderCount: 0, guess: resolution.guess, reason: resolution.reason };
        entry.orderCount++;
        unmapped.set(key, entry);
      }
    }
    addParts(packed ? totals.jaEmbalados : totals.aProduzir, parts);
    const nameValidation = validateNames(order.note, expectedNames, {
      personalizedLines, mappingPending, unmappedChristmas: variants.size > 0,
      hasOtherItems: expectedNames > 0 && items.some(item => item.resolution.kind === 'other'),
    });
    nameCounts[nameValidation.status]++;
    const { orderNumber, account, platform, livePriority, liveHours, operationalStage: stage, printLabelState } = order;
    return [{ orderNumber, account, platform, displayId: displayOrderId(order), livePriority, liveHours, stage, printLabelState, packed, items, parts, note: order.note, expectedNames, nameValidation, mappingPending }];
  });
  return { orders, totals, nameCounts, unmapped: [...unmapped.values()] };
}
