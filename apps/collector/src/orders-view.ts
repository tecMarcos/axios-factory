import { calculateHoursRemaining, calculatePriority, priorities, type Priority } from './operational.js';
import type { Queue } from './notifications.js';

export type QueueOrder = Queue['orders'][number];

/** Words that mark a product as personalized (needs a name in the UpSeller note). Case/accent-insensitive. */
export const defaultPersonalizationKeywords = ['natal', 'bolinha'];

export function parseKeywords(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return defaultPersonalizationKeywords;
  return value.split(',').map(fold).filter(Boolean);
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Remove control and bidi-override characters before showing marketplace text anywhere. */
export const cleanText = (s: string | null | undefined) => (s ?? '').replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();

export function needsPersonalization(order: Pick<QueueOrder, 'items'>, keywords = defaultPersonalizationKeywords): boolean {
  return order.items.some(item => { const name = fold(item.productName); return keywords.some(k => name.includes(k)); });
}

export function personalizationStatus(order: Pick<QueueOrder, 'items' | 'note'>, keywords = defaultPersonalizationKeywords): 'NOT_NEEDED' | 'MISSING' | 'OK' {
  if (!needsPersonalization(order, keywords)) return 'NOT_NEEDED';
  return cleanText(order.note) ? 'OK' : 'MISSING';
}

export const platformLabel = (platform: string | null | undefined) =>
  platform === 'shopee' ? 'Shopee' : platform === 'tiktok' ? 'TikTok' : platform ? cleanText(platform) : 'Loja';

/** The number people search for in the marketplace; falls back to the UpSeller number. */
export const displayOrderId = (order: Pick<QueueOrder, 'platformOrderId' | 'orderNumber'>) => cleanText(order.platformOrderId) || cleanText(order.orderNumber);

const idPattern = /^[A-Za-z0-9]{6,40}$/;

/** Seller-centre link for the order, only for known platforms and well-formed ids. */
export function marketplaceUrl(order: Pick<QueueOrder, 'platform' | 'platformOrderId'>): string | null {
  const id = order.platformOrderId ?? '';
  if (!idPattern.test(id)) return null;
  if (order.platform === 'tiktok') return `https://seller-br.tiktok.com/order/detail?order_no=${encodeURIComponent(id)}`;
  if (order.platform === 'shopee') return `https://seller.shopee.com.br/portal/sale/order?search=${encodeURIComponent(id)}`;
  return null;
}

export const stageLabels: Record<string, string> = {
  NEEDS_INVOICE: 'Emitir nota fiscal',
  NEEDS_SHIPPING: 'Programar envio',
  NEEDS_PRINT_PROCESSING: 'Imprimir etiqueta',
  NEEDS_PICKUP: 'Aguardando coleta',
};
export const stageLabel = (stage: string, printLabelState?: string | null) =>
  stage === 'NEEDS_PRINT_PROCESSING' && printLabelState === 'PRINT_LABEL_PRINTED' ? 'Etiqueta impressa' : stageLabels[stage] ?? 'Etapa desconhecida';

export const priorityLabels: Record<Priority, { icon: string; title: string }> = {
  OVERDUE: { icon: '🚨', title: 'Atrasados' },
  CRITICAL: { icon: '🔴', title: 'Críticos' },
  URGENT: { icon: '⚠️', title: 'Urgentes' },
  ATTENTION: { icon: '🟡', title: 'Atenção' },
  NORMAL: { icon: '🟢', title: 'Normal' },
  UNKNOWN: { icon: '❔', title: 'Sem prazo' },
};

export type LiveOrder = QueueOrder & { livePriority: Priority; liveHours: number | null };
/** Recompute priority against "now" so the panel stays right between collections. */
export function groupByPriority(queue: Queue, now: number) {
  const groups = new Map<Priority, LiveOrder[]>(priorities.map(p => [p, []]));
  for (const order of queue.orders) {
    const livePriority = calculatePriority(order.deadlineEpoch, now);
    groups.get(livePriority)!.push({ ...order, livePriority, liveHours: calculateHoursRemaining(order.deadlineEpoch, now) });
  }
  for (const list of groups.values()) list.sort((a, b) => (a.deadlineEpoch ?? Infinity) - (b.deadlineEpoch ?? Infinity));
  return groups;
}

export function formatRemaining(hours: number | null): string {
  if (hours === null) return 'sem prazo';
  const total = Math.round(Math.abs(hours) * 60), h = Math.floor(total / 60), m = total % 60;
  const text = h >= 48 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h${m ? ` ${String(m).padStart(2, '0')}min` : ''}` : `${m}min`;
  return hours <= 0 ? `atrasado ${text}` : `faltam ${text}`;
}
