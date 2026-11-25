import type { Queue } from '../../collector/src/notifications.js';
import { isConsumable, type ComponentMap } from './component-map.js';
import { buildProductionView } from './production.js';

/**
 * Central de Produção — fatia 2: fila de impressão e bancada de embalagem.
 * Só leitura: nada aqui altera pedidos, observações ou estoque no UpSeller.
 */
export type ProductionOrder = ReturnType<typeof buildProductionView>['orders'][number];

export const decisionStatuses = ['pode_enviar', 'revisar', 'nao_enviar', 'ja_embalado'] as const;
export type DecisionStatus = typeof decisionStatuses[number];
export type Decision = { status: DecisionStatus; motivo: string; acao: string };

/**
 * Pode mandar este pedido? Regra estrita: só sai o pedido com mapa confirmado
 * e nomes conferidos (ou sem nomes por não ter mão). Qualquer dúvida segura o pedido.
 */
export function shippingDecision(order: Pick<ProductionOrder, 'packed' | 'mappingPending' | 'nameValidation'>): Decision {
  const names = order.nameValidation;
  if (order.packed) return { status: 'ja_embalado', motivo: 'Já embalado, aguardando coleta', acao: 'Nada a fazer' };
  if (names.status === 'sem_nomes') {
    return { status: 'nao_enviar', motivo: `Falta o nome na observação do UpSeller (${names.expected} esperado${names.expected === 1 ? '' : 's'})`, acao: 'Conferir o nome com o cliente no marketplace e preencher a observação no UpSeller' };
  }
  if (names.status === 'quantidade_divergente') {
    return { status: 'nao_enviar', motivo: `Nomes não batem: ${names.found} encontrado${names.found === 1 ? '' : 's'} de ${names.expected}`, acao: 'Conferir a observação do UpSeller antes de produzir' };
  }
  if (order.mappingPending) {
    return { status: 'revisar', motivo: 'Peças do anúncio ainda não confirmadas no mapa', acao: 'Marcos confirma o mapa de peças' };
  }
  if (names.status === 'revisar') {
    return { status: 'revisar', motivo: names.reasons.length ? `Revisar: ${names.reasons.join(', ')}` : 'Revisar os nomes', acao: 'Ler a observação e conferir os nomes' };
  }
  return { status: 'pode_enviar', motivo: names.status === 'completo' ? 'Nomes conferidos' : 'Sem nomes para conferir', acao: 'Produzir e embalar' };
}

export type PrintJob = {
  orderNumber: string; displayId: string; livePriority: ProductionOrder['livePriority']; liveHours: number | null;
  count: number; names: string[]; motivo?: string;
};
export type PrintLine = { id: string; nome: string; personalizado: boolean; agora: number; aguardando: number; jobs: PrintJob[]; bloqueados: PrintJob[] };

/**
 * Fila de impressão: para cada peça impressa (consumíveis ficam de fora), o que imprimir
 * agora (pedidos liberados, do prazo mais curto para o mais longo) e o que está esperando
 * liberação. Pedidos já embalados não entram.
 */
export function buildPrintQueue(queue: Queue, map: ComponentMap, now: number) {
  const view = buildProductionView(queue, map, now);
  const lines = new Map<string, PrintLine>();
  for (const [id, component] of Object.entries(map.componentes)) {
    if (isConsumable(map, id)) continue;
    lines.set(id, { id, nome: component.nome, personalizado: component.personalizado, agora: 0, aguardando: 0, jobs: [], bloqueados: [] });
  }
  for (const order of view.orders) {
    const decision = shippingDecision(order);
    if (decision.status === 'ja_embalado') continue;
    const personalized = Object.entries(order.parts).filter(([id, count]) => count > 0 && lines.get(id)?.personalizado);
    for (const [id, count] of Object.entries(order.parts)) {
      const line = lines.get(id);
      if (!line || count <= 0) continue;
      // Nomes só vão para a peça quando o pedido tem um único tipo de peça personalizada.
      const names = line.personalizado && personalized.length === 1 ? order.nameValidation.names : [];
      const job: PrintJob = { orderNumber: order.orderNumber, displayId: order.displayId, livePriority: order.livePriority, liveHours: order.liveHours, count, names };
      if (decision.status === 'pode_enviar') { line.agora += count; line.jobs.push(job); }
      else { line.aguardando += count; line.bloqueados.push({ ...job, names: [], motivo: decision.motivo }); }
    }
  }
  return { lines: [...lines.values()], unmapped: view.unmapped };
}

export type PackingCard = ProductionOrder & { decision: Decision };

/**
 * Bancada de embalagem: quem vai primeiro é o pedido liberado com o prazo mais curto.
 * Pedidos travados aparecem à parte, com o motivo, para ninguém mandar por engano.
 */
export function buildPackingQueue(queue: Queue, map: ComponentMap, now: number) {
  const view = buildProductionView(queue, map, now);
  const cards: PackingCard[] = view.orders.map(order => ({ ...order, decision: shippingDecision(order) }));
  const liberados = cards.filter(c => c.decision.status === 'pode_enviar');
  const travados = cards.filter(c => c.decision.status === 'nao_enviar' || c.decision.status === 'revisar');
  const embalados = cards.filter(c => c.decision.status === 'ja_embalado');
  return { proximo: liberados[0] ?? null, fila: liberados.slice(1), travados, embalados: embalados.length };
}

/** Decisão para pedidos achados no bipar; pedidos não natalinos não recebem decisão. */
export function decisionsFor(queue: Queue, map: ComponentMap, now: number): Map<string, Decision> {
  const view = buildProductionView(queue, map, now);
  return new Map(view.orders.map(order => [`${order.platform ?? ''}|${order.account ?? ''}|${order.orderNumber}`, shippingDecision(order)]));
}
