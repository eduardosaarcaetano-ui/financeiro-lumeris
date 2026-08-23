# Gate para criação da homologação

## Situação atual

O projeto Vercel de produção também disponibiliza as credenciais Neon ao ambiente Preview. Por isso, uma branch Preview não é uma homologação isolada e não deve ser usada para testes com gravação.

Em 23/08/2026 foi criada no Neon a branch `homologacao`, filha da `main`, sem exclusão automática. Ela ainda não está conectada à Vercel. A conexão somente poderá ocorrer com credencial exclusiva e proteção contra acesso público.

## Topologia recomendada

| Componente | Produção | Homologação |
| --- | --- | --- |
| Vercel | `erp-lumeris` | projeto separado |
| Branch Git | `main` | `staging` |
| Neon | banco atual | projeto ou branch isolada |
| Storage | atual | storage exclusivo |
| Usuários | reais | usuários de teste |
| Integrações | habilitadas conforme operação | desabilitadas ou sandbox |
| Domínio | `erp-lumeris.vercel.app` | domínio exclusivo de homologação |

## Condições anteriores ao provisionamento

- [ ] Backup lógico/físico do Neon restaurado com sucesso.
- [x] Branch de homologação criada com credencial própria e sem conexão com a Vercel.
- [ ] Dados pessoais removidos ou acesso fortemente restrito.
- [ ] Variáveis Vercel separadas por ambiente.
- [ ] Integrações externas configuradas como sandbox ou desligadas.
- [ ] Identidade visual de homologação configurada.
- [ ] Publicação automática em produção revisada.
- [ ] Plano de rollback documentado.

## Regra de publicação

Nenhum commit de arquitetura deve ir diretamente da máquina para produção. A sequência será:

`branch de trabalho → revisão → homologação → testes → aprovação → main → produção`

Alterações de banco usarão migrações compatíveis para frente e para trás sempre que tecnicamente possível.
