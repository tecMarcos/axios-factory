import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateHoursRemaining, calculatePriority, defaultTimezone, validateTimezone } from '../../collector/src/operational.js';
import { readSnapshot } from '../../collector/src/snapshot.js';
import { evaluateAlerts, healthConfigFromEnv, sessionAgeDays, type HealthConfig } from '../../collector/src/health-alerts.js';
import { readHealth, type Health } from '../../collector/src/health.js';
import { emptyNotifyHealth, readNotifyHealth, type NotifyHealth } from '../../collector/src/notify-health.js';
import { renderHealth } from './render-health.js';
import { parseKeywords } from '../../collector/src/orders-view.js';
import { validScanSecret } from '../../collector/src/scan-keys.js';
import { defaultComponentMapPath, loadComponentMap, type ComponentMap } from '../../production/src/component-map.js';
import { loadSyncHistory, type History } from '../../production/src/sync-health.js';
import { renderProduction } from './render-production.js';
import { renderPacking, renderPrintQueue } from './render-workflow.js';
import { decisionsFor, orderLines, packingCards, packingChecklist } from '../../production/src/workflow.js';
import { classifyPackTime, cleanDeviceName, deviceIdPattern, loadHistory, loadPacked, markPacked, orderKey, unmarkPacked, validPackingDir, type Device, type PackedMap } from '../../production/src/packing-store.js';
import { renderPackingDone, renderPackingScan } from './render-workflow.js';
import { createPackTimer } from './pack-timer.js';
import { claimOrder, liveState, releaseOrder, type Working } from './live.js';
import { buildPackingQueue } from '../../production/src/workflow.js';
import { renderStageBoard, renderStageDone } from './render-stages.js';
import { applyStages, buildStageBoard, loadStageHistory, loadStages, stageIds, stageInfo, type Piece, type StageId } from '../../production/src/stages.js';
import { healthCss } from './render.js';
import { renderPanel } from './render.js';
import { findOrders, renderScanPage, renderScanResult, scannerWidget } from './scan.js';

type HealthReader<T> = (dir: string) => Promise<T | null> | T | null;
const readMonitor = <T>(dir: string, read: HealthReader<T>) => Promise.resolve().then(() => read(dir)).catch(() => null);

export type PanelConfig = { token: string; dataDir: string; timezone: string; keywords: string[]; scanSecret?: string; now?: () => number; scannerLibPath?: string; health?: { config: Partial<HealthConfig>; readHealth?: HealthReader<Health>; readNotify?: HealthReader<NotifyHealth> }; production?: { map: ComponentMap; historyLoader?: (dataDir: string) => Promise<History[]>; envLabel?: string; filas?: boolean; embalagem?: { dir: string }; etapas?: boolean } };

export async function loadSnapshot(dir: string) { return (await readSnapshot(dir)).queue; }

export const defaultScannerLib = fileURLToPath(new URL('../../../node_modules/@zxing/library/umd/index.min.js', import.meta.url));

const digest = (s: string) => createHash('sha256').update(s).digest();
const baseHeaders = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};
const csp = (nonce: string) => `default-src 'none'; img-src https:; media-src 'self' blob: mediastream:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  res.writeHead(status, { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}
// no-store: o celular nunca mostra uma cópia velha guardada (ex.: ao voltar para a aba ou apertar "voltar").
const html = (res: ServerResponse, body: string, nonce: string, status = 200, extra: Record<string, string> = {}) => send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp(nonce), 'Cache-Control': 'no-store', ...extra });

// Aparelho da bancada: um ID único por celular (cookie só deste painel) + nome opcional.
const DEVICE_COOKIE = 'axf_dev';
const deviceAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newDeviceId = () => Array.from({ length: 8 }, () => deviceAlphabet[randomInt(deviceAlphabet.length)]).join('');
function readDevice(req: IncomingMessage): Device | null {
  const raw = (req.headers.cookie ?? '').split(';').map(c => c.trim()).find(c => c.startsWith(`${DEVICE_COOKIE}=`))?.slice(DEVICE_COOKIE.length + 1) ?? '';
  const [id = '', encoded = ''] = raw.split('~');
  if (!deviceIdPattern.test(id)) return null;
  let nome = '';
  try { nome = cleanDeviceName(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { nome = ''; }
  return nome ? { id, nome } : { id };
}
const deviceCookie = (device: Device, path: string, secure: boolean) =>
  `${DEVICE_COOKIE}=${device.id}~${Buffer.from(device.nome ?? '', 'utf8').toString('base64url')}; Path=${path}; Max-Age=31536000; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

async function readForm(req: IncomingMessage, limit = 4096): Promise<URLSearchParams> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) throw new Error('BAD_FORM');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += (chunk as Buffer).length; if (size > limit) throw new Error('BAD_FORM'); chunks.push(chunk as Buffer); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function createPanelHandler(config: PanelConfig) {
  if (config.token.length < 24 || !/^[A-Za-z0-9_-]+$/.test(config.token)) throw new Error('PANEL_TOKEN_INVALID');
  const expected = digest(config.token);
  const now = config.now ?? Date.now;
  const libPath = config.scannerLibPath ?? defaultScannerLib;
  const packTimer = createPackTimer();
  // Quem está com qual pedido aberto agora (só em memória; some ao embalar, ao abrir outro ou em 15 min).
  const working: Working = new Map();
  let lib: Promise<Buffer | null> | undefined;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://panel');
    const path = url.pathname;
    if (path === '/healthz') return send(res, 200, 'ok');
    const match = /^\/p\/([^/]+)(\/[a-z.-]*)?\/?$/.exec(path);
    // Constant-time comparison; any wrong or missing token looks exactly like an unknown page.
    if (!match || !timingSafeEqual(digest(match[1]!), expected)) return send(res, 404, 'Não encontrado');
    const base = `/p/${match[1]}`, sub = match[2] ?? '';
    const paths = { list: base, scan: `${base}/bipar`, lib: `${base}/leitor.js` };
    const filas = config.production?.filas === true;
    // Bancada com leitor e "pedido embalado": só com CENTRAL_EMBALAGEM=1 (exige as filas).
    const packingDir = filas ? config.production?.embalagem?.dir : undefined;
    const stationPaths = { confirm: `${base}/embalado`, undo: `${base}/desembalar` };
    const workflowLinks = { list: base, production: `${base}/producao`, print: `${base}/impressao`, packing: `${base}/embalar`, ...(packingDir ? {} : { scan: paths.scan }) };
    const stationPost = packingDir !== undefined && (sub === '/embalado' || sub === '/desembalar' || sub === '/aparelho');
    // Quadro de etapas da produção: só com CENTRAL_ETAPAS=1 (grava na mesma pasta da embalagem).
    const stagesDir = packingDir && config.production?.etapas ? packingDir : undefined;
    const stagePost = stagesDir !== undefined && (sub === '/etapa' || sub === '/etapa-voltar');
    const allowed = sub === '/bipar' || (sub === '/embalar' && packingDir) ? ['GET', 'HEAD', 'POST'] : stationPost || stagePost ? ['POST'] : ['GET', 'HEAD'];
    if (!['', '/bipar', '/leitor.js'].includes(sub) && !(sub === '/producao' && config.production) && !((sub === '/impressao' || sub === '/embalar') && filas) && !stationPost && !stagePost && !(sub === '/saude.json' && config.health) && !(sub === '/ao-vivo.json' && packingDir)) return send(res, 404, 'Não encontrado');
    if (!allowed.includes(req.method ?? '')) return send(res, 405, 'Método não permitido', { Allow: allowed.join(', ') });

    if (sub === '/leitor.js') {
      lib ??= readFile(libPath).catch(() => null);
      const body = await lib;
      return body ? send(res, 200, body, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, max-age=86400' }) : send(res, 404, 'Não encontrado');
    }
    const nonce = randomBytes(16).toString('base64');
    if (sub === '/bipar' && req.method !== 'POST') {
      const auto = url.searchParams.get('auto') === '1';
      return html(res, renderScanPage({ nonce, paths, auto }), nonce);
    }

    let scanned: string | undefined;
    let form: URLSearchParams | undefined;
    if (req.method === 'POST') {
      // Codes travel in the POST body so they never land in proxy access logs.
      try { form = await readForm(req, stagePost ? 65536 : 4096); } catch { return send(res, 400, 'Pedido inválido'); }
      if (sub === '/bipar') scanned = form.get('c')?.slice(0, 300) ?? '';
    }
    const queue = await loadSnapshot(config.dataDir).catch(() => null);
    if (!queue && sub !== '/saude.json') {
      console.error(JSON.stringify({ event: 'panel_snapshot_unavailable' }));
      return send(res, 503, 'Os dados dos pedidos ainda não estão disponíveis. Tente de novo em alguns minutos.', { 'Retry-After': '120' });
    }
    const t = now();
    /** Estado compartilhado entre celulares; a mesma conta serve a página e o /ao-vivo.json. */
    const live = (packed: PackedMap, me: string | null, stageState?: Awaited<ReturnType<typeof loadStages>>) => {
      const pq = buildPackingQueue(queue!, config.production!.map, t, packed, { all: true });
      const pending = pq.proximo ? [pq.proximo, ...pq.fila] : [];
      return liveState({ packed, working, now: t, me, timezone: config.timezone, fila: pending.map(c => c.key),
        contagem: { fila: pending.length, travados: pq.travados.length, embalados: pq.embaladosAqui.length + pq.aguardandoColeta.length },
        extra: stageState ? [...stageState].sort(([a], [b]) => a.localeCompare(b)) : undefined });
    };
    if (sub === '/ao-vivo.json' && packingDir && queue && config.production) {
      try {
        const [packed, stageState] = await Promise.all([loadPacked(packingDir), stagesDir ? loadStages(stagesDir) : Promise.resolve(undefined)]);
        return send(res, 200, JSON.stringify(live(packed, readDevice(req)?.id ?? null, stageState)), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      } catch { return send(res, 503, '{}', { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '10' }); }
    }
    let healthBar: string | undefined;
    if (config.health && scanned === undefined && !form) {
      const [health, notify] = await Promise.all([
        readMonitor(config.dataDir, config.health.readHealth ?? readHealth),
        readMonitor(config.dataDir, config.health.readNotify ?? readNotifyHealth),
      ]);
      const alerts = evaluateAlerts({ health, notify, queue, now: t, timezone: config.timezone, config: config.health.config });
      if (sub === '/saude.json') return send(res, 200, JSON.stringify({
        generatedAt: new Date(t).toISOString(), ok: alerts.length === 0, alerts,
        accounts: health?.accounts.map(({ name, ok, error, lastSuccessAt, consecutiveFailures, sessionStartedAt }) =>
          ({ name, ok, error, lastSuccessAt, consecutiveFailures, sessionAgeDays: sessionAgeDays(sessionStartedAt, t) })) ?? [],
        notify: (notify ?? emptyNotifyHealth()).channels, lastRunAt: health?.lastRunAt ?? null,
      }), { 'Content-Type': 'application/json; charset=utf-8' });
      healthBar = renderHealth(alerts, health?.lastRunAt ?? null, config.timezone, sub === '/producao' || sub === '/impressao' || sub === '/embalar');
    }
    if (!queue) return send(res, 404, 'Não encontrado');
    if (scanned !== undefined) {
      const matches = findOrders(queue, scanned, config.scanSecret, t);
      console.log(JSON.stringify({ event: 'panel_scan', matched: matches.length }));
      const packedNow = packingDir ? await loadPacked(packingDir).catch(() => undefined) : undefined;
      const decisions = filas && config.production ? decisionsFor({ ...queue, orders: matches }, config.production.map, t, packedNow) : undefined;
      return html(res, renderScanResult({ nonce, paths, scanned, matches, timezone: config.timezone, personalizationKeywords: config.keywords, decisions }), nonce);
    }
    if ((sub === '/impressao' || sub === '/embalar' || stationPost) && filas && config.production) {
      const { map } = config.production;
      let packed: PackedMap = new Map();
      if (packingDir) {
        try { packed = await loadPacked(packingDir); }
        catch { console.error(JSON.stringify({ event: 'packing_unavailable' })); return send(res, 503, 'Não consegui ler as embalagens. Tente de novo.', { 'Retry-After': '30' }); }
      }
      // Aparelho: lê o cookie; se não tem, cria um ID agora e devolve no Set-Cookie.
      let device = packingDir ? readDevice(req) : null;
      const hadDevice = device !== null;
      if (packingDir && !device) device = { id: newDeviceId() };
      if (packingDir && sub === '/aparelho' && form) device = { id: device!.id, ...(cleanDeviceName(form.get('n')) ? { nome: cleanDeviceName(form.get('n')) } : {}) };
      const cookieHeaders: Record<string, string> = packingDir && (!hadDevice || sub === '/aparelho')
        ? { 'Set-Cookie': deviceCookie(device!, `${base}/`, req.headers['x-forwarded-proto'] === 'https') } : {};
      const page = (body: string, status = 200) => html(res, body, nonce, status, cookieHeaders);
      const station = packingDir ? { ...stationPaths, device: device!, rename: `${base}/aparelho`, scanner: scannerWidget({ action: `${base}/embalar`, lib: paths.lib, auto: url.searchParams.get('auto') === '1' }),
        // Cronômetro oculto: só começa para quem já tem aparelho identificado (sem cookie não dá para salvar).
        ...(hadDevice ? { timer: (key: string) => packTimer.start(key, device!.id, t) } : {}),
        live: { url: `${base}/ao-vivo.json`, v: '' } } : undefined;
      const wantsHistory = !!packingDir && req.method === 'GET' && sub === '/embalar' && url.searchParams.get('ver') === 'historico';
      let history: Awaited<ReturnType<typeof loadHistory>> | undefined;
      if (wantsHistory) {
        try { history = await loadHistory(packingDir!, 2000); }
        catch { return send(res, 503, 'Não consegui ler o histórico. Tente de novo.', { 'Retry-After': '30' }); }
      }
      const options = { history, historyQuery: wantsHistory ? (url.searchParams.get('q') ?? '').slice(0, 60) : '', all: !!packingDir, view: req.method === 'GET' ? url.searchParams.get('ver') : null, now: t, nonce, links: workflowLinks, envLabel: config.production.envLabel, healthBar, healthCss, refreshSeconds: 120, timezone: config.timezone, packed, station };
      const nextHref = `${base}/embalar?auto=1`;
      if (station && sub === '/embalar' && form) {
        // Escolhido na lista (k) ou bipado (c).
        const picked = form.get('k')?.slice(0, 300);
        const matches = picked
          ? queue.orders.filter(order => orderKey(order) === picked).map(order => ({ ...order, livePriority: calculatePriority(order.deadlineEpoch, t), liveHours: calculateHoursRemaining(order.deadlineEpoch, t) }))
          : findOrders(queue, form.get('c')?.slice(0, 300) ?? '', config.scanSecret, t);
        console.log(JSON.stringify({ event: picked ? 'pack_pick' : 'pack_scan', matched: matches.length }));
        const cards = new Map(packingCards({ ...queue, orders: matches }, map, t, packed, { all: true }).map(c => [c.key, c]));
        // "Fulano está embalando": só para pedido liberado e aparelho identificado.
        const opened = [...cards.values()].filter(c => c.decision.status === 'pode_enviar');
        if (hadDevice) claimOrder(working, opened.length === 1 ? opened[0]!.key : null, device!, t);
        station.live!.v = live(packed, device!.id).v;
        return page(renderPackingScan(map, { fromList: !!picked, scanned: '', matches, cards, keyOf: orderKey, nextHref, personalizationKeywords: config.keywords }, { ...options, station }));
      }
      if (station && form && stationPost) {
        const done = (status: number, ok: boolean, title: string, detail?: string) =>
          page(renderPackingDone(options, { ok, title, detail, nextHref }), status);
        if (sub === '/aparelho') {
          console.log(JSON.stringify({ event: 'pack_device_named', device: device!.id }));
          return done(200, true, device!.nome ? `Este aparelho agora é "${device!.nome}"` : 'Nome do aparelho apagado', `ID do aparelho: ${device!.id}`);
        }
        // Sem cookie de aparelho não grava: assim todo "embalado" sabe quem foi.
        if (!hadDevice) return done(428, false, 'Aparelho sem identificação', 'Abra o Embalar de novo e repita. Se continuar, libere cookies para este site.');
        const key = form.get('k')?.slice(0, 300) ?? '';
        const card = packingCards(queue, map, t, packed, { all: true }).find(c => c.key === key);
        if (!card) return done(404, false, 'Pedido não encontrado na lista atual', 'Bipe a etiqueta de novo.');
        try {
          if (sub === '/desembalar') {
            if (!packed.has(key)) return done(409, false, 'Este pedido não estava marcado como embalado');
            await unmarkPacked(packingDir!, key, t, device!, { pedido: card.displayId, itens: orderLines(card, map) });
            console.log(JSON.stringify({ event: 'pack_undone', device: device!.id }));
            return done(200, true, `Embalagem desfeita: ${card.displayId}`, 'O pedido voltou para a fila.');
          }
          if (card.decision.status === 'ja_embalado') return done(409, false, `${card.displayId} já está embalado`);
          if (card.decision.status !== 'pode_enviar') return done(409, false, `⛔ Não embale ${card.displayId}`, card.decision.motivo);
          const answered = new Set(form.getAll('q'));
          const checks = packingChecklist(card, map, form.get('origem') === 'lista');
          const missing = checks.filter(q => !answered.has(q.id));
          if (missing.length) return done(422, false, 'Faltou responder "Sim"', missing.map(q => q.pergunta).join(' · '));
          const seconds = packTimer.elapsed(form.get('t0'), key, device!.id, t);
          const tempo = seconds === null ? undefined : classifyPackTime(seconds);
          await markPacked(packingDir!, key, checks.map(q => q.id), t, device!, { pedido: card.displayId, itens: orderLines(card, map) }, tempo);
          releaseOrder(working, key);
          console.log(JSON.stringify({ event: 'pack_marked', checks: checks.length, device: device!.id, ...(tempo ? { seconds: tempo.segundos, timing: tempo.status } : { timing: 'sem_tempo' }) }));
          return done(200, true, `✅ ${card.displayId} embalado`, 'Pode colar a etiqueta e separar para a coleta.');
        } catch {
          console.error(JSON.stringify({ event: 'packing_write_failed' }));
          return done(500, false, 'Não consegui salvar. Tente de novo.');
        }
      }
      if (station) station.live!.v = live(packed, device!.id).v;
      return page(sub === '/impressao' ? renderPrintQueue(queue, map, options) : renderPacking(queue, map, options));
    }
    const stageView = req.method === 'GET' ? url.searchParams.get('ver') : null;
    if (stagesDir && config.production && (stagePost || (sub === '/producao' && stageView !== 'detalhes'))) {
      const { map } = config.production;
      let packed: PackedMap, state: Awaited<ReturnType<typeof loadStages>>;
      try { [packed, state] = await Promise.all([loadPacked(stagesDir), loadStages(stagesDir)]); }
      catch { console.error(JSON.stringify({ event: 'stages_unavailable' })); return send(res, 503, 'Não consegui ler a produção. Tente de novo.', { 'Retry-After': '30' }); }
      let device = readDevice(req);
      const hadDevice = device !== null;
      device ??= { id: newDeviceId() };
      const cookieHeaders: Record<string, string> = hadDevice ? {} : { 'Set-Cookie': deviceCookie(device, `${base}/`, req.headers['x-forwarded-proto'] === 'https') };
      const stageOptions = {
        now: t, nonce, timezone: config.timezone, device, view: stageView, envLabel: config.production.envLabel, healthBar, healthCss,
        paths: { board: `${base}/producao`, mark: `${base}/etapa`, undo: `${base}/etapa-voltar`, rename: `${base}/aparelho`, list: base, packing: `${base}/embalar`, print: `${base}/impressao`, details: `${base}/producao?ver=detalhes` },
      };
      const page = (body: string, status = 200) => html(res, body, nonce, status, cookieHeaders);
      if (stagePost && form) {
        const back = (stage?: string) => `${base}/producao${stage && stage !== 'imprimir' ? `?ver=${stage}` : ''}`;
        const done = (status: number, ok: boolean, title: string, lines: string[] = [], stage?: string) => page(renderStageDone(stageOptions, { ok, title, lines, back: back(stage) }), status);
        // Sem cookie de aparelho não grava: todo registro sabe quem foi.
        if (!hadDevice) return done(428, false, 'Aparelho sem identificação', ['Abra a Produção de novo e repita. Se continuar, libere cookies para este site.']);
        const board = buildStageBoard(queue, map, t, state, packed);
        const change = (p: Piece, etapa: StageId) => ({ piece: p.piece, etapa, etapas: p.etapas, pedido: p.card.displayId, peca: p.nome, quantidade: p.quantidade, ...(etapa === 'nomes' || etapa === 'colar' ? { nomes: p.nomes } : {}) });
        const line = (p: Piece) => `${p.quantidade}× ${p.nome} · ${p.card.displayId}${p.nomes.length ? ` · ${p.nomes.join(', ')}` : ''}`;
        try {
          if (sub === '/etapa-voltar') {
            const raw = form.get('v') ?? '';
            const sep = raw.indexOf(':');
            const etapa = raw.slice(0, sep) as StageId;
            const p = board.pieces.find(x => x.piece === raw.slice(sep + 1) && x.feitas.includes(etapa));
            if (sep < 1 || !stageIds.includes(etapa) || !p) return done(404, false, 'Peça não encontrada ou já desfeita', [], 'imprimir');
            const applied = await applyStages(stagesDir, [{ change: change(p, etapa), undo: true }], t, device);
            if (!applied.length) return done(409, false, 'Não dá para desfazer: tem uma etapa depois desta já marcada (desfaça ela antes), ou outro aparelho mexeu agora.', [], etapa);
            console.log(JSON.stringify({ event: 'stage_undone', stage: etapa, device: device.id }));
            return done(200, true, `↩ Desfeito: "${stageInfo[etapa].nome}"`, [line(p)], etapa);
          }
          const e = form.get('e') as StageId;
          if (!stageIds.includes(e)) return send(res, 400, 'Pedido inválido');
          const wanted = new Set(form.getAll('p'));
          const list = board.byStage[e].filter(p => wanted.has(p.piece));
          if (!list.length) return done(422, false, 'Nenhuma peça marcada', ['Toque nas caixinhas das peças que ficaram prontas e depois no botão verde.'], e);
          const applied = new Set((await applyStages(stagesDir, list.map(p => ({ change: change(p, e) })), t, device)).map(c => c.piece));
          const ok = list.filter(p => applied.has(p.piece));
          console.log(JSON.stringify({ event: 'stage_marked', stage: e, pieces: ok.length, device: device.id }));
          const skipped = list.length - ok.length;
          return done(200, ok.length > 0, ok.length ? (e === 'nomes' ? `✅ ${ok.reduce((n, p) => n + (p.nomes.length || p.quantidade), 0)} nome(s) 3D marcados como impressos` : `✅ ${stageInfo[e].nome}: ${ok.reduce((n, p) => n + p.quantidade, 0)} peça(s) marcadas`) : 'Nada mudou',
            [...ok.map(line), ...(skipped ? [`${skipped} já tinham sido marcadas por outro aparelho.`] : [])], e);
        } catch {
          console.error(JSON.stringify({ event: 'stages_write_failed' }));
          return done(500, false, 'Não consegui salvar. Tente de novo.', [], form.get('e') ?? undefined);
        }
      }
      let history;
      if (stageView === 'historico') {
        try { history = await loadStageHistory(stagesDir, 500); }
        catch { return send(res, 503, 'Não consegui ler o histórico. Tente de novo.', { 'Retry-After': '30' }); }
      }
      return page(renderStageBoard(queue, map, state, packed, { ...stageOptions, history, live: { url: `${base}/ao-vivo.json`, v: live(packed, device.id, state).vp } }));
    }
    if (sub === '/producao' && config.production) {
      const { map, historyLoader = loadSyncHistory, envLabel } = config.production;
      let history: History[] = [];
      let historyUnavailable = false;
      try { history = await historyLoader(config.dataDir); }
      catch (error) {
        historyUnavailable = true;
        const details = error as { code?: unknown; name?: unknown } | null;
        const code = [details?.code, details?.name].find(value =>
          typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value));
        console.error(JSON.stringify({ event: 'production_history_unavailable', code: code ?? 'Error' }));
      }
      return html(res, renderProduction(queue, map, history, {
        now: t, timezone: config.timezone, nonce, envLabel, listHref: base, refreshSeconds: 120,
        historyUnavailable, healthBar, nameFilter: req.method === 'GET' ? url.searchParams.get('nomes') : null,
        ...(filas ? { workflowLinks } : {}),
      }), nonce);
    }
    return html(res, renderPanel(queue, { now: t, timezone: config.timezone, nonce, healthBar, personalizationKeywords: config.keywords, scanHref: paths.scan, productionHref: config.production ? `${base}/producao` : undefined }), nonce);
  };
}

export function startPanel(env: NodeJS.ProcessEnv = process.env) {
  const handler = createPanelHandler({
    token: env.PANEL_TOKEN?.trim() ?? '',
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    timezone: validateTimezone(env.BUSINESS_TIMEZONE ?? defaultTimezone),
    keywords: parseKeywords(env.PERSONALIZATION_KEYWORDS),
    scanSecret: validScanSecret(env.SCAN_KEY),
    ...(env.HEALTH_MONITOR === '1' ? { health: { config: healthConfigFromEnv(env) } } : {}),
    ...(env.CENTRAL_PRODUCAO === '1' ? {
      production: { map: loadComponentMap(env.COMPONENT_MAP_PATH ?? defaultComponentMapPath), envLabel: env.PANEL_ENV_LABEL, filas: env.CENTRAL_PRODUCAO_FILAS === '1',
        ...(env.CENTRAL_EMBALAGEM === '1' ? { embalagem: { dir: validPackingDir(env.PACKING_DIR) } } : {}), etapas: env.CENTRAL_ETAPAS === '1' },
    } : {}),
  });
  const port = Number(env.PANEL_PORT ?? 3100), host = env.PANEL_HOST ?? '127.0.0.1';
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PANEL_PORT_INVALID');
  const server = createServer((req, res) => { handler(req, res).catch(() => { if (!res.headersSent) send(res, 500, 'Erro interno'); else res.end(); }); });
  server.listen(port, host, () => console.log(JSON.stringify({ event: 'panel_listening', host, port })));
  return server;
}
