# Validação — AXI-10

## Contrato confirmado pelo usuário em 2026-10-06
POST form-urlencoded, code === 0, data.list, data.total. Persistência autorizada
somente em perfil privado fora do projeto. Implementação anterior usava CDP e
encoding configurável; substituída por Chromium com perfil persistente e form.

## Evidência local
- TypeScript aprovado; 22 testes sintéticos aprovados.
- Proteção de perfil: rejeita caminho relativo, interno, symlink para projeto,
  permissões abertas e proprietário diferente.
- O usuário confirmou em 2026-10-07 que a sessão persistente foi testada na VPS. O agente não acessou a VPS.
- Docker/binário e socket indisponíveis neste ambiente.
- Nenhuma configuração SSH local encontrada; busca de conexão VPS SSH sem resultados.
- Nenhuma chamada autenticada real; nenhum total de produção certificado.
- Código JSON específico de sessão expirada não confirmado. HTTP 401/403,
  redirecionamento, HTML e JSON 401/403 geram AUTH_REQUIRED. Outros códigos falham
  de modo explícito e exigem documentação sanitizada antes de alterar o contrato.

## Aceite pendente
1. Operador executará deploy e aceite separadamente; o agente não acessará a VPS nesta etapa.
2. Reutilizar o perfil privado externo existente; renovar manualmente apenas se necessário.
3. Em período sem movimentação, comparar totais visíveis TO_INVOICE, TO_SHIP, TO_PRINT e TO_PICKUP
   com npm run collect e Docker; registrar somente horário e contagens.
4. Repetir após reiniciar navegador/container/VPS para verificar persistência.
5. Expirar sessão e confirmar AUTH_REQUIRED sem publicar novo snapshot.
6. Documentar divergências sem respostas brutas, HAR, segredos ou dados pessoais.

## Registro a preencher após execução real

| Evidência | Resultado |
| --- | --- |
| Data/hora e timezone | Pendente |
| Commit executado | Pendente |
| Docker build e coleta (código de saída) | Pendente |
| TO_INVOICE navegador / collector | Pendente |
| TO_SHIP navegador / collector | Pendente |
| TO_PRINT navegador / collector | Pendente |
| Não impressas / impressas | Pendente |
| TO_PICKUP navegador / collector | Pendente |
| Pedidos únicos / unidades | Pendente |
| Persistência após reinício | Pendente |
| Sessão expirada retorna AUTH_REQUIRED | Pendente |

Registrar somente contagens e códigos sanitizados. Não anexar dados de pedidos ou sessão.

## Referência de aceite V0.2

Referência fornecida pelo usuário: TO_INVOICE=4, TO_SHIP=1, TO_PRINT=3,
TO_PICKUP=0; não impressas=1, impressas=2. Não são valores fixos de teste:
comparar collector e painel no mesmo momento. Aceite V0.2 em produção pendente.
Os 9 testes anteriores foram preservados (fixtures adaptadas para quatro filas),
com 13 novos testes: payloads, paginação dos quatro perfis, agregação global,
impressão, conflitos e filas vazias. Nenhuma coleta real foi executada pelo agente.
Dockerfile revisado: copia apenas manifests e apps, sem perfil na imagem;
Compose monta o perfil externo em /private/upseller-profile, sem portas públicas.
