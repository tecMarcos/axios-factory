# Validação — AXI-10

## Contrato confirmado pelo usuário em 2026-10-06
POST form-urlencoded, code === 0, data.list, data.total. Persistência autorizada
somente em perfil privado fora do projeto. Implementação anterior usava CDP e
encoding configurável; substituída por Chromium com perfil persistente e form.

## Evidência local
- TypeScript aprovado; 9 testes sintéticos aprovados.
- Proteção de perfil: rejeita caminho relativo, interno, symlink para projeto,
  permissões abertas e proprietário diferente.
- O perfil não foi criado nem autenticado em produção.
- Docker/binário e socket indisponíveis neste ambiente.
- Nenhuma configuração SSH local encontrada; busca de conexão VPS SSH sem resultados.
- Nenhuma chamada autenticada real; nenhum total de produção certificado.
- Código JSON específico de sessão expirada não confirmado. HTTP 401/403,
  redirecionamento, HTML e JSON 401/403 geram AUTH_REQUIRED. Outros códigos falham
  de modo explícito e exigem documentação sanitizada antes de alterar o contrato.

## Aceite pendente
1. Disponibilizar terminal/conexão segura autorizada ao host Ubuntu com Docker.
2. Provisionar perfil privado e fazer login manual na sessão gráfica privada.
3. Em período sem movimentação, comparar totais visíveis TO_SHIP e TO_PICKUP
   com npm run collect e Docker; registrar somente horário e contagens.
4. Repetir após reiniciar navegador/container/VPS para verificar persistência.
5. Expirar sessão e confirmar AUTH_REQUIRED sem publicar novo snapshot.
6. Documentar divergências sem respostas brutas, HAR, segredos ou dados pessoais.
