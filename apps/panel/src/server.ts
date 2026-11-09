import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultTimezone, validateTimezone } from '../../collector/src/operational.js';
import { validateSnapshot } from '../../collector/src/notifications.js';
import { parseKeywords } from '../../collector/src/orders-view.js';
import { validScanSecret } from '../../collector/src/scan-keys.js';
import { renderPanel } from './render.js';
import { findOrders, renderScanPage, renderScanResult } from './scan.js';

export type PanelConfig = { token: string; dataDir: string; timezone: string; keywords: string[]; scanSecret?: string; now?: () => number; scannerLibPath?: string };

/** Read the collector's current atomic generation once, so a concurrent collection cannot mix files. */
export async function loadSnapshot(dir: string) {
  let snapshot: string;
  try { snapshot = await realpath(join(dir, '.current')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; snapshot = dir; }
  const [queue, summary] = await Promise.all(['production-queue.json', 'production-summary.json'].map(async f => JSON.parse(await readFile(join(snapshot, f), 'utf8'))));
  return validateSnapshot(queue, summary).queue;
}

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
    const path = new URL(req.url ?? '/', 'http://panel').pathname;
    if (path === '/healthz') return send(res, 200, 'ok');
    const match = /^\/p\/([^/]+)(\/[a-z.]*)?\/?$/.exec(path);
    // Constant-time comparison; any wrong or missing token looks exactly like an unknown page.
    if (!match || !timingSafeEqual(digest(match[1]!), expected)) return send(res, 404, 'Não encontrado');
    const base = `/p/${match[1]}`, sub = match[2] ?? '';
    const paths = { list: base, scan: `${base}/bipar`, lib: `${base}/leitor.js` };
    const allowed = sub === '/bipar' ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD'];
    if (!['', '/bipar', '/leitor.js'].includes(sub)) return send(res, 404, 'Não encontrado');
    if (!allowed.includes(req.method ?? '')) return send(res, 405, 'Método não permitido', { Allow: allowed.join(', ') });

    if (sub === '/leitor.js') {
      lib ??= readFile(libPath).catch(() => null);
      const body = await lib;
      return body ? send(res, 200, body, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, max-age=86400' }) : send(res, 404, 'Não encontrado');
    }
    const nonce = randomBytes(16).toString('base64');
    if (sub === '/bipar' && req.method !== 'POST') {
      const auto = new URL(req.url ?? '/', 'http://panel').searchParams.get('auto') === '1';
      return html(res, renderScanPage({ nonce, paths, auto }), nonce);
    }

    let scanned: string | undefined;
    if (req.method === 'POST') {
      // Codes travel in the POST body so they never land in proxy access logs.
      try { scanned = (await readForm(req)).get('c')?.slice(0, 300) ?? ''; } catch { return send(res, 400, 'Pedido inválido'); }
    }
    let queue;
    try { queue = await loadSnapshot(config.dataDir); }
    catch { console.error(JSON.stringify({ event: 'panel_snapshot_unavailable' })); return send(res, 503, 'Os dados dos pedidos ainda não estão disponíveis. Tente de novo em alguns minutos.', { 'Retry-After': '120' }); }
    const t = now();
    if (scanned !== undefined) {
      const matches = findOrders(queue, scanned, config.scanSecret, t);
      console.log(JSON.stringify({ event: 'panel_scan', matched: matches.length }));
      return html(res, renderScanResult({ nonce, paths, scanned, matches, timezone: config.timezone, personalizationKeywords: config.keywords }), nonce);
    }
    return html(res, renderPanel(queue, { now: t, timezone: config.timezone, nonce, personalizationKeywords: config.keywords, scanHref: paths.scan }), nonce);
  };
}

export function startPanel(env: NodeJS.ProcessEnv = process.env) {
  const handler = createPanelHandler({
    token: env.PANEL_TOKEN?.trim() ?? '',
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    timezone: validateTimezone(env.BUSINESS_TIMEZONE ?? defaultTimezone),
    keywords: parseKeywords(env.PERSONALIZATION_KEYWORDS),
    scanSecret: validScanSecret(env.SCAN_KEY),
  });
  const port = Number(env.PANEL_PORT ?? 3100), host = env.PANEL_HOST ?? '127.0.0.1';
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PANEL_PORT_INVALID');
  const server = createServer((req, res) => { handler(req, res).catch(() => { if (!res.headersSent) send(res, 500, 'Erro interno'); else res.end(); }); });
  server.listen(port, host, () => console.log(JSON.stringify({ event: 'panel_listening', host, port })));
  return server;
}
