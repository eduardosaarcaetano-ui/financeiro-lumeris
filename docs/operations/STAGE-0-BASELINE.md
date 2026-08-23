# Etapa 0 — linha de base e contenção

Data do levantamento: 23/08/2026

## Escopo

Esta etapa registra o estado atual e os requisitos mínimos para iniciar a evolução do ERP sem alterar dados ou configuração de produção.

## Estado confirmado

- Repositório: `eduardosaarcaetano-ui/financeiro-lumeris`.
- Branch de produção: `main`.
- Commit da linha de base: `2f3154bd8bcb4df2dfdaa4e82ba9f60d67e150d8`.
- Versão visível: 9.8.
- Projeto Vercel: `erp-lumeris` no plano Hobby.
- Banco: Neon, plano Launch, conectado ao projeto Vercel.
- PostgreSQL 17. A branch produtiva é `main`.
- Janela de recuperação por histórico: 6 horas.
- Snapshot manual da `main` criado em 23/08/2026 às 23:12:44 UTC, sem expiração.
- Branch Neon `homologacao` criada como filha da `main`, sem exclusão automática e com credencial própria.
- Branch Git `staging` publicada somente como Preview protegido da Vercel.
- A variável sensível `HOMOLOGATION_DATABASE_URL` está limitada a `Preview` e à branch `staging`.
- O código do Preview falha de forma fechada: não aceita as variáveis de banco produtivas quando a variável exclusiva de homologação não existe.
- Não existe agendamento automático de snapshots.
- Não existia ambiente formal de homologação antes desta etapa. O Preview protegido criado agora ainda não está liberado para testes com gravação.
- Os deployments recentes estão classificados como Production e são originados da `main`.
- As variáveis Neon estão habilitadas simultaneamente para Production e Preview.

## Trava de segurança para homologação

Não criar nem usar Preview da Vercel enquanto as variáveis de Preview apontarem para o Neon de produção. A homologação somente pode ser liberada quando possuir:

1. projeto Vercel separado ou variáveis Preview isoladas;
2. banco Neon separado, sem permissão de escrita em produção;
3. credenciais e storage exclusivos;
4. usuários de teste sem senhas reais;
5. indicador visual permanente `HOMOLOGAÇÃO`;
6. bloqueio de e-mails, NFS-e, bancos, contratos e webhooks reais;
7. procedimento de reconstrução do ambiente.

## Inventário resumido da produção

A exportação de 23/08/2026 foi validada como JSON e continha, entre outras coleções:

| Coleção | Registros |
| --- | ---: |
| Pessoas | 1.065 |
| Itens de estoque | 613 |
| Movimentos bancários | 242 |
| Histórico de protocolos | 225 |
| Projetos | 187 |
| Transações financeiras | 171 |
| Protocolos | 159 |
| Histórico de oportunidades | 52 |
| Instalações | 40 |
| Ranking de vendas | 32 |
| Oportunidades | 27 |
| Usuários | 9 |

Essas quantidades são uma fotografia de controle, não regras de negócio. A validação futura deve comparar também valores financeiros e vínculos.

## APIs existentes

- `/api/sync`
- `/api/admin/reconcile-attachments`
- `/api/bank/health`
- `/api/bank/inter`
- `/api/bank/receita`
- `/api/bank/santander`

As proteções dessas rotas pertencem à Etapa 1. Nenhuma alteração de segurança foi aplicada nesta etapa.

## Backups internos existentes

O banco atual mantém as tabelas `sync_state`, `sync_mutations` e `sync_state_backups`. Os snapshots internos ficam no mesmo banco e não substituem backup externo nem teste de restauração.

## Linha de base local criada

A cópia local foi armazenada fora do repositório em:

`C:\Users\usuario\Documents\ERP-Lumeris-Backups\stage0-20260823-200203`

Ela contém:

- histórico Git completo em bundle;
- exportação do estado atual da aplicação;
- clone isolado usado para verificar a restauração do código.

A exportação contém dados pessoais e financeiros e deve ser tratada como confidencial. Não deve ser enviada ao Git, anexada a chamados ou compartilhada sem criptografia e autorização.

## Validações concluídas

- repositório original sem mudanças pendentes antes da cópia;
- resposta HTTP 200 na exportação;
- JSON válido;
- hash SHA-256 calculado;
- bundle Git íntegro;
- histórico Git completo;
- restauração isolada no mesmo commit da origem.
- Preview da branch `staging` recompilado após a inclusão da credencial exclusiva;
- acesso anônimo ao Preview e a `/api/sync` redirecionado para autenticação da Vercel;
- acesso autenticado ao Preview chegou somente à tela de login do ERP;
- produção permaneceu na branch `main`, commit `2f3154bd8bcb4df2dfdaa4e82ba9f60d67e150d8`, versão 9.8 e respondeu HTTP 200;
- resolução de conexão testada para garantir que Preview nunca utilize a URL produtiva.

## Pendências para encerrar completamente a Etapa 0

- obter backup lógico ou físico do Neon, incluindo `sync_mutations` e `sync_state_backups`;
- testar esse backup em banco PostgreSQL isolado;
- criar uma cópia externa criptografada;
- isolar storage, usuários e integrações externas antes de permitir testes com gravação na homologação;
- ampliar ou compensar a janela Neon de 6 horas com backup externo e retenção aprovada;
- definir responsáveis pela aprovação de produção.

Nenhuma dessas pendências autoriza acesso ou alteração direta em produção.
