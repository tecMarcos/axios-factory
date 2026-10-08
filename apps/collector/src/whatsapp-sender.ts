import type { Log, NotificationSender } from './notification-runner.js';

/** Evolution API sendText contract. */
export class WhatsAppNotificationSender implements NotificationSender {
  private readonly env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv = process.env, private readonly log: Log = event => console.log(JSON.stringify(event)), private readonly request: typeof fetch = fetch) {
    this.env = { ...env };
  }

  async send(message: string): Promise<void> {
    const env = this.env;
    // A skipped delivery must never resolve as success for a stateful caller.
    const fail = (code: string, httpStatus?: number): never => {
      this.log({ event: 'notification_failed', provider: 'evolution', errorCode: code, ...(httpStatus === undefined ? {} : { httpStatus }) });
      throw new Error(code);
    };
    if (env.WHATSAPP_ENABLED !== 'true') fail('WHATSAPP_DISABLED');
    if (env.NOTIFICATION_DRY_RUN !== 'false') fail('WHATSAPP_DRY_RUN');
    const base = env.EVOLUTION_API_URL, token = env.EVOLUTION_API_KEY;
    const instance = env.EVOLUTION_INSTANCE, recipient = env.WHATSAPP_RECIPIENT_JID;
    if (![base, token, instance, recipient].every(value => value?.trim())) fail('WHATSAPP_CONFIG_MISSING');
    let endpoint: URL;
    try { endpoint = new URL(base!); } catch { return fail('WHATSAPP_CONFIG_INVALID'); }
    const timeout = Number(env.WHATSAPP_TIMEOUT_MS ?? '10000');
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647 || /[\r\n]/.test(token!)) fail('WHATSAPP_CONFIG_INVALID');
    if (!/^\d+@(g\.us|s\.whatsapp\.net)$/.test(recipient!)) fail('WHATSAPP_CONFIG_INVALID');
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/message/sendText/${encodeURIComponent(instance!)}`;
    // Only a numeric suffix may appear in logs, never arbitrary recipient content.
    const maskedRecipient = `******${recipient!.split('@')[0]!.slice(-4)}@${recipient!.split('@')[1]}`;
    this.log({ event: 'notification_send_attempt', provider: 'evolution', maskedRecipient });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response: Response;
    try {
      response = await this.request(endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', apikey: token! },
        body: JSON.stringify({ number: recipient, text: message }),
      });
    } catch {
      return fail(controller.signal.aborted ? 'WHATSAPP_TIMEOUT' : 'WHATSAPP_NETWORK_ERROR');
    } finally { clearTimeout(timer); }
    // Never parse or log provider responses, which may echo credentials or PII.
    void response.body?.cancel().catch(() => {});
    if (response.status !== 200 && response.status !== 201) fail('WHATSAPP_HTTP_ERROR', response.status);
    this.log({ event: 'notification_sent', provider: 'evolution', maskedRecipient, httpStatus: response.status });
  }
}
