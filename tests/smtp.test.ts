import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { emailNotifierFromEnv, SmtpAlertNotifier } from '../apps/collector/src/alert-notifier.js';

const password = 'fixture-smtp-password';
const env = { SMTP_HOST: '127.0.0.1', SMTP_SECURE: 'none', SMTP_USER: 'test', SMTP_PASS: password, ALERT_EMAIL_FROM: 'test@example.invalid', ALERT_EMAIL_TO: 'one@example.invalid, two@example.invalid' };
async function fake(t: TestContext, behavior: 'ok' | 'auth_failure' | 'timeout' | 'login' = 'ok') {
  const transcript: string[] = [], sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (behavior === 'timeout') return;
    const reply = (line: string) => socket.write(line + '\r\n');
    reply('220 local fixture');
    let data = false, loginStep = 0;
    createInterface({ input: socket, crlfDelay: Infinity }).on('line', line => {
      transcript.push(line);
      if (data) {
        if (line === '.') { data = false; reply('250 accepted'); }
      } else if (line.startsWith('EHLO ')) reply(`250-local fixture\r\n250 AUTH ${behavior === 'login' ? 'LOGIN' : 'PLAIN'}`);
      else if (line === 'AUTH LOGIN') { loginStep = 1; reply('334 VXNlcm5hbWU6'); }
      else if (loginStep === 1) { loginStep = 2; reply('334 UGFzc3dvcmQ6'); }
      else if (loginStep === 2) { loginStep = 0; reply('235 accepted'); }
      else if (line.startsWith('AUTH PLAIN ')) reply(behavior === 'auth_failure' ? `535 rejected ${password}` : '235 accepted');
      else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) reply('250 accepted');
      else if (line === 'DATA') { data = true; reply('354 continue'); }
      else if (line === 'QUIT') { reply('221 bye'); socket.end(); }
      else reply('500 unexpected');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { transcript, config: { ...env, SMTP_PORT: String(address.port) } };
}

test('SMTP PLAIN dialogue uses safe envelopes, encoded subject and dot-stuffing', async t => {
  const { transcript, config } = await fake(t);
  const subject = 'Sessão crítica';
  await new SmtpAlertNotifier(config).send(subject, 'Hello\n.dot\r\n..two\rLast');
  const credentials = Buffer.from(`\0test\0${password}`).toString('base64');
  assert.deepEqual(transcript.slice(0, 6), ['EHLO localhost', `AUTH PLAIN ${credentials}`, 'MAIL FROM:<test@example.invalid>', 'RCPT TO:<one@example.invalid>', 'RCPT TO:<two@example.invalid>', 'DATA']);
  assert.ok(transcript.includes(`Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`));
  assert.ok(transcript.includes('Content-Type: text/plain; charset=utf-8'));
  assert.ok(transcript.some(line => line.startsWith('Message-ID: <')));
  assert.ok(transcript.some(line => line.startsWith('Date: ')));
  assert.deepEqual(transcript.slice(-6), ['Hello', '..dot', '...two', 'Last', '.', 'QUIT']);
});

test('SMTP supports AUTH LOGIN and base64 UTF-8 body without 8BITMIME', async t => {
  const { transcript, config } = await fake(t, 'login');
  await new SmtpAlertNotifier(config).send('Assunto', 'Olá');
  assert.deepEqual(transcript.slice(1, 4), ['AUTH LOGIN', Buffer.from(env.SMTP_USER).toString('base64'), Buffer.from(password).toString('base64')]);
  assert.ok(transcript.includes('Content-Transfer-Encoding: base64'));
  assert.equal(transcript.at(-3), Buffer.from('Olá').toString('base64'));
});

test('SMTP rejects header injection and refuses plaintext for remote hosts', async () => {
  await assert.rejects(new SmtpAlertNotifier(env).send('bad\r\nBcc: hidden@example.invalid', 'body'), /SMTP_CONFIG_INVALID/);
  for (const config of [
    { ...env, ALERT_EMAIL_FROM: env.ALERT_EMAIL_FROM + '\r\n' },
    { ...env, ALERT_EMAIL_TO: env.ALERT_EMAIL_TO + '\nBcc: hidden@example.invalid' },
    { ...env, SMTP_HOST: 'smtp.example.invalid' },
  ]) assert.throws(() => new SmtpAlertNotifier(config), /SMTP_CONFIG_INVALID/);
  assert.equal(emailNotifierFromEnv({}), null);
  assert.throws(() => emailNotifierFromEnv({ ALERT_EMAIL_ENABLED: 'true' }), /SMTP_CONFIG_MISSING/);
});

test('SMTP 535 yields a safe authentication error and never logs credentials', async t => {
  const { config } = await fake(t, 'auth_failure');
  const logs = [t.mock.method(console, 'log', () => {}), t.mock.method(console, 'error', () => {}), t.mock.method(console, 'warn', () => {})];
  await assert.rejects(new SmtpAlertNotifier(config).send('Assunto', 'body'), error => {
    assert.equal((error as Error).message, 'SMTP_AUTH_FAILED');
    assert.doesNotMatch(String(error), new RegExp(password));
    return true;
  });
  assert.ok(logs.every(log => log.mock.callCount() === 0));
});

test('SMTP timeout and required STARTTLS are enforced', async t => {
  const slow = await fake(t, 'timeout');
  await assert.rejects(new SmtpAlertNotifier({ ...slow.config, SMTP_TIMEOUT_MS: '30' }).send('Assunto', 'body'), /SMTP_TIMEOUT/);
  const plain = await fake(t);
  await assert.rejects(new SmtpAlertNotifier({ ...plain.config, SMTP_SECURE: 'starttls' }).send('Assunto', 'body'), /SMTP_STARTTLS_UNAVAILABLE/);
  assert.deepEqual(plain.transcript, ['EHLO localhost']);
});
