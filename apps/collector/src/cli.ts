import { defaultTimezone, validateTimezone, operationalSummary } from './operational.js';
import { openSession } from './session.js';
import { collectOrders, CollectorError, finalize, parseResponse, profiles, type AccountCollection, type Contract } from './core.js';
import { parseAccounts, type AccountStatus } from './accounts.js';
import { save } from './output.js';
import { validScanSecret } from './scan-keys.js';
function log(event: string, fields: Record<string, string | number> = {}) {
  process.stderr.write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n');
}
async function main() {
  // Never log arbitrary exceptions: browser errors can contain endpoints/credentials.
  const contract: Contract = { ordersPath: 'data.list', totalPath: 'data.total', successPath: 'code', successValue: 0 };
  const maxPages = Number(process.env.MAX_PAGES ?? 1000);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new CollectorError('INVALID_CONFIGURATION');
  const timezone = validateTimezone(process.env.BUSINESS_TIMEZONE ?? defaultTimezone);
  let scanSecret: string | undefined;
  try { scanSecret = validScanSecret(process.env.SCAN_KEY); } catch { throw new CollectorError('INVALID_CONFIGURATION'); }
  const topN = Number(process.env.OPERATIONAL_TOP_N ?? 10);
  if (!Number.isSafeInteger(topN) || topN < 0) throw new CollectorError('INVALID_CONFIGURATION');
  const accounts = parseAccounts();
  const parts: AccountCollection[] = [], statuses: AccountStatus[] = [];
  // Accounts run one after the other, each in its own private profile. One account failing
  // (e.g. its login expired) must not hide the orders of the others.
  for (const account of accounts) {
    try {
      const part = await collectAccount(account.profileDir, contract, maxPages, timezone, scanSecret, account.name);
      parts.push({ ...part, ...(accounts.length > 1 ? { account: account.name } : {}) });
      statuses.push({ name: account.name, ok: true, error: null, orders: part.orders.length });
    } catch (error) {
      const code = error instanceof CollectorError ? error.code : 'RUNTIME_FAILURE';
      log('account_failed', { account: account.name, code });
      statuses.push({ name: account.name, ok: false, error: code, orders: 0 });
      if (accounts.length === 1) throw error;
    }
  }
  if (!parts.length) throw new CollectorError(statuses[0]?.error ?? 'RUNTIME_FAILURE');
  const result = finalize(parts, Date.now(), accounts.length > 1 ? statuses : undefined, account => log('duplicate_order_skipped', { account: account ?? '' }));
  {
    const dir = process.env.OUTPUT_DIR ?? 'data';
    for (const order of result.orders) if (order.deadlineWarning) log('deadline_warning', { code: order.deadlineWarning });
    await save(result, dir);
    console.log(operationalSummary(result.productionSummary, timezone, topN));
    console.log(`UpSeller Collector\n${statuses.map(s => `${s.name}: ${s.ok ? `OK (${s.orders} pedidos)` : `FALHOU ${s.error}`}`).join('\n')}\n`);
    console.log(`TO_INVOICE: ${result.summary.counts.TO_INVOICE} pedidos\nTO_SHIP: ${result.summary.counts.TO_SHIP} pedidos\nTO_PRINT: ${result.summary.counts.TO_PRINT} pedidos\n  Não impressas: ${result.summary.print.notPrinted}\n  Impressas: ${result.summary.print.printed}\nTO_PICKUP: ${result.summary.counts.TO_PICKUP} pedidos\n`);
    console.log(`Pedidos únicos: ${result.summary.uniqueOrders}\nUnidades: ${result.summary.units}\n\nProdutos:`);
    for (const product of result.summary.products) console.log(`${product.name.replace(/[\x00-\x1f\x7f]/g, ' ')}: ${product.units}`);
    console.log(`\nOutput:\n${dir}/orders.json\n${dir}/summary.json\n${dir}/production-queue.json\n${dir}/production-summary.json`);
    log('collection_complete', { orders: result.summary.uniqueOrders, units: result.summary.units, accounts: statuses.length, failedAccounts: statuses.filter(s => !s.ok).length });
  }
}

async function collectAccount(profileDir: string, contract: Contract, maxPages: number, timezone: string, scanSecret: string | undefined, accountName: string) {
  const context = await openSession(true, profileDir);
  try {
    let authenticated = false;
    return await collectOrders(async (profile, pageNum) => {
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
        const parsed = parseResponse(status, contentType, body, contract, profile, timezone, scanSecret);
        if (!authenticated) { log('authentication_ok', { account: accountName }); authenticated = true; }
        log('page_collected', { account: accountName, profile, pageNum, count: parsed.orders.length, total: parsed.total });
        return parsed;
      } finally { await response.dispose(); }
    }, maxPages);
  } finally { await context.close(); }
}
main().catch(error => {
  log('collection_failed', { code: error instanceof CollectorError ? error.code : 'RUNTIME_FAILURE' });
  if (error instanceof CollectorError && error.code === 'AUTH_REQUIRED') console.error('AUTH_REQUIRED: execute npm run login -- <conta> para autenticar manualmente.');
  process.exitCode = 1;
});
