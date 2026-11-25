import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Queue } from '../../collector/src/notifications.js';
import { readJson, writeJson } from '../../collector/src/health-files.js';
import { isConsumable, type ComponentMap } from './component-map.js';
import { cleanDeviceName, deviceIdPattern, serialize, type Device, type PackedMap } from './packing-store.js';
import { packingCards, type PackingCard } from './workflow.js';

/**
 * Etapas de produção, antes do Embalar (definidas com o Marcos):
 *   mão Grinch (personalizada): Imprimir → Criar nomes 3D → Colar nomes
 *   biscoito / elfo:            Imprimir → Separar
 * Cordão (consumível) não tem etapa. O registro fica em PACKING_DIR, nunca no UpSeller.
 */
export const stageInfo = {
  imprimir: { nome: 'Imprimir', icone: '🖨️', verbo: 'impressas', acao: 'Marcar como impressas' },
  nomes: { nome: 'Criar nomes 3D', icone: '✏️', verbo: 'com nomes criados', acao: 'Marcar nomes criados' },
  colar: { nome: 'Colar nomes', icone: '🧴', verbo: 'com nomes colados', acao: 'Marcar nomes colados' },
  separar: { nome: 'Separar', icone: '🧺', verbo: 'separadas', acao: 'Marcar como separadas' },
} as const;
export type StageId = keyof typeof stageInfo;
export const stageIds = Object.keys(stageInfo) as StageId[];

export function stagesFor(map: ComponentMap, componentId: string): StageId[] {
  if (!Object.hasOwn(map.componentes, componentId) || isConsumable(map, componentId)) return [];
  return map.componentes[componentId]!.personalizado ? ['imprimir', 'nomes', 'colar'] : ['imprimir', 'separar'];
}

// ---------- registro ----------
const FILE = 'producao.json';
const HISTORY = 'producao-historico.jsonl';
const KEEP_DAYS = 30;
/** Quantas etapas cada peça (pedido + tipo de peça) já cumpriu. */
export type StageState = Map<string, { feitas: number; em: string }>;
export const pieceKey = (orderKey: string, componentId: string) => `${orderKey}#${componentId}`;
const pieceKeyPattern = /^[^\x00-\x1f\x7f#]{3,200}#[a-z0-9_]{1,40}$/;

export async function loadStages(dir: string): Promise<StageState> {
  const json = await readJson(dir, FILE) as { pecas?: Record<string, unknown> } | null;
  const state: StageState = new Map();
  const pecas = json && typeof json === 'object' && json.pecas && typeof json.pecas === 'object' ? json.pecas : {};
  for (const [key, value] of Object.entries(pecas)) {
    const v = value as { feitas?: unknown; em?: unknown } | null;
    if (!pieceKeyPattern.test(key) || !v || !Number.isInteger(v.feitas) || (v.feitas as number) < 0 || (v.feitas as number) > 10
      || typeof v.em !== 'string' || !Number.isFinite(Date.parse(v.em))) continue;
    state.set(key, { feitas: v.feitas as number, em: v.em });
  }
  return state;
}

export type StageEvent = { em: string; acao: 'feito' | 'voltou'; etapa: StageId; pedido: string; peca: string; quantidade: number; nomes?: string[]; dispositivo?: Device };
export type StageChange = { piece: string; etapa: StageId; pedido: string; peca: string; quantidade: number; nomes?: string[] };

/**
 * Avança (ou volta) peças uma etapa. Só aplica se a peça ainda estiver exatamente
 * na etapa esperada — dois celulares marcando a mesma peça não pulam etapa.
 */
export function applyStages(dir: string, changes: { change: StageChange; from: number; to: number }[], now: number, device: Device) {
  if (!deviceIdPattern.test(device.id)) return Promise.reject(new Error('DEVICE_ID_INVALID'));
  return serialize(dir, async () => {
    const state = await loadStages(dir);
    const applied: StageChange[] = [];
    const lines: string[] = [];
    for (const { change, from, to } of changes) {
      if (!pieceKeyPattern.test(change.piece)) continue;
      if ((state.get(change.piece)?.feitas ?? 0) !== from) continue;
      state.set(change.piece, { feitas: to, em: new Date(now).toISOString() });
      applied.push(change);
      const event: StageEvent = { em: new Date(now).toISOString(), acao: to > from ? 'feito' : 'voltou', etapa: change.etapa, pedido: change.pedido, peca: change.peca,
        quantidade: change.quantidade, ...(change.nomes?.length ? { nomes: change.nomes } : {}), dispositivo: device };
      lines.push(JSON.stringify(event));
    }
    if (!applied.length) return applied;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(join(dir, HISTORY), lines.join('\n') + '\n', { mode: 0o600 });
    for (const [key, v] of state) if (now - Date.parse(v.em) > KEEP_DAYS * 86400000) state.delete(key);
    await writeJson(dir, FILE, { versao: 1, pecas: Object.fromEntries(state) });
    return applied;
  });
}

export async function loadStageHistory(dir: string, limit = 300): Promise<StageEvent[]> {
  let raw = '';
  try { raw = await readFile(join(dir, HISTORY), 'utf8'); } catch { return []; }
  const out: StageEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as StageEvent;
      if (typeof e.em !== 'string' || !Number.isFinite(Date.parse(e.em)) || !(e.acao === 'feito' || e.acao === 'voltou') || !stageIds.includes(e.etapa)
        || typeof e.pedido !== 'string' || typeof e.peca !== 'string' || !Number.isInteger(e.quantidade)) continue;
      const d = e.dispositivo && deviceIdPattern.test(e.dispositivo.id) ? { id: e.dispositivo.id, ...(cleanDeviceName(e.dispositivo.nome) ? { nome: cleanDeviceName(e.dispositivo.nome) } : {}) } : undefined;
      out.push({ ...e, nomes: Array.isArray(e.nomes) ? e.nomes.filter(n => typeof n === 'string') : undefined, dispositivo: d });
    } catch { /* linha incompleta */ }
  }
  return out.reverse().slice(0, limit);
}

// ---------- quadro ----------
export type Piece = {
  piece: string; card: PackingCard; componentId: string; nome: string; quantidade: number; nomes: string[];
  etapas: StageId[]; feitas: number; proxima: StageId | null; foto: string | null;
  /** O pedido só tem esta peça para produzir (a foto do anúncio mostra exatamente ela). */
  unica: boolean;
};

/**
 * Quadro de produção: cada peça liberada (pedido + tipo de peça) na sua próxima etapa,
 * do prazo mais curto para o mais longo. Pedido pronto = todas as peças sem etapa pendente.
 */
export function buildStageBoard(queue: Queue, map: ComponentMap, now: number, state: StageState, packed: PackedMap = new Map()) {
  const cards = packingCards(queue, map, now, packed);
  const pieces: Piece[] = [];
  const prontos: PackingCard[] = [];
  const emProducao: PackingCard[] = [];
  for (const card of cards) {
    if (card.decision.status !== 'pode_enviar') continue;
    const personalized = Object.entries(card.parts).filter(([id, n]) => n > 0 && map.componentes[id]?.personalizado);
    const foto = card.items.find(i => i.productImg)?.productImg ?? null;
    const own: Piece[] = [];
    for (const [componentId, quantidade] of Object.entries(card.parts)) {
      const etapas = stagesFor(map, componentId);
      if (quantidade <= 0 || !etapas.length) continue;
      const piece = pieceKey(card.key, componentId);
      const feitas = Math.min(state.get(piece)?.feitas ?? 0, etapas.length);
      const nomes = map.componentes[componentId]!.personalizado && personalized.length === 1 ? card.nameValidation.names : [];
      own.push({ piece, card, componentId, nome: map.componentes[componentId]!.nome, quantidade, nomes, etapas, feitas, proxima: etapas[feitas] ?? null, foto, unica: false });
    }
    if (!own.length) continue;
    if (own.length === 1) own[0]!.unica = true;
    pieces.push(...own);
    (own.every(p => p.proxima === null) ? prontos : emProducao).push(card);
  }
  const byStage = Object.fromEntries(stageIds.map(s => [s, pieces.filter(p => p.proxima === s)])) as Record<StageId, Piece[]>;
  const travados = cards.filter(c => c.decision.status === 'nao_enviar' || c.decision.status === 'revisar');
  return { byStage, pieces, prontos, emProducao, travados };
}

/** Situação de produção de um pedido, para o Embalar. */
export function productionStatus(card: Pick<PackingCard, 'key' | 'parts'>, map: ComponentMap, state: StageState) {
  const pendentes: string[] = [];
  for (const [componentId, quantidade] of Object.entries(card.parts)) {
    const etapas = stagesFor(map, componentId);
    if (quantidade <= 0 || !etapas.length) continue;
    const feitas = state.get(pieceKey(card.key, componentId))?.feitas ?? 0;
    if (feitas < etapas.length) pendentes.push(`${map.componentes[componentId]!.nome}: falta ${stageInfo[etapas[feitas]!].nome.toLowerCase()}`);
  }
  return { pronto: pendentes.length === 0, pendentes };
}
