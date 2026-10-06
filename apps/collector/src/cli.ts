import { openSession } from './session.js';
import { collect, CollectorError, parseResponse, profiles, type Contract } from './core.js';
import { save } from './output.js';
function log(event: string, fields: Record<string, string | number> = {}) {
  process.stderr.write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n');
}
async function main() {
  // Never log arbitrary exceptions: browser errors can contain endpoints/credentials.
  const contract: Contract = { ordersPath: 'data.list', totalPath: 'data.total', successPath: 'code', successValue: 0 };
  const maxPages = Number(process.env.MAX_PAGES ?? 1000);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new CollectorError('INVALID_CONFIGURATION');
  const context = await openSession();
  try {
    let authenticated = false;
    const result = await collect(async (profile, pageNum) => {
      const payload = { ...profiles[profile], pageNum };
      const response = await context.request.post('https://app.upseller.com/api/order/index', {
        form: payload,
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
  } finally { await context.close(); }
}
main().catch(error => {
  log('collection_failed', { code: error instanceof CollectorError ? error.code : 'RUNTIME_FAILURE' });
  if (error instanceof CollectorError && error.code === 'AUTH_REQUIRED') console.error('AUTH_REQUIRED: execute npm run login para autenticar manualmente.');
  process.exitCode = 1;
});
