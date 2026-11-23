import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { connect as connectTls, type ConnectionOptions } from 'node:tls';

export interface AlertNotifier { channel: string; send(subject: string, text: string): Promise<void> }
export class MemoryAlertNotifier implements AlertNotifier {
  readonly channel = 'email';
  readonly messages: { subject: string; text: string }[] = [];
  async send(subject: string, text: string) { this.messages.push({ subject, text }); }
}

type SmtpConfig = { host: string; port: number; secure: 'tls' | 'starttls' | 'none'; user: string; pass: string; from: string; to: string[]; timeout: number };
const fail = (code: string): never => { throw new Error(code); };
const base64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const invalidHeader = (value: string) => /[\r\n\x00]/.test(value);
const address = (value: string) => value.length <= 254 && /^[a-z\d!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z\d!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(value);

function smtpConfig(env: NodeJS.ProcessEnv): SmtpConfig {
  const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASS: pass, ALERT_EMAIL_FROM: from, ALERT_EMAIL_TO: recipients } = env;
  if (!host?.trim() || !user?.trim() || !pass || !from?.trim() || !recipients?.trim()) return fail('SMTP_CONFIG_MISSING');
  const secure = env.SMTP_SECURE ?? 'tls';
  const port = Number(env.SMTP_PORT ?? (secure === 'tls' ? 465 : 587));
  const timeout = Number(env.SMTP_TIMEOUT_MS ?? 15000);
  const to = recipients.split(',').map(entry => entry.trim());
  if ((secure !== 'tls' && secure !== 'starttls' && secure !== 'none') ||
      (secure === 'none' && host !== '127.0.0.1' && host.toLowerCase() !== 'localhost') ||
      !/^[a-z\d][a-z\d.-]*$/i.test(host) || invalidHeader(host) || invalidHeader(user) || invalidHeader(pass) ||
      invalidHeader(from) || invalidHeader(recipients) || !address(from) || to.length > 5 || !to.every(address) ||
      !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647) return fail('SMTP_CONFIG_INVALID');
  return { host, port, secure, user, pass, from, to, timeout };
}

function encodedSubject(subject: string) {
  const words: string[] = [];
  let chunk = '';
  for (const char of subject) {
    if (Buffer.byteLength(chunk + char) > 42) {
      words.push(chunk); chunk = '';
    }
    chunk += char;
  }
  words.push(chunk);
  return words.map(word => `=?UTF-8?B?${base64(word)}?=`).join('\r\n ');
}

function message(config: SmtpConfig, subject: string, text: string, eightBit: boolean) {
  const lines = text.split(/\r\n|\r|\n/);
  const encoded = (!eightBit && /[^\x01-\x7f]/.test(text)) || text.includes('\0') || lines.some(line => Buffer.byteLength(line) > 997);
  const body = encoded ? (base64(lines.join('\r\n')).match(/.{1,76}/g) ?? []) : lines;
  return [
    `From: ${config.from}`, `To: ${config.to.join(',\r\n ')}`, `Subject: ${encodedSubject(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomUUID()}@${config.from.split('@')[1]}>`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8', `Content-Transfer-Encoding: ${encoded ? 'base64' : '8bit'}`, '',
    ...body.map(line => line.startsWith('.') ? '.' + line : line), '.', '',
  ].join('\r\n');
}

function dialogue(socket: Socket) {
  let pending = '';
  let closed = false;
  let wake: (() => void) | undefined;
  const readable = () => wake?.();
  const close = () => { closed = true; wake?.(); };
  socket.on('readable', readable).once('end', close).once('close', close);
  async function readLine() {
    for (;;) {
      const end = pending.indexOf('\r\n');
      if (end >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        return line;
      }
      if (closed) return null;
      const chunk: Buffer | null = socket.read();
      if (chunk) pending += chunk.toString('latin1');
      else await new Promise<void>(resolve => { wake = resolve; });
    }
  }
  async function reply(expected: number[], error = 'SMTP_REJECTED') {
    const details: string[] = [];
    let code: number | undefined;
    for (let i = 0; i < 100; i++) {
      const line = await readLine();
      const match = /^(\d{3})(?:([ -])(.*))?$/.exec(line ?? '');
      if (line === null || !match || (code !== undefined && code !== Number(match[1]))) return fail(error);
      code = Number(match[1]);
      details.push(match[3] ?? '');
      if (match[2] !== '-') return expected.includes(code) ? { code, details } : fail(error);
    }
    return fail(error);
  }
  return {
    reply,
    close: () => {
      socket.off('readable', readable).off('end', close).off('close', close);
      close();
      return pending.length > 0 || socket.readableLength > 0;
    },
    command: (line: string, expected: number[], error?: string) => { socket.write(line + '\r\n'); return reply(expected, error); },
  };
}

export class SmtpAlertNotifier implements AlertNotifier {
  readonly channel = 'email';
  private readonly config: SmtpConfig;
  constructor(env: NodeJS.ProcessEnv = process.env, private readonly tlsOptions?: Pick<ConnectionOptions, 'ca'>) { this.config = smtpConfig(env); }

  async send(subject: string, text: string) {
    if (invalidHeader(subject)) fail('SMTP_CONFIG_INVALID');
    const config = this.config;
    // Use the IPv4 loopback address directly for the plaintext test transport.
    const host = config.secure === 'none' ? '127.0.0.1' : config.host;
    const tls = { ...this.tlsOptions, host, port: config.port, servername: /^[\d.]+$/.test(host) ? undefined : host, rejectUnauthorized: true };
    let socket: Socket = config.secure === 'tls' ? connectTls(tls) : connect(config.port, host);
    let smtp = dialogue(socket);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let accepted = false;
    let connecting = true;
    let watchErrors: (socket: Socket) => void = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      watchErrors = target => target.on('error', () => reject(new Error(connecting ? 'SMTP_CONNECT_FAILED' : 'SMTP_REJECTED')));
      watchErrors(socket);
      timer = setTimeout(() => reject(new Error('SMTP_TIMEOUT')), config.timeout);
    });
    try {
      await Promise.race([interrupted, (async () => {
        await smtp.reply([220], 'SMTP_CONNECT_FAILED');
        connecting = false;
        let { details: capabilities } = await smtp.command('EHLO localhost', [250]);
        if (config.secure === 'starttls') {
          if (!capabilities.some(line => /^STARTTLS(?:\s|$)/i.test(line))) fail('SMTP_STARTTLS_UNAVAILABLE');
          await smtp.command('STARTTLS', [220], 'SMTP_STARTTLS_UNAVAILABLE');
          if (smtp.close()) fail('SMTP_REJECTED');
          connecting = true;
          const secureSocket = connectTls({ ...tls, socket });
          watchErrors(secureSocket);
          socket = secureSocket;
          smtp = dialogue(socket);
          await new Promise<void>(resolve => secureSocket.once('secureConnect', resolve));
          connecting = false;
          ({ details: capabilities } = await smtp.command('EHLO localhost', [250]));
        }
        const auth = capabilities.filter(line => /^AUTH[ =]/i.test(line)).join(' ').toUpperCase().split(/[ =]+/);
        if (auth.includes('LOGIN') && !auth.includes('PLAIN')) {
          await smtp.command('AUTH LOGIN', [334], 'SMTP_AUTH_FAILED');
          await smtp.command(base64(config.user), [334], 'SMTP_AUTH_FAILED');
          await smtp.command(base64(config.pass), [235], 'SMTP_AUTH_FAILED');
        } else {
          await smtp.command(`AUTH PLAIN ${base64(`\0${config.user}\0${config.pass}`)}`, [235], 'SMTP_AUTH_FAILED');
        }
        const eightBit = capabilities.some(line => /^8BITMIME(?:\s|$)/i.test(line));
        await smtp.command(`MAIL FROM:<${config.from}>${eightBit ? ' BODY=8BITMIME' : ''}`, [250]);
        let recipientsAccepted = 0;
        for (const recipient of config.to) {
          const { code } = await smtp.command(`RCPT TO:<${recipient}>`, [250, 251, 550]);
          if (code !== 550) recipientsAccepted++;
        }
        if (!recipientsAccepted) fail('SMTP_REJECTED');
        await smtp.command('DATA', [354]);
        socket.write(message(config, subject, text, eightBit));
        await smtp.reply([250]);
        accepted = true;
        await smtp.command('QUIT', [221]);
      })()]);
    } catch (error) {
      // Once DATA is accepted, a lost QUIT reply must not trigger a duplicate delivery.
      if (!accepted) {
        const known = ['SMTP_CONNECT_FAILED', 'SMTP_REJECTED', 'SMTP_TIMEOUT', 'SMTP_AUTH_FAILED', 'SMTP_STARTTLS_UNAVAILABLE'];
        fail(error instanceof Error && known.includes(error.message) ? error.message : 'SMTP_REJECTED');
      }
    } finally {
      clearTimeout(timer);
      smtp.close();
      socket.destroy();
    }
  }
}

export function emailNotifierFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpAlertNotifier | null {
  return env.ALERT_EMAIL_ENABLED === 'true' ? new SmtpAlertNotifier(env) : null;
}
