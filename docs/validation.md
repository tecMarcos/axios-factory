# Validação e pendências — AXI-10

## Evidência local

- Repositório inicialmente vazio; implementação criada do zero.
- TypeScript: `npm run typecheck` passou.
- `npm test`: 8 testes passaram, todos com dados sintéticos.
- Docker indisponível neste ambiente; build e execução não verificados.
- Busca de conexão UpSeller não encontrou conexão disponível para este agente.
- Nenhuma chamada autenticada real ao UpSeller foi executada.

## Contrato ainda não observado

O pedido confirma filtros e campos internos, mas não especifica envelope, total,
indicador de sucesso, código de sessão expirada ou codificação do POST. Esses
valores devem ser confirmados antes da coleta real. Não inferimos que respostas
inesperadas são listas vazias. Não há fallback para envelopes desconhecidos.

A proibição de guardar cookies conflita com um perfil Playwright persistente
próprio. Implementado apenas reuso de navegador autenticado externo via CDP,
sem exportação de estado. Persistência após reinício permanece pendente de decisão.

## Aceite na VPS (pendente)

1. Confirmar contrato usando apenas nomes/tipos de campos e códigos sem dados reais.
2. Disponibilizar acesso autorizado ao navegador autenticado na VPS via conexão
   segura; não enviar credenciais nem cookies na tarefa.
3. Preencher `.env` com contrato observado e endpoint CDP privado.
4. Em período sem movimentação, anotar totais visíveis TO_SHIP e TO_PICKUP.
5. Rodar `npm run collect`; comparar totais por perfil, pedidos únicos, unidades
   e produtos. Registrar horário, contagens esperadas/obtidas e resultado.
6. Repetir via Docker; confirmar mesma saída. Simular sessão expirada e verificar
   saída não zero sem substituir snapshot anterior nem registrar dados sensíveis.
7. Qualquer divergência: registrar somente evidência sanitizada antes de alterar
   o contrato. Não salvar resposta bruta, screenshot com compradores ou HAR.

Nenhum total de produção foi certificado. PostgreSQL, dashboard, NFC, estoque,
Hermes, WhatsApp, IA e fila de impressão não fazem parte desta entrega.
