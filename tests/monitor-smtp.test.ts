import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { createSecureContext, TLSSocket } from 'node:tls';
import { SmtpAlertNotifier } from '../apps/collector/src/alert-notifier.js';

// Public test-only localhost certificate and key, valid through 2036.
const cert = readFileSync(new URL('./fixtures/smtp-test-only-cert.pem', import.meta.url));
const key = readFileSync(new URL('./fixtures/smtp-test-only-key.pem', import.meta.url));
const secureContext = createSecureContext({ cert, key });

async function fixture(t: TestContext, { extra = '', rejectAll = false } = {}) {
  const plain: string[] = [], encrypted: string[] = [], sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    const reader = createInterface({ input: socket, crlfDelay: Infinity });
    socket.write('220 localhost fixture\r\n');
    reader.on('line', line => {
      plain.push(line);
      if (line === 'EHLO localhost') socket.write('250-localhost\r\n250 STARTTLS\r\n');
      else if (line === 'STARTTLS') {
        reader.close();
        socket.write('220 upgrade\r\n' + extra);
        if (extra) return;
        const tls = new TLSSocket(socket, { isServer: true, secureContext });
        sockets.add(tls);
        tls.on('error', () => {});
        let data = false;
        createInterface({ input: tls, crlfDelay: Infinity }).on('line', line => {
          encrypted.push(line);
          const reply = (text: string) => tls.write(text + '\r\n');
          if (data) {
            if (line === '.') { data = false; reply('250 accepted'); }
          } else if (line === 'EHLO localhost') reply('250-localhost\r\n250 AUTH PLAIN');
          else if (line.startsWith('AUTH PLAIN ')) reply('235 accepted');
          else if (line.startsWith('MAIL FROM:')) reply('250 accepted');
          else if (line === 'RCPT TO:<ok@example.invalid>' && !rejectAll) reply('251 accepted');
          else if (line.startsWith('RCPT TO:')) reply('550 rejected');
          else if (line === 'DATA') { data = true; reply('354 continue'); }
          else if (line === 'QUIT') { reply('221 bye'); tls.end(); }
          else reply('500 unexpected');
        });
      } else socket.write('500 unexpected\r\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    plain, encrypted,
    notifier: new SmtpAlertNotifier({
      SMTP_HOST: 'localhost', SMTP_PORT: String(address.port), SMTP_SECURE: 'starttls', SMTP_TIMEOUT_MS: '2000',
      SMTP_USER: 'fixture', SMTP_PASS: 'fixture-password',
      ALERT_EMAIL_FROM: 'sender@example.invalid', ALERT_EMAIL_TO: 'bad@example.invalid, ok@example.invalid',
    }, { ca: cert }),
  };
}

test('STARTTLS authenticates after upgrade and delivers with one rejected recipient', async t => {
  const { notifier, plain, encrypted } = await fixture(t);
  await notifier.send('fixture subject', 'fixture body');
  assert.deepEqual(plain, ['EHLO localhost', 'STARTTLS']);
  assert.equal(encrypted[0], 'EHLO localhost');
  assert.match(encrypted[1]!, /^AUTH PLAIN /);
  assert.deepEqual(encrypted.slice(3, 6), ['RCPT TO:<bad@example.invalid>', 'RCPT TO:<ok@example.invalid>', 'DATA']);
  assert.deepEqual(encrypted.slice(-3), ['fixture body', '.', 'QUIT']);
});

test('STARTTLS rejects bytes queued after the upgrade response', async t => {
  const { notifier, plain } = await fixture(t, { extra: '250 unexpected\r\n' });
  await assert.rejects(notifier.send('fixture', 'body'), /SMTP_REJECTED/);
  assert.deepEqual(plain, ['EHLO localhost', 'STARTTLS']);
});

test('SMTP rejects delivery if every recipient returns 550', async t => {
  const { notifier, encrypted } = await fixture(t, { rejectAll: true });
  await assert.rejects(notifier.send('fixture', 'body'), /SMTP_REJECTED/);
  assert.deepEqual(encrypted.slice(-2), ['RCPT TO:<bad@example.invalid>', 'RCPT TO:<ok@example.invalid>']);
});
