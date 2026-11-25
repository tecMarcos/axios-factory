import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { readJson, writeJson } from '../../collector/src/health-files.js';

/**
 * Registro local de "pedido embalado" feito na bancada do painel.
 * Fica numa pasta própria (PACKING_DIR), nunca na pasta de dados do coletor,
 * e nunca é enviado ao UpSeller.
 */
export type Device = { id: string; nome?: string };
/**
 * Tempo de embalagem: da abertura do pedido (bipar ou escolher na lista) até salvar como embalado.
 * Não aparece para quem embala; serve de dado. Rápido demais = não seguiu o processo (alerta);
 * longo demais = bipou e saiu (fica registrado, mas fora da média).
 */
export const PACK_TIME = { rapidoSeg: 20, foraSeg: 15 * 60 } as const;
export type PackTime = { segundos: number; status: 'rapido' | 'normal' | 'fora' };
export function classifyPackTime(segundos: number): PackTime {
  const s = Math.max(0, Math.round(segundos));
  return { segundos: s, status: s < PACK_TIME.rapidoSeg ? 'rapido' : s > PACK_TIME.foraSeg ? 'fora' : 'normal' };
}
function validTime(t: unknown): PackTime | undefined {
  const v = t as Partial<PackTime> | null | undefined;
  return v && Number.isInteger(v.segundos) && (v.segundos as number) >= 0 && (v.status === 'rapido' || v.status === 'normal' || v.status === 'fora')
    ? { segundos: v.segundos as number, status: v.status } : undefined;
}
export type PackRecord = { embaladoEm: string; conferido: string[]; dispositivo?: Device; tempo?: PackTime };

export const deviceIdPattern = /^[A-Z2-9]{8}$/;
/** Nome livre do aparelho/pessoa: sem controles, espaços normalizados, até 30 caracteres. */
export function cleanDeviceName(value: string | null | undefined): string {
  return (value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
}
export type PackedMap = Map<string, PackRecord>;

const FILE = 'embalagem.json';
/** Histórico permanente: uma linha por evento, só acrescenta, nunca apaga. */
const HISTORY = 'embalagem-historico.jsonl';
const KEEP_DAYS = 30;
const keyPattern = /^[^\x00-\x1f\x7f]{3,200}$/;

export const orderKey = (o: { platform?: string | null; account?: string | null; orderNumber: string }) =>
  `${o.platform ?? ''}|${o.account ?? ''}|${o.orderNumber}`;

export function validPackingDir(value: string | undefined): string {
  const dir = value?.trim() ?? '';
  if (!dir || !isAbsolute(dir)) throw new Error('PACKING_DIR_INVALID');
  return dir;
}

function parse(json: unknown): PackedMap {
  const map: PackedMap = new Map();
  const pedidos = json && typeof json === 'object' && !Array.isArray(json) ? (json as { pedidos?: unknown }).pedidos : null;
  if (!pedidos || typeof pedidos !== 'object' || Array.isArray(pedidos)) return map;
  for (const [key, value] of Object.entries(pedidos)) {
    const r = value as Partial<PackRecord> | null;
    if (!keyPattern.test(key) || !r || typeof r.embaladoEm !== 'string' || !Number.isFinite(Date.parse(r.embaladoEm))
      || !Array.isArray(r.conferido) || !r.conferido.every(c => typeof c === 'string')) continue;
    const d = r.dispositivo as Partial<Device> | undefined;
    const dispositivo = d && typeof d.id === 'string' && deviceIdPattern.test(d.id)
      ? { id: d.id, ...(typeof d.nome === 'string' && cleanDeviceName(d.nome) ? { nome: cleanDeviceName(d.nome) } : {}) } : undefined;
    const tempo = validTime(r.tempo);
    map.set(key, { embaladoEm: r.embaladoEm, conferido: r.conferido, ...(dispositivo ? { dispositivo } : {}), ...(tempo ? { tempo } : {}) });
  }
  return map;
}

export async function loadPacked(dir: string): Promise<PackedMap> {
  return parse(await readJson(dir, FILE));
}

// Um painel só grava neste arquivo; a fila garante uma escrita por vez.
const chains = new Map<string, Promise<unknown>>();
export function serialize<T>(dir: string, action: () => Promise<T>): Promise<T> {
  const run = (chains.get(dir) ?? Promise.resolve()).catch(() => {}).then(action);
  chains.set(dir, run);
  return run;
}

async function save(dir: string, now: number, map: PackedMap, change: (map: PackedMap) => void) {
  change(map);
  // Só o estado "embalado agora" é limpo; o histórico (embalagem-historico.jsonl) fica para sempre.
  for (const [key, record] of map) if (now - Date.parse(record.embaladoEm) > KEEP_DAYS * 86400000) map.delete(key);
  await writeJson(dir, FILE, { versao: 1, pedidos: Object.fromEntries(map) });
  return map;
}

export type HistoryEvent = {
  em: string; acao: 'embalado' | 'desfeito'; key: string; pedido: string; itens: string[]; conferido?: string[]; dispositivo?: Device; tempo?: PackTime;
};
/** O que o histórico guarda do pedido, para continuar legível depois que ele sai da fila. */
export type OrderInfo = { pedido: string; itens: string[] };

async function appendHistory(dir: string, event: HistoryEvent) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await appendFile(join(dir, HISTORY), JSON.stringify(event) + '\n', { mode: 0o600 });
}

export async function markPacked(dir: string, key: string, conferido: string[], now: number, dispositivo?: Device, info?: OrderInfo, tempo?: PackTime) {
  if (!keyPattern.test(key)) throw new Error('PACK_KEY_INVALID');
  if (dispositivo && !deviceIdPattern.test(dispositivo.id)) throw new Error('DEVICE_ID_INVALID');
  return serialize(dir, async () => {
    const map = await loadPacked(dir);
    if (map.has(key)) return map;
    // Histórico primeiro: se gravar o estado falhar depois, o evento já está registrado.
    await appendHistory(dir, { em: new Date(now).toISOString(), acao: 'embalado', key, pedido: info?.pedido ?? key, itens: info?.itens ?? [], conferido, ...(dispositivo ? { dispositivo } : {}), ...(tempo ? { tempo } : {}) });
    return save(dir, now, map, m => m.set(key, { embaladoEm: new Date(now).toISOString(), conferido, ...(dispositivo ? { dispositivo } : {}), ...(tempo ? { tempo } : {}) }));
  });
}

export function unmarkPacked(dir: string, key: string, now: number, dispositivo?: Device, info?: OrderInfo) {
  return serialize(dir, async () => {
    const map = await loadPacked(dir);
    if (!map.has(key)) return map;
    await appendHistory(dir, { em: new Date(now).toISOString(), acao: 'desfeito', key, pedido: info?.pedido ?? key, itens: info?.itens ?? [], ...(dispositivo ? { dispositivo } : {}) });
    return save(dir, now, map, m => { m.delete(key); });
  });
}

function validEvent(e: unknown): e is HistoryEvent {
  const v = e as Partial<HistoryEvent> | null;
  return !!v && typeof v.em === 'string' && Number.isFinite(Date.parse(v.em)) && (v.acao === 'embalado' || v.acao === 'desfeito')
    && typeof v.key === 'string' && typeof v.pedido === 'string' && Array.isArray(v.itens) && v.itens.every(i => typeof i === 'string')
    && (v.dispositivo === undefined || (typeof v.dispositivo?.id === 'string' && deviceIdPattern.test(v.dispositivo.id)));
}

/** Eventos do histórico, do mais novo para o mais antigo. Linhas estragadas são ignoradas. */
export async function loadHistory(dir: string, limit = 500): Promise<HistoryEvent[]> {
  let raw = '';
  try { raw = await readFile(join(dir, HISTORY), 'utf8'); } catch { return []; }
  const events: HistoryEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as HistoryEvent;
      if (validEvent(e)) events.push({ ...e, tempo: validTime(e.tempo), ...(e.dispositivo ? { dispositivo: { id: e.dispositivo.id, ...(cleanDeviceName(e.dispositivo.nome) ? { nome: cleanDeviceName(e.dispositivo.nome) } : {}) } } : {}) });
    } catch { /* linha incompleta */ }
  }
  return events.reverse().slice(0, limit);
}
