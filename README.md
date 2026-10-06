# UpSeller Collector V0.1

Node.js + TypeScript + Playwright. Coleta TO_SHIP e TO_PICKUP por POST em
`https://app.upseller.com/api/order/index`, pagina com 50 pedidos, deduplica por
`orderNumber` e produz `data/orders.json` e `data/summary.json`.

**Estado:** implementação local testada; contrato externo e aceite na VPS pendentes.
Não há amostra do envelope JSON nem sessão autenticada disponível neste ambiente.
Os caminhos em `.env.example` são exemplos, não campos confirmados do UpSeller.

## Executar

Requer Node.js 24, Linux e um Chromium já autenticado no UpSeller, com uma aba
aberta em `https://app.upseller.com` e CDP acessível somente em loopback/rede privada.
O collector conecta ao contexto existente usando Playwright; não inicia login,
exporta cookies ou grava `storageState`. Não exponha CDP à internet.

```sh
npm ci
cp .env.example .env
# Confirmar ORDERS_PATH, TOTAL_PATH, SUCCESS_PATH, SUCCESS_VALUE e REQUEST_ENCODING.
npm run collect
```

`SUCCESS_VALUE` é um literal JSON (ex.: `0`, `true` ou `"OK"`). Os caminhos usam
notação pontuada. `REQUEST_ENCODING` aceita `json` ou `form`. O primeiro POST
bem-sucedido, com indicador de sucesso e estrutura válidos, valida a autenticação
e também coleta a primeira página. Não existe endpoint de autenticação presumido.
Se a API exigir cabeçalhos adicionais/CSRF, a execução falha: documentar o contrato
antes de acrescentar suporte. Não inserir tokens no `.env`.

**Persistência:** o processo reutiliza a sessão do navegador entre coletas enquanto
esse navegador permanece autenticado. Persistência após reiniciar o navegador
normalmente exige guardar cookies/perfil. Como o escopo proíbe esse armazenamento,
o collector não cria um perfil persistente; essa decisão precisa ser esclarecida
antes de implementar login persistente próprio. Não compartilhar cookies, tokens,
HAR ou respostas brutas na tarefa.

## Saídas e proteção de dados

Somente os campos de pedido e item listados na tarefa entram nos arquivos. Campos
extras são descartados, inclusive campos extras dentro dos itens. Objetos em
campos escalares são rejeitados. Datas e preços são preservados como texto, sem
supor timezone/moeda; contagens são inteiros não negativos. Campos opcionais
ausentes viram `null`. Valores de campos permitidos não passam por classificação
semântica de PII; não devem conter dados de comprador inseridos livremente.

Pedidos repetidos entre perfis contam uma vez nas unidades; TO_PICKUP prevalece
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

O navegador autenticado é externo ao container; nenhuma imagem de navegador ou
volume de credenciais é criado. O CDP em `127.0.0.1:9222` é acessível pelo modo
host do Compose. O usuário `node` (UID 1000) precisa poder escrever em `data/`.

```sh
mkdir -p data
# Ajustar proprietário/permissões de data para UID 1000 no host, se necessário.
docker compose build
docker compose run --rm collector
```

## Verificar

```sh
npm run typecheck
npm test
```

Testes usam dados sintéticos: paginação, deduplicação, totais, privacidade,
autenticação inválida, limites e publicação de arquivos. Docker não foi executado
neste ambiente porque o binário não está instalado. Ver [validação](docs/validation.md).

Referências de implementação: [Playwright CDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
e [APIRequestContext](https://playwright.dev/docs/api/class-apirequestcontext).
