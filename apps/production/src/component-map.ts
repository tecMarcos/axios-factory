import { readFileSync } from 'node:fs';
import type { QueueOrder } from '../../collector/src/orders-view.js';

type Parts = Record<string, number>;
type Variant = {
  productId: string; anuncio: string; variante: string; componentes: Parts;
  confirmado: boolean; pendencia?: string; fonte?: string;
};
export type ComponentMap = {
  versao: number;
  componentes: Record<string, { nome: string; personalizado: boolean }>;
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
  const components = json.componentes;
  for (const [id, component] of Object.entries(components)) {
    if (!nonblank(id) || !record(component) || !nonblank(component.nome) || typeof component.personalizado !== 'boolean') return invalid();
  }
  for (const [id, variant] of Object.entries(json.variantes)) {
    if (!nonblank(id) || !record(variant) || !nonblank(variant.productId) || !nonblank(variant.anuncio)
      || typeof variant.variante !== 'string' || typeof variant.confirmado !== 'boolean' || !record(variant.componentes)
      || (variant.pendencia !== undefined && typeof variant.pendencia !== 'string')
      || (variant.fonte !== undefined && typeof variant.fonte !== 'string')) return invalid();
    const parts = Object.entries(variant.componentes);
    if (!parts.length || parts.some(([part, count]) => !Object.hasOwn(components, part) || !positiveInteger(count))) return invalid();
  }
  return json as ComponentMap;
}

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

export function guessFromText(name: string, attr: string | null): Parts | null {
  const variant = fold(attr ?? ''), listing = fold(name);
  for (const text of [variant, listing]) {
    if (/\bcoracao\b/.test(text)) return { mao_coracao: unitCount(variant) ?? 1 };
    if (/\bmisto\b/.test(text)) return { biscoito: 2, elfo: 2 };
    if (/\b4\s*bisc(?:oit|ot)/.test(text)) return { biscoito: 4 };
    if (/\b4\s*elfo/.test(text)) return { elfo: 4 };
    const count = unitCount(variant) ?? unitCount(listing);
    if (count && /\bbolinhas?\b/.test(text)) return { mao_bolinha: count };
  }
  return null;
}

type Resolution =
  | { kind: 'mapped'; entry: Variant; parts: Parts; expectedNames: number; confirmed: boolean; attrChanged: boolean }
  | { kind: 'unmapped_christmas'; guess: Parts | null; reason?: string }
  | { kind: 'other' };

export function resolveItem(item: QueueOrder['items'][number], map: ComponentMap): Resolution {
  const entry = item.variationId && item.variationId !== '0' && Object.hasOwn(map.variantes, item.variationId) ? map.variantes[item.variationId] : undefined;
  const attr = fold(item.productAttr ?? '');
  if (entry && entry.productId === item.productId) {
    const parts = Object.fromEntries(Object.entries(entry.componentes).map(([id, count]) => [id, count * item.quantity]));
    const expectedNames = Object.entries(parts).reduce((total, [id, count]) => total + (map.componentes[id]!.personalizado ? count : 0), 0);
    return { kind: 'mapped', entry, parts, expectedNames, confirmed: entry.confirmado, attrChanged: attr !== fold(entry.variante) };
  }
  if (entry) {
    return { kind: 'unmapped_christmas', guess: guessFromText(item.productName, item.productAttr), reason: 'productId diferente do mapa' };
  }
  const name = fold(item.productName);
  if (map.deteccaoNatal.some(keyword => {
    const literal = fold(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${literal}s?\\b`);
    return pattern.test(name) || pattern.test(attr);
  })) {
    return { kind: 'unmapped_christmas', guess: guessFromText(item.productName, item.productAttr) };
  }
  return { kind: 'other' };
}
