# UpSeller Collector V0.2

Node.js + TypeScript + Playwright. Coleta TO_INVOICE, TO_SHIP, TO_PRINT e TO_PICKUP por POST em
`https://app.upseller.com/api/order/index`, pagina com 50 pedidos, deduplica por
`orderNumber` e produz `data/orders.json` e `data/summary.json`.

**Estado:** contrato confirmado pelo usuário; 22 testes locais aprovados. Aceite real na VPS pendente.

Guia completo: [instalação, autenticação e operação Docker](docs/operations.md).

## Executar e autenticar

Requer Node.js 24 e Playwright Chromium. O perfil deve ficar fora do repositório,
pertencer ao usuário executor e ter permissão 0700. O processo usa umask 0077.

```sh
npm ci
npx playwright install --with-deps chromium
cp .env.example .env
# Provisionar /opt/axios-factory-runtime/upseller-profile com proprietário executor e modo 0700.
npm run login
npm run collect
```

O login abre Chromium com interface gráfica; exige sessão gráfica privada no host,
acessada por conexão segura já autorizada. Não publica VNC, CDP ou portas.
Complete login, CAPTCHA/MFA manualmente e pressione Enter para fechar e persistir.
Login e coleta não podem usar o mesmo perfil simultaneamente. Após reinício,
a coleta reutiliza o perfil; a validade continua sujeita ao servidor UpSeller.

Contrato fixado: POST form-urlencoded, sucesso estrito `code === 0`, lista
`data.list`, total `data.total`. O primeiro POST válido confirma autenticação.
HTTP 401/403, redirecionamento, HTML e códigos JSON 401/403 retornam
`AUTH_REQUIRED` e instruem novo login. Outros códigos de negócio são rejeitados;
o código específico de expiração UpSeller ainda não foi observado. Não há
fallback, captura de HAR, exportação de cookies ou contorno de segurança.

O perfil é o único armazenamento privado da sessão; nunca incluir em Git,
ZIP, logs ou artefatos. Não expor seu diretório por servidor web.

## Saídas e proteção de dados

Somente os campos de pedido e item listados na tarefa entram nos arquivos. Campos
extras são descartados, inclusive campos extras dentro dos itens. Objetos em
campos escalares são rejeitados. Datas e preços são preservados como texto, sem
supor timezone/moeda; contagens são inteiros não negativos. Campos opcionais
ausentes viram `null`. Valores de campos permitidos não passam por classificação
semântica de PII; não devem conter dados de comprador inseridos livremente.

Pedidos incluem queues com todas as filas; repetidos entre perfis contam uma vez nas unidades; TO_PICKUP prevalece
para metadados quando os itens são idênticos. Itens divergentes interrompem a
coleta. Resumo por produto agrupa pelo nome e soma `productCount`; contagens por
perfil são anteriores à deduplicação. A API não oferece snapshot confirmado:
repita a coleta em período sem movimentação para validar o aceite.

Logs JSON vão para stderr e contêm apenas eventos, códigos e contagens. stdout
mostra o resumo legível. Nenhum corpo de resposta, credencial ou exceção bruta é
registrado. Falha retorna código 1 e não publica uma nova coleta.

Publicação usa snapshots privados e troca atômica de `data/.current` no Linux.
`orders.json` e `summary.json` são links para o snapshot atual. Para ler ambos de
forma consistente durante coletas concorrentes, resolva `.current` uma vez e leia
os dois arquivos naquele diretório. Snapshots anteriores permanecem em `data/`
para recuperação; podem ser removidos fora da coleta quando não forem usados por
leitores. Não versionar nem publicar `data/`.

## Docker na VPS Linux

A imagem instala Chromium correspondente ao Playwright e executa como usuário
`node` (UID 1000). O bind mount privado persiste fora do repositório e sobrevive
ao descarte do container e reinício da VPS. Nenhuma porta é publicada.

```sh
sudo install -d -m 0700 -o 1000 -g 1000 /opt/axios-factory-runtime/upseller-profile
mkdir -p data
# Garantir que data seja gravável pelo UID 1000.
docker compose build
docker compose run --rm collector
```

Faça o login manual no host com o mesmo perfil, versão Chromium compatível e UID
1000, usando a sessão gráfica privada. Feche esse navegador antes da coleta Docker.
O Compose não provisiona acesso gráfico remoto. Não execute login como root.

## Verificar

```sh
npm run typecheck
npm test
```

Testes usam dados sintéticos: paginação, deduplicação, totais, privacidade,
autenticação inválida, limites e publicação de arquivos. Docker não foi executado
neste ambiente porque o binário não está instalado. Ver [validação](docs/validation.md).

Referências de implementação: [Playwright](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)
e [APIRequestContext](https://playwright.dev/docs/api/class-apirequestcontext).

## Perfis V0.2

| Perfil | Tela |
| --- | --- |
| TO_INVOICE | Para Emitir |
| TO_SHIP | Para Enviar |
| TO_PRINT | Para Imprimir |
| TO_PICKUP | Para Retirada |

TO_PRINT usa uma única consulta paginada. A classificação local usa estritamente
`isPrintLabel=0` → `PRINT_LABEL_NOT_PRINTED` e
`isPrintLabel=1` → `PRINT_LABEL_PRINTED`, persistida em `printLabelState`.
Campo ausente ou diferente de 0/1 interrompe a coleta com
`INVALID_PRINT_LABEL_STATE`; não há conversão de strings nem classificação presumida.
Não há coleta de Para Reservar.

A allowlist foi ampliada somente com `queues` e `printLabelState`.
O campo bruto `isPrintLabel` não é persistido. `summary.json` mantém `counts`
e acrescenta `queues` (as mesmas contagens) e `print: { notPrinted, printed }`.
`uniqueOrders`, `units`, `products` e `collectedAt` são preservados.
As contagens por fila incluem pedidos compartilhados; as unidades globais não.
Todos os perfis usam pageSize=50, pageNum inicial 1 e MAX_PAGES.
