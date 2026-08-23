# Gate para criação da homologação

## Situação atual

O projeto Vercel de produção também disponibiliza as credenciais Neon ao ambiente Preview. Para impedir uso acidental do banco real, o código do Preview aceita exclusivamente `HOMOLOGATION_DATABASE_URL` e falha de forma fechada quando ela não existe.

Em 23/08/2026 foi criada no Neon a branch `homologacao`, filha da `main`, sem exclusão automática. A credencial própria foi conectada à Vercel como variável sensível, limitada ao ambiente `Preview` e à branch Git `staging`. O Preview exige autenticação da Vercel e também mantém o login do ERP.

Essa conexão permite validações técnicas sem acesso ao banco produtivo, mas não libera testes com gravação enquanto storage, usuários e integrações externas não estiverem isolados ou desabilitados.

## Topologia recomendada

| Componente | Produção | Homologação |
| --- | --- | --- |
| Vercel | `erp-lumeris` | Preview protegido da branch `staging`; projeto separado continua sendo o alvo futuro |
| Branch Git | `main` | `staging` |
| Neon | banco atual | projeto ou branch isolada |
| Storage | atual | storage exclusivo |
| Usuários | reais | usuários de teste |
| Integrações | habilitadas conforme operação | desabilitadas ou sandbox |
| Domínio | `erp-lumeris.vercel.app` | domínio exclusivo de homologação |

## Condições anteriores ao provisionamento

- [ ] Backup lógico/físico do Neon restaurado com sucesso.
- [x] Branch de homologação criada com credencial própria.
- [ ] Dados pessoais removidos ou acesso fortemente restrito.
- [x] Variável de banco separada por ambiente e branch.
- [ ] Integrações externas configuradas como sandbox ou desligadas.
- [ ] Identidade visual de homologação configurada.
- [ ] Publicação automática em produção revisada.
- [ ] Plano de rollback documentado.

## Evidências de isolamento já verificadas

- Deploy Preview: `7gmdLyJSzKR5pokr9gzZHWzhVJnt`, branch `staging`, status `Ready`.
- URL técnica: `https://erp-lumeris-aqtp1dnza-lumeris-1b76.vercel.app`.
- Acesso sem sessão ao Preview e a `/api/sync`: redirecionamento HTTP 302 para autenticação da Vercel.
- Produção: `https://erp-lumeris.vercel.app`, HTTP 200, branch `main` e versão 9.8 sem alteração.

O endereço técnico pode mudar em novos deploys. A identificação confiável é a combinação de ambiente `Preview`, branch `staging` e variável sensível restrita à branch.

## Regra de publicação

Nenhum commit de arquitetura deve ir diretamente da máquina para produção. A sequência será:

`branch de trabalho → revisão → homologação → testes → aprovação → main → produção`

Alterações de banco usarão migrações compatíveis para frente e para trás sempre que tecnicamente possível.
