import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultTimezone, validateTimezone } from '../../collector/src/operational.js';
import { validateSnapshot } from '../../collector/src/notifications.js';
import { parseKeywords } from '../../collector/src/orders-view.js';
import { renderPanel } from './render.js';

export type PanelConfig = { token: string; dataDir: string; timezone: string; keywords: string[]; now?: () => number };

/** Read the collector's current atomic generation once, so a concurrent collection cannot mix files. */
export async function loadSnapshot(dir: string) {
  let snapshot: string;
  try { snapshot = await realpath(join(dir, '.current')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; snapshot = dir; }
  const [queue, summary] = await Promise.all(['production-queue.json', 'production-summary.json'].map(async f => JSON.parse(await readFile(join(snapshot, f), 'utf8'))));
  return validateSnapshot(queue, summary).queue;
}

const digest = (s: string) => createHash('sha256').update(s).digest();
const baseHeaders = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
};

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

export function createPanelHandler(config: PanelConfig) {
  if (config.token.length < 24 || !/^[A-Za-z0-9_-]+$/.test(config.token)) throw new Error('PANEL_TOKEN_INVALID');
  const expected = digest(config.token);
  const now = config.now ?? Date.now;
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método não permitido', { Allow: 'GET, HEAD' });
    const path = new URL(req.url ?? '/', 'http://panel').pathname;
    if (path === '/healthz') return send(res, 200, 'ok');
    const match = /^\/p\/([^/]+)\/?$/.exec(path);
    // Constant-time comparison; any wrong or missing token looks exactly like an unknown page.
    if (!match || !timingSafeEqual(digest(match[1]!), expected)) return send(res, 404, 'Não encontrado');
    let queue;
    try { queue = await loadSnapshot(config.dataDir); }
    catch { console.error(JSON.stringify({ event: 'panel_snapshot_unavailable' })); return send(res, 503, 'Os dados dos pedidos ainda não estão disponíveis. Tente de novo em alguns minutos.', { 'Retry-After': '120' }); }
    const nonce = randomBytes(16).toString('base64');
    const html = renderPanel(queue, { now: now(), timezone: config.timezone, nonce, personalizationKeywords: config.keywords });
    send(res, 200, html, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; img-src https:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
  };
}

export function startPanel(env: NodeJS.ProcessEnv = process.env) {
  const handler = createPanelHandler({
    token: env.PANEL_TOKEN?.trim() ?? '',
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    timezone: validateTimezone(env.BUSINESS_TIMEZONE ?? defaultTimezone),
    keywords: parseKeywords(env.PERSONALIZATION_KEYWORDS),
  });
  const port = Number(env.PANEL_PORT ?? 3100), host = env.PANEL_HOST ?? '127.0.0.1';
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PANEL_PORT_INVALID');
  const server = createServer((req, res) => { handler(req, res).catch(() => { if (!res.headersSent) send(res, 500, 'Erro interno'); else res.end(); }); });
  server.listen(port, host, () => console.log(JSON.stringify({ event: 'panel_listening', host, port })));
  return server;
}
