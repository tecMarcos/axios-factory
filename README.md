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

## V0.3 — prioridade operacional (aceite local; VPS ainda não certificada)

`npm run collect` também publica `data/production-queue.json` (pedidos ordenados,
items por allowlist, queues completas, estágio operacional) e
`data/production-summary.json` (totais, contagem por prioridade e produtos).
Os quatro arquivos pertencem ao mesmo snapshot, publicado por rename atômico do
link `.current`. Leitores de múltiplos arquivos que precisam de consistência devem
resolver `.current` uma vez e ler daquele diretório. `orders.json` mantém os campos
anteriores e adiciona `deadline`, `deadlineEpoch` e `deadlineWarning`; `summary.json`
preserva seu formato. Não há alteração de autenticação ou sessão.

`orderTimeoutTime` numérico é Unix: valores positivos menores que 100000000000
são segundos; os demais são milissegundos. `deadlineEpoch` sempre usa milissegundos
UTC e `deadline` ISO UTC (`Z`). Texto brasileiro estrito `DD/MM/YYYY HH:mm` ou `YYYY-MM-DD HH:mm[:ss]`
(também separador `T` no formato ano-mês-dia)
é interpretado em `BUSINESS_TIMEZONE`, default `America/Sao_Paulo`, nunca na timezone
do host. Sem timestamp, esse texto válido pode fornecer o deadline. Formatos não
suportados, datas impossíveis e horários locais ambíguos/inexistentes por DST
resultam em deadline null. Se qualquer fonte presente for inválida, ou as fontes
discordarem no minuto, a política fail-safe é UNKNOWN com código sanitizado em
`deadlineWarning` e log sem dados brutos. Nenhum prazo é inventado. A timezone é
validada antes da sessão e também usada na apresentação do terminal.
A reconciliação aceita fontes no mesmo minuto e, somente para texto sem segundos,
epoch até 1 segundo antes do início do minuto textual (ex.: `22:35:59` e `22:36`).
Quando consistentes, o epoch original é preservado, inclusive segundos/milissegundos.
O parser valida os componentes e o calendário sem parsing implícito de strings por `Date`.

O instante de coleta é capturado uma vez ao iniciar `collect`, injetável como seu
terceiro argumento (epoch ms). `hoursRemaining = (deadlineEpoch - now) / 3600000`.
As funções puras estão em `apps/collector/src/operational.ts`.

| Prioridade | Horas restantes |
|---|---|
| OVERDUE | <= 0 (inclui o instante exato do vencimento) |
| CRITICAL | > 0 e <= 6 |
| URGENT | > 6 e <= 24 |
| ATTENTION | > 24 e <= 48 |
| NORMAL | > 48 |
| UNKNOWN | sem prazo confiável |

A fila segue essa ordem, depois deadline crescente; UNKNOWN fica no fim.
Estágio: TO_INVOICE > TO_SHIP > TO_PRINT > TO_PICKUP, sem remover queues.
A deduplicação global por `orderNumber` ocorre antes de calcular produção: um
pedido em várias queues soma unidades uma única vez. Metadados da última queue
continuam prevalecendo como na V0.2. Produtos agrupam por tupla productId/variationId;
se algum ID faltar, o fallback conservador é orderNumber + índice do item,
isolando itens sem identidade confiável (pode fragmentar a consolidação).
Nunca agrupamos só pelo nome. `orderCount` conta pedidos distintos do grupo.
Produtos ordenam por maior prioridade, prazo mais próximo e quantidade decrescente.

Todos os itens ativos representam **necessidade potencial de produção**. Estoque
não é considerado. O domínio separado permite incorporar futuramente
availableStock, reservedStock e productionRequired sem inventar valores agora.
O terminal mostra prioridades e até `OPERATIONAL_TOP_N` produtos (default 10;
inteiro >= 0), com prazo em horas e horário no fuso comercial.

Validação manual pendente na VPS: executar coleta real, comparar timestamps e
texto UpSeller com BUSINESS_TIMEZONE, conferir níveis/limites de prioridade,
quantidades e os quatro arquivos, além da execução Docker e sessão persistente.
A V0.3 não está certificada em produção por estes testes locais.

## V0.4 — mensagens locais (primeira metade)

Após `npm run collect`, execute `npm run notify:daily` para gerar o
`DAILY_SUMMARY` ou `npm run notify:check` para observar mudanças de prioridade.
Os comandos leem os snapshots V0.3, sem Playwright, nova coleta ou alteração
nos arquivos operacionais. O agendamento fica externo.

Defaults: `WHATSAPP_TOP_PRODUCTS=5`, `NOTIFICATION_BOOTSTRAP_MODE=silent`,
`NOTIFICATION_DRY_RUN=true` e `BUSINESS_TIMEZONE=America/Sao_Paulo`.
`DATA_DIR` seleciona o diretório (default `data`). Não há adapter WhatsApp,
URL, token ou destinatário nesta entrega. `NOTIFICATION_DRY_RUN=false` no CLI
falha fechado: ainda não existe sender configurado para envio real.

O resumo omite contagens zero, respeita a ordenação agregada da V0.3 e mostra
os primeiros produtos, os demais como `+ X outros itens na fila`, atraso mais
antigo em horas completas e próximo prazo futuro na timezone configurada.
As prioridades são as do snapshot; execute nova coleta para atualizá-las.
Somente nomes/variações de produtos, quantidades, prazos e contagens chegam às
mensagens. Identificadores de pedidos e campos pessoais não são exibidos.

Na primeira execução de `notify:check`, `data/notification-state.json` é
criado atomicamente com as prioridades atuais, sem alertas retroativos.
O arquivo é dado operacional local, ignorado pelo Git; não distribua um estado
preenchido entre instalações. Cada pedido registra `lastPriority` e
`lastAlertedPriority` (inicialmente `null`). Novos pedidos entram silenciosamente.
Escaladas para URGENT, CRITICAL e OVERDUE geram NEW_URGENT, NEW_CRITICAL e
NEW_OVERDUE, incluindo saltos de nível. Prioridade igual ou reduzida não alerta.
Pedidos ausentes são removidos do estado; reaparecimento recebe nova baseline.

Dry-run gera logs sanitizados e atualiza apenas a prioridade observada, evitando
repetir a mesma transição; não registra envio em `lastAlertedPriority`.
Assim, transições consumidas no dry-run não são reenviadas automaticamente por
um futuro provider. A futura ativação deverá estabelecer uma baseline explícita.
A interface `NotificationSender` permite implementar envio depois: somente o
sucesso de todo o lote permite persistir o estado. Falha mantém o arquivo anterior.
Uma falha após entrega parcial ou antes do rename pode repetir mensagens já
entregues na tentativa seguinte (não há garantia exactly-once).

A leitura fixa a geração `.current` do collector e valida schema, prioridades,
prazos, duplicatas e equivalência do summary com a agregação da fila. Dados
inválidos/ausentes/inconsistentes falham sem gerar mensagens ou atualizar estado.
Um lock exclusivo impede dois checks simultâneos. Se o processo for encerrado
abruptamente, confirme que não há check ativo antes de remover
`data/.notification.lock`. Não remova o estado para tentar novamente após falha.

Validação manual na VPS: coletar, executar daily em dry-run, executar check para
bootstrap e repetir check (sem alertas); após uma nova coleta com escalada,
conferir alerta e estado e repetir check para confirmar ausência de repetição.
Para desativar, interrompa o agendamento externo. Preserve o estado no rollback.
Esta entrega tem aceite local; não certifica V0.4 em produção.
