import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WhatsAppNotificationSender } from '../apps/collector/src/whatsapp-sender.js';

const config = { WHATSAPP_ENABLED: 'true', NOTIFICATION_DRY_RUN: 'false', EVOLUTION_API_URL: 'http://127.0.0.1:1/send', EVOLUTION_API_KEY: 'test-token-private', EVOLUTION_INSTANCE: 'test-instance', WHATSAPP_RECIPIENT_JID: '5511999901234@g.us' };
const noop = () => {};
for (const [name, env, code] of [
  ['disabled', { ...config, WHATSAPP_ENABLED: 'false' }, 'WHATSAPP_DISABLED'],
  ['dry-run', { ...config, NOTIFICATION_DRY_RUN: 'true' }, 'WHATSAPP_DRY_RUN'],
  ['defaults', {}, 'WHATSAPP_DISABLED'],
  ['implicit dry-run', { ...config, NOTIFICATION_DRY_RUN: undefined }, 'WHATSAPP_DRY_RUN'],
] as const) test(`${name}: zero network calls`, async () => {
  let calls = 0;
  const sender = new WhatsAppNotificationSender(env, noop, async () => { calls++; throw Error('unexpected'); });
  await assert.rejects(sender.send('message'), new RegExp(code));
  assert.equal(calls, 0);
});
for (const key of ['EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE', 'WHATSAPP_RECIPIENT_JID']) test(`missing ${key} fails closed`, async () => {
  let calls = 0;
  await assert.rejects(new WhatsAppNotificationSender({ ...config, [key]: '' }, noop, async () => { calls++; throw Error(); }).send('text'), /WHATSAPP_CONFIG_MISSING/);
  assert.equal(calls, 0);
});
for (const status of [200, 201, 202, 204, 400, 401, 403, 500]) test(`HTTP ${status}: ENV, unchanged text, sanitized logs, single attempt`, async () => {
  const requests: { url: string | undefined; auth: string | undefined; body: unknown }[] = [];
  const logs: unknown[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, auth: req.headers.apikey as string, body: JSON.parse(body) });
    res.writeHead(status); res.end(config.EVOLUTION_API_KEY);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const sender = new WhatsAppNotificationSender({ ...config, EVOLUTION_API_URL: `http://127.0.0.1:${port}/custom/send` }, event => logs.push(event));
    const message = 'Axios — Prioridades\n🚨 2x Produto  \n';
    if (status === 200 || status === 201) await sender.send(message);
    else await assert.rejects(sender.send(message), /WHATSAPP_HTTP_ERROR/);
    assert.deepEqual(requests, [{ url: '/custom/send/message/sendText/test-instance', auth: config.EVOLUTION_API_KEY, body: { number: config.WHATSAPP_RECIPIENT_JID, text: message } }]);
    const serialized = JSON.stringify(logs);
    assert.ok(serialized.includes('******1234'));
    assert.ok(!serialized.includes(config.EVOLUTION_API_KEY));
    assert.ok(!serialized.includes(config.WHATSAPP_RECIPIENT_JID));
    assert.ok(!serialized.includes(message));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('timeout aborts one request with sanitized error', async () => {
  let calls = 0;
  const server = createServer(() => { calls++; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    await assert.rejects(new WhatsAppNotificationSender({ ...config, EVOLUTION_API_URL: `http://127.0.0.1:${port}`, WHATSAPP_TIMEOUT_MS: '100' }, noop).send('text'), /WHATSAPP_TIMEOUT/);
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('network errors cannot expose secrets', async () => {
  const logs: unknown[] = [];
  await assert.rejects(new WhatsAppNotificationSender(config, event => logs.push(event), async () => { throw Error(JSON.stringify(config)); }).send('text'), /^Error: WHATSAPP_NETWORK_ERROR$/);
  assert.ok(!JSON.stringify(logs).includes(config.EVOLUTION_API_KEY));
});
for (const value of ['0', '-1', 'invalid', '2147483648']) test(`invalid timeout ${value} makes no request`, async () => {
  await assert.rejects(new WhatsAppNotificationSender({ ...config, WHATSAPP_TIMEOUT_MS: value }, noop, async () => { assert.fail('network'); }).send('text'), /WHATSAPP_CONFIG_INVALID/);
});
for (const recipient of ['123@g.us', '123@s.whatsapp.net']) test(`valid JID ${recipient}`, async () => {
  await new WhatsAppNotificationSender({ ...config, WHATSAPP_RECIPIENT_JID: recipient, EVOLUTION_API_URL: 'https://example.test/base/', EVOLUTION_INSTANCE: 'instance / test' }, noop, async (url, init) => {
    assert.equal(String(url), 'https://example.test/base/message/sendText/instance%20%2F%20test');
    assert.deepEqual(JSON.parse(init!.body as string), { number: recipient, text: 'text' });
    return new Response('', { status: 201 });
  }).send('text');
});
for (const recipient of ['123', '+123@g.us', 'abc@g.us', '123@evil.test', '123@g.us\n']) test('invalid JID rejected: ' + JSON.stringify(recipient), async () => {
  await assert.rejects(new WhatsAppNotificationSender({ ...config, WHATSAPP_RECIPIENT_JID: recipient }, noop, async () => assert.fail('network')).send('text'), /WHATSAPP_CONFIG_INVALID/);
});
