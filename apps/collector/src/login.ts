import { openSession } from './session.js';
import { CollectorError } from './core.js';
import { createInterface } from 'node:readline/promises';
async function login() {
  const context = await openSession(false);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://app.upseller.com');
    await terminal.question('Faça login manualmente no navegador privado. Após concluir, pressione Enter para salvar e fechar. ');
  } finally {
    terminal.close();
    await context.close();
  }
}
login().catch(error => {
  console.error(error instanceof CollectorError ? error.code : 'LOGIN_RUNTIME_FAILURE');
  process.exitCode = 1;
});
