import { chromium } from 'playwright';
import { collect, CollectorError, parseResponse, profiles, type Contract } from './core.js';
import { save } from './output.js';
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new CollectorError('MISSING_CONFIGURATION');
  return value;
}
function log(event: string, fields: Record<string, string | number> = {}) {
  process.stderr.write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n');
}
async function main() {
  // Never log arbitrary exceptions: browser errors can contain endpoints/credentials.
  const contract: Contract = { ordersPath: required('ORDERS_PATH'), totalPath: required('TOTAL_PATH'), successPath: required('SUCCESS_PATH'), successValue: JSON.parse(required('SUCCESS_VALUE')) };
  const encoding = required('REQUEST_ENCODING');
  if (!['json', 'form'].includes(encoding)) throw new CollectorError('INVALID_CONFIGURATION');
  const maxPages = Number(process.env.MAX_PAGES ?? 1000);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new CollectorError('INVALID_CONFIGURATION');
  const endpoint = new URL(required('CDP_URL'));
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new CollectorError('INVALID_CDP_URL');
  const browser = await chromium.connectOverCDP(endpoint.toString(), { timeout: 15000 });
  try {
    const candidates = browser.contexts().filter(context => context.pages().some(page => {
      try { return new URL(page.url()).origin === 'https://app.upseller.com'; } catch { return false; }
    }));
    if (candidates.length !== 1) throw new CollectorError('AUTHENTICATED_CONTEXT_REQUIRED');
    const context = candidates[0]!;
    let authenticated = false;
    const result = await collect(async (profile, pageNum) => {
      const payload = { ...profiles[profile], pageNum };
      const response = await context.request.post('https://app.upseller.com/api/order/index', {
        ...(encoding === 'json' ? { data: payload } : { form: payload }),
        headers: { Origin: 'https://app.upseller.com', Referer: 'https://app.upseller.com/' },
        timeout: 30000, maxRedirects: 0, maxRetries: 0,
      });
      try {
        const status = response.status(), contentType = response.headers()['content-type'] ?? '';
        let body: unknown = null;
        if (status === 200 && contentType.includes('application/json')) {
          try { body = await response.json(); } catch { throw new CollectorError('INVALID_JSON'); }
        }
        const parsed = parseResponse(status, contentType, body, contract);
        if (!authenticated) { log('authentication_ok'); authenticated = true; }
        log('page_collected', { profile, pageNum, count: parsed.orders.length, total: parsed.total });
        return parsed;
      } finally { await response.dispose(); }
    }, maxPages);
    const dir = process.env.OUTPUT_DIR ?? 'data';
    await save(result, dir);
    console.log('UpSeller Collector\nAuthentication: OK\n');
    console.log(`TO_SHIP: ${result.summary.counts.TO_SHIP} pedidos\nTO_PICKUP: ${result.summary.counts.TO_PICKUP} pedidos\n`);
    console.log(`Pedidos únicos: ${result.summary.uniqueOrders}\nUnidades: ${result.summary.units}\n\nProdutos:`);
    for (const product of result.summary.products) console.log(`${product.name.replace(/[\x00-\x1f\x7f]/g, ' ')}: ${product.units}`);
    console.log(`\nOutput:\n${dir}/orders.json\n${dir}/summary.json`);
    log('collection_complete', { orders: result.summary.uniqueOrders, units: result.summary.units });
  } finally { await browser.close(); } // Disconnects a connected browser; does not close the owner's browser.
}
main().catch(error => {
  log('collection_failed', { code: error instanceof CollectorError ? error.code : 'RUNTIME_FAILURE' });
  process.exitCode = 1;
});
