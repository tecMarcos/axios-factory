import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultTimezone, validateTimezone } from '../../collector/src/operational.js';
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
import { decisionsFor } from '../../production/src/workflow.js';
import { healthCss } from './render.js';
import { renderPanel } from './render.js';
import { findOrders, renderScanPage, renderScanResult } from './scan.js';

type HealthReader<T> = (dir: string) => Promise<T | null> | T | null;
const readMonitor = <T>(dir: string, read: HealthReader<T>) => Promise.resolve().then(() => read(dir)).catch(() => null);

export type PanelConfig = { token: string; dataDir: string; timezone: string; keywords: string[]; scanSecret?: string; now?: () => number; scannerLibPath?: string; health?: { config: Partial<HealthConfig>; readHealth?: HealthReader<Health>; readNotify?: HealthReader<NotifyHealth> }; production?: { map: ComponentMap; historyLoader?: (dataDir: string) => Promise<History[]>; envLabel?: string; filas?: boolean } };

export async function loadSnapshot(dir: string) { return (await readSnapshot(dir)).queue; }

export const defaultScannerLib = fileURLToPath(new URL('../../../node_modules/@zxing/library/umd/index.min.js', import.meta.url));

const digest = (s: string) => createHash('sha256').update(s).digest();
const baseHeaders = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};
const csp = (nonce: string) => `default-src 'none'; img-src https:; media-src 'self' blob: mediastream:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  res.writeHead(status, { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}
const html = (res: ServerResponse, body: string, nonce: string, status = 200) => send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp(nonce) });

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
  let lib: Promise<Buffer | null> | undefined;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://panel');
    const path = url.pathname;
    if (path === '/healthz') return send(res, 200, 'ok');
    const match = /^\/p\/([^/]+)(\/[a-z.]*)?\/?$/.exec(path);
    // Constant-time comparison; any wrong or missing token looks exactly like an unknown page.
    if (!match || !timingSafeEqual(digest(match[1]!), expected)) return send(res, 404, 'Não encontrado');
    const base = `/p/${match[1]}`, sub = match[2] ?? '';
    const paths = { list: base, scan: `${base}/bipar`, lib: `${base}/leitor.js` };
    const filas = config.production?.filas === true;
    const workflowLinks = { list: base, production: `${base}/producao`, print: `${base}/impressao`, packing: `${base}/embalar`, scan: paths.scan };
    const allowed = sub === '/bipar' ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD'];
    if (!['', '/bipar', '/leitor.js'].includes(sub) && !(sub === '/producao' && config.production) && !((sub === '/impressao' || sub === '/embalar') && filas) && !(sub === '/saude.json' && config.health)) return send(res, 404, 'Não encontrado');
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
    if (req.method === 'POST') {
      // Codes travel in the POST body so they never land in proxy access logs.
      try { scanned = (await readForm(req)).get('c')?.slice(0, 300) ?? ''; } catch { return send(res, 400, 'Pedido inválido'); }
    }
    const queue = await loadSnapshot(config.dataDir).catch(() => null);
    if (!queue && sub !== '/saude.json') {
      console.error(JSON.stringify({ event: 'panel_snapshot_unavailable' }));
      return send(res, 503, 'Os dados dos pedidos ainda não estão disponíveis. Tente de novo em alguns minutos.', { 'Retry-After': '120' });
    }
    const t = now();
    let healthBar: string | undefined;
    if (config.health && scanned === undefined) {
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
      const decisions = filas && config.production ? decisionsFor({ ...queue, orders: matches }, config.production.map, t) : undefined;
      return html(res, renderScanResult({ nonce, paths, scanned, matches, timezone: config.timezone, personalizationKeywords: config.keywords, decisions }), nonce);
    }
    if ((sub === '/impressao' || sub === '/embalar') && filas && config.production) {
      const options = { now: t, nonce, links: workflowLinks, envLabel: config.production.envLabel, healthBar, healthCss, refreshSeconds: 120 };
      return html(res, sub === '/impressao' ? renderPrintQueue(queue, config.production.map, options) : renderPacking(queue, config.production.map, options), nonce);
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
      production: { map: loadComponentMap(env.COMPONENT_MAP_PATH ?? defaultComponentMapPath), envLabel: env.PANEL_ENV_LABEL, filas: env.CENTRAL_PRODUCAO_FILAS === '1' },
    } : {}),
  });
  const port = Number(env.PANEL_PORT ?? 3100), host = env.PANEL_HOST ?? '127.0.0.1';
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PANEL_PORT_INVALID');
  const server = createServer((req, res) => { handler(req, res).catch(() => { if (!res.headersSent) send(res, 500, 'Erro interno'); else res.end(); }); });
  server.listen(port, host, () => console.log(JSON.stringify({ event: 'panel_listening', host, port })));
  return server;
}
