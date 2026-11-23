import { readFileSync } from 'node:fs';
import type { QueueOrder } from '../../collector/src/orders-view.js';

type Parts = Record<string, number>;
type Variant = {
  productId: string; anuncio: string; variante: string; componentes: Parts;
  confirmado: boolean; pendencia?: string; fonte?: string; regra?: string;
};
export type ComponentMap = {
  versao: number;
  componentes: Record<string, { nome: string; personalizado: boolean; consumivel?: boolean }>;
  deteccaoNatal: string[];
  variantes: Record<string, Variant>;
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const positiveInteger = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const invalid = (): never => { throw new Error('COMPONENT_MAP_INVALID'); };

export function validateComponentMap(json: unknown): ComponentMap {
  if (!record(json) || !positiveInteger(json.versao) || !record(json.componentes) || !record(json.variantes)
    || !Array.isArray(json.deteccaoNatal) || !json.deteccaoNatal.every(k => nonblank(k) && fold(k))) return invalid();
  const map = json as ComponentMap;
  const components = json.componentes;
  for (const [id, component] of Object.entries(components)) {
    if (!nonblank(id) || !record(component) || !nonblank(component.nome) || typeof component.personalizado !== 'boolean'
      || (component.consumivel !== undefined && typeof component.consumivel !== 'boolean')
      || (component.consumivel === true && component.personalizado)) return invalid();
  }
  for (const [id, variant] of Object.entries(json.variantes)) {
    if (!nonblank(id) || !record(variant) || !nonblank(variant.productId) || !nonblank(variant.anuncio)
      || typeof variant.variante !== 'string' || typeof variant.confirmado !== 'boolean' || !record(variant.componentes)
      || (variant.pendencia !== undefined && typeof variant.pendencia !== 'string')
      || (variant.fonte !== undefined && typeof variant.fonte !== 'string')
      || (variant.regra !== undefined && typeof variant.regra !== 'string')) return invalid();
    const parts = Object.entries(variant.componentes);
    if (!parts.length || parts.some(([part, count]) => !Object.hasOwn(components, part) || !positiveInteger(count))) return invalid();
    if (Object.hasOwn(components, 'cordao_vermelho')) {
      const printed = parts.reduce((sum, [part, count]) => sum + (isConsumable(map, part) ? 0 : Number(count)), 0);
      if (!Object.hasOwn(variant.componentes, 'cordao_vermelho') || variant.componentes.cordao_vermelho !== printed) return invalid();
    }
  }
  return map;
}

export const isConsumable = (map: ComponentMap, id: string) =>
  Object.hasOwn(map.componentes, id) && map.componentes[id]!.consumivel === true;

export const defaultComponentMapPath = new URL('../../../config/central-producao/componentes.json', import.meta.url);
export function loadComponentMap(path = process.env.COMPONENT_MAP_PATH ?? defaultComponentMapPath) {
  try { return validateComponentMap(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return invalid(); }
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

function unitCount(text: string) {
  const count = Number(/\b(\d+)\s*un(?:idades?)?\b/.exec(text)?.[1]);
  return positiveInteger(count) ? count : null;
}

export const handComponents = ['mao_coracao', 'mao_bolinha'] as const;
export type HandType = typeof handComponents[number];
export type HandRule = { type: HandType | null; ambiguous: boolean; label: string };

/**
 * Marcos's rule (23/11): the listing title tells the hands apart.
 * "Kit 4 Bolinha" (singular) = Mão Grinch CORAÇÃO; "Kit com 4 bolinhas" (plural) = Mão Grinch BOLINHA.
 * A title with both forms is ambiguous; a title with neither has no hand rule.
 */
export function handTypeFromTitle(title: string | null | undefined): HandRule {
  const t = fold(title ?? '');
  const singular = /\bbolinha\b/.test(t), plural = /\bbolinhas\b/.test(t);
  if (singular && plural) return { type: null, ambiguous: true, label: 'título com "bolinha" e "bolinhas": ambíguo' };
  if (singular) return { type: 'mao_coracao', ambiguous: false, label: '"bolinha" no singular → mão coração' };
  if (plural) return { type: 'mao_bolinha', ambiguous: false, label: '"bolinhas" no plural → mão bolinha' };
  return { type: null, ambiguous: false, label: 'sem regra de mão no título' };
}

export function guessFromText(name: string, attr: string | null, map?: ComponentMap): Parts | null {
  const withCord = (parts: Parts) => map && Object.hasOwn(map.componentes, 'cordao_vermelho')
    ? { ...parts, cordao_vermelho: Object.values(parts).reduce((sum, count) => sum + count, 0) } : parts;
  const variant = fold(attr ?? ''), listing = fold(name);
  const hand = handTypeFromTitle(name);
  // Units always come from the variation ("6 unidades"), never from the "Kit 4" in the title.
  const units = unitCount(variant);
  if (hand.ambiguous) return null;
  if (hand.type) return units ? withCord({ [hand.type]: units }) : null;
  for (const text of [variant, listing]) {
    if (/\bmisto\b/.test(text)) return withCord({ biscoito: 2, elfo: 2 });
    if (/\b4\s*bisc(?:oit|ot)/.test(text)) return withCord({ biscoito: 4 });
    if (/\b4\s*elfo/.test(text)) return withCord({ elfo: 4 });
  }
  return null;
}

type Resolution =
  | { kind: 'mapped'; entry: Variant; parts: Parts; expectedNames: number; confirmed: boolean; attrChanged: boolean; hand: HandRule | null; titleMismatch: boolean }
  | { kind: 'unmapped_christmas'; guess: Parts | null; reason?: string }
  | { kind: 'other' };

export function resolveItem(item: QueueOrder['items'][number], map: ComponentMap): Resolution {
  const entry = item.variationId && item.variationId !== '0' && Object.hasOwn(map.variantes, item.variationId) ? map.variantes[item.variationId] : undefined;
  const attr = fold(item.productAttr ?? '');
  if (entry && entry.productId === item.productId) {
    const parts = Object.fromEntries(Object.entries(entry.componentes).map(([id, count]) => [id, count * item.quantity]));
    const expectedNames = Object.entries(parts).reduce((total, [id, count]) => total + (map.componentes[id]!.personalizado ? count : 0), 0);
    // Re-check hand entries against the CURRENT listing title on every read, so a renamed listing
    // (or a map edited by hand) can never silently count the wrong hand.
    const mappedHands = handComponents.filter(h => Object.hasOwn(entry.componentes, h));
    const hand = mappedHands.length ? handTypeFromTitle(item.productName) : null;
    const titleMismatch = !!hand && (mappedHands.length !== 1 || hand.type !== mappedHands[0]);
    return { kind: 'mapped', entry, parts, expectedNames, confirmed: entry.confirmado, attrChanged: attr !== fold(entry.variante), hand, titleMismatch };
  }
  if (entry) {
    return { kind: 'unmapped_christmas', guess: guessFromText(item.productName, item.productAttr, map), reason: 'productId diferente do mapa' };
  }
  const name = fold(item.productName);
  if (map.deteccaoNatal.some(keyword => {
    const literal = fold(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${literal}s?\\b`);
    return pattern.test(name) || pattern.test(attr);
  })) {
    return { kind: 'unmapped_christmas', guess: guessFromText(item.productName, item.productAttr, map) };
  }
  return { kind: 'other' };
}
