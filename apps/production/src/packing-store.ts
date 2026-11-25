import { isAbsolute } from 'node:path';
import { readJson, writeJson } from '../../collector/src/health-files.js';

/**
 * Registro local de "pedido embalado" feito na bancada do painel.
 * Fica numa pasta própria (PACKING_DIR), nunca na pasta de dados do coletor,
 * e nunca é enviado ao UpSeller.
 */
export type Device = { id: string; nome?: string };
export type PackRecord = { embaladoEm: string; conferido: string[]; dispositivo?: Device };

export const deviceIdPattern = /^[A-Z2-9]{8}$/;
/** Nome livre do aparelho/pessoa: sem controles, espaços normalizados, até 30 caracteres. */
export function cleanDeviceName(value: string | null | undefined): string {
  return (value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
}
export type PackedMap = Map<string, PackRecord>;

const FILE = 'embalagem.json';
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
    map.set(key, { embaladoEm: r.embaladoEm, conferido: r.conferido, ...(dispositivo ? { dispositivo } : {}) });
  }
  return map;
}

export async function loadPacked(dir: string): Promise<PackedMap> {
  return parse(await readJson(dir, FILE));
}

// Um painel só grava neste arquivo; a fila garante uma escrita por vez.
const chains = new Map<string, Promise<unknown>>();
function serialize<T>(dir: string, action: () => Promise<T>): Promise<T> {
  const run = (chains.get(dir) ?? Promise.resolve()).catch(() => {}).then(action);
  chains.set(dir, run);
  return run;
}

async function update(dir: string, now: number, change: (map: PackedMap) => void) {
  return serialize(dir, async () => {
    const map = await loadPacked(dir);
    change(map);
    for (const [key, record] of map) if (now - Date.parse(record.embaladoEm) > KEEP_DAYS * 86400000) map.delete(key);
    await writeJson(dir, FILE, { versao: 1, pedidos: Object.fromEntries(map) });
    return map;
  });
}

export async function markPacked(dir: string, key: string, conferido: string[], now: number, dispositivo?: Device) {
  if (!keyPattern.test(key)) throw new Error('PACK_KEY_INVALID');
  if (dispositivo && !deviceIdPattern.test(dispositivo.id)) throw new Error('DEVICE_ID_INVALID');
  return update(dir, now, map => { if (!map.has(key)) map.set(key, { embaladoEm: new Date(now).toISOString(), conferido, ...(dispositivo ? { dispositivo } : {}) }); });
}

export function unmarkPacked(dir: string, key: string, now: number) {
  return update(dir, now, map => { map.delete(key); });
}
