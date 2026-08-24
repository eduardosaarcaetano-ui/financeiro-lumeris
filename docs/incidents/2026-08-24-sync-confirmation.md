# Incidente de sincronização — 24/08/2026

## Situação

Usuários alteravam CRM e Rank de Vendas, viam mensagens de sincronização e sucesso, mas a revisão do servidor não avançava. A interface fechava os formulários logo depois de gravar no `localStorage`; ela não aguardava a confirmação da operação pelo backend.

Produção não foi alterada nesta correção. O trabalho permanece no ambiente desktop para homologação.

## Linha de base e rollback

- commit anterior: `9f64b75af3b59b147c8928722a182363c704eaf9`;
- tag de rollback: `backup/pre-sync-confirmation-fix-20260824`;
- a tag foi criada antes de qualquer alteração deste incidente;
- para desfazer com segurança, comparar primeiro o trabalho com a tag e restaurar os arquivos em uma nova branch/worktree. Não executar restauração destrutiva sobre alterações não copiadas.

## Causa confirmada

1. `persist()` confirmava somente a gravação local e agendava a requisição remota.
2. CRM e Rank fechavam/resetavam o formulário e mostravam sucesso imediatamente.
3. Um descarte de fila sem diferenças podia escrever “Sincronizado com a nuvem” sem uma requisição `POST` confirmada.
4. `app.js` e `styles.css` tinham cache imutável de um ano, aumentando o risco de computadores continuarem executando código antigo.

## Correção aplicada no desktop

- protocolo de sincronização avançado de 8 para 9;
- backend devolve recibo somente após a transação, contendo `committed`, `mutationId`, quantidade de operações, revisão e versão;
- frontend valida se o recibo pertence exatamente à mutação enviada;
- CRM e Rank aguardam a confirmação remota antes de fechar/resetar e declarar sucesso;
- em falha, dados e fila permanecem no navegador e a tela informa que a nuvem ainda não confirmou;
- ausência de mudança real agora informa “Nenhuma alteração nova para enviar”;
- cache crítico passou a revalidar; HTML inicial passou a usar `no-store`;
- versão visual avançada para 9.9.

## Arquivos alterados

| Arquivo | Motivo | Impacto |
| --- | --- | --- |
| `app.js` | espera, validação e estados de erro/sucesso | CRM e Rank só concluem após recibo remoto |
| `sync-confirmation.js` | validação isolada do recibo | rejeita confirmação ausente, incompleta ou de outra mutação |
| `api/sync.js` | resposta transacional identificável | fornece confirmação auditável ao cliente |
| `api/_lib/syncEngine.js` | protocolo 9 | bloqueia escritores antigos depois da publicação conjunta |
| `index.html` | versão 9.9 e carregamento do validador | força nova URL dos arquivos críticos |
| `vercel.json` | política de cache | reduz permanência de JavaScript antigo |
| `package.json` e `tests/*` | testes de regressão | mantém o contrato de sincronização verificável |

## Testes realizados

- `npm test`: aprovado (4 conjuntos de testes e contratos);
- `npm run check`: aprovado;
- `git diff --check`: aprovado;
- navegador Chrome headless com backend simulado:
  - sucesso: uma única requisição `POST`, revisão 31, fila zerada e nenhum erro de página;
  - espera de 2,5 segundos após a confirmação: nenhuma repetição de `POST`;
  - recibo de outra mutação: rejeitado, dado local mantido, outbox mantida e status de erro exibido.

## Verificação de recuperação local

Foi criada uma cópia somente para recuperação em:

`C:\Users\usuario\Documents\ERP-backups\browser-localstorage-20260824-incident`

Foram preservados os armazenamentos locais do Chrome (Default e Profile 1) e Edge (Default). Nos dois perfis Chrome, o estado local atual e a base remota armazenada têm 27 oportunidades e 32 lançamentos de ranking, sem diferenças de negócio e sem fila/outbox atual. Daniel Pataro e Rosita não aparecem nas cópias atuais. Portanto, os registros não podem ser restaurados a partir do estado local ativo deste computador; a próxima fonte de recuperação é a retenção `sync_state_backups` do banco, sempre por consulta e restauração isolada.

## Critério antes de produção

1. validar a versão 9.9 no desktop/homologação com uma oportunidade de teste e um lançamento de Rank;
2. conferir que outro navegador recebe os dois registros;
3. observar que cada ação gera apenas uma revisão e não inicia ciclo de gravação;
4. publicar frontend e backend juntos;
5. confirmar cabeçalhos de cache e protocolo 9 após a publicação;
6. manter a tag de rollback e não apagar a cópia de recuperação.
