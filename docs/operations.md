# Instalação e operação — Ubuntu / Docker

Estado: implementação local testada; imagem Docker e integração real ainda não
validadas. Deploy e aceite serão executados separadamente pelo operador.

## Preparar o host

Pré-requisitos: Git, Docker Engine com plugin Compose, Node.js 24/npm e uma sessão
gráfica privada para o login manual. Confirme `docker version`,
`docker compose version`, `node --version` e `npm --version`. O acesso ao Docker
deve estar autorizado. Não publique navegador, VNC ou porta de depuração.

```sh
git clone https://github.com/tecMarcos/axios-factory.git
cd axios-factory
cp .env.example .env
npm ci
npx playwright install --with-deps chromium
```

O Compose usa UID/GID 1000. Execute o login com o usuário local de UID 1000
(confirme com `id -u`); não use root. Se não houver esse usuário disponível,
provisione um usuário dedicado ou adapte explicitamente o UID da imagem e as
permissões antes de continuar. Não use permissões 0777.

```sh
sudo install -d -m 0700 -o 1000 -g 1000 /opt/axios-factory-runtime/upseller-profile
sudo install -d -m 0700 -o 1000 -g 1000 data
```

## Autenticação manual

Na sessão gráfica privada do mesmo host, como UID 1000, dentro do checkout:

```sh
npm run login
```

Conclua login e eventual CAPTCHA/MFA no Chromium, depois pressione Enter no
terminal. Isso fecha o navegador e persiste o perfil privado. Não copie cookies,
tokens ou credenciais para `.env`. O perfil fica fora do checkout e não deve
entrar em backups públicos, ZIPs ou artefatos.

O console textual da VPS, sozinho, não fornece interface gráfica. Se não houver
sessão gráfica privada autorizada, interrompa esta etapa até ela ser preparada.
A autenticação inicial não é automatizada pelo Compose. A instalação npm e a
imagem usam a mesma versão Playwright fixada no lockfile. Feche o navegador de
login antes de iniciar a coleta; não abra dois processos com o mesmo perfil.

## Construir e coletar

```sh
docker compose build
docker compose run --rm collector
```

O container executa `npm run collect`, valida autenticação no primeiro POST,
coleta os quatro perfis, pagina, deduplica, normaliza e publica:

- `data/orders.json`: pedidos com campos permitidos.
- `data/summary.json`: totais por perfil, pedidos únicos, unidades e produtos.

Resumo legível em stdout; logs JSON sanitizados em stderr. Código de saída 0
indica coleta concluída, 1 indica falha. Após erro, arquivos anteriores podem
continuar presentes: não os interprete como resultado da tentativa que falhou.

Alternativa no host, com mesmo usuário e perfil: `npm run collect`.
O Compose é um job pontual e não agenda coletas. Depois de reiniciar o host,
execute novamente o comando de coleta; o perfil permanece no bind mount.

## Falhas e recuperação

- `AUTH_REQUIRED`: repita o login manual e depois a coleta.
- `PROFILE_PERMISSIONS_REQUIRED`: confira proprietário UID 1000 e modo 0700.
- `PROFILE_MUST_BE_EXTERNAL`: use caminho absoluto fora do repositório.
- Perfil em uso: encerre normalmente o login/coleta anterior e tente novamente.
- Erro de contrato, paginação ou divergência: registre somente código e contagens;
  não capture respostas brutas, HAR, cookies ou dados de comprador. Documente a
  diferença antes de modificar o collector.

Não apague o perfil para atualizar o código. Para reverter uma alteração, use o
commit anterior conhecido, rode `npm ci` e reconstrua a imagem. Snapshots antigos
em `data/` podem ser removidos quando nenhum leitor os utiliza; preserve o destino
do link `.current`. Nunca publique esse diretório.

## Aceite real (pendente)

Em período sem movimentação de pedidos, registre data/hora e timezone, commit,
totais TO_INVOICE/TO_SHIP/TO_PRINT/TO_PICKUP e subdivisões de impressão visíveis no UpSeller e no collector, pedidos únicos e
unidades. Repita após reinício para conferir persistência e teste sessão expirada
para confirmar `AUTH_REQUIRED` sem novo snapshot. Não envie orders.json nem
capturas que mostrem dados pessoais. Use [o registro de validação](validation.md).
Somente os resultados reais permitirão certificar a integração em produção.
