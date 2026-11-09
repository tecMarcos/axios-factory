import { openSession } from './session.js';
import { CollectorError } from './core.js';
import { findAccount, parseAccounts } from './accounts.js';
import { createInterface } from 'node:readline/promises';
// Usage: npm run login            -> first account
//        npm run login -- Segunda -> the account with that name in UPSELLER_ACCOUNTS
async function login() {
  const account = findAccount(parseAccounts(), process.argv[2]);
  console.log(`Conta: ${account.name}`);
  const context = await openSession(false, account.profileDir);
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
