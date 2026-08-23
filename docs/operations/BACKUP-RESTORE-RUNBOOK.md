# Runbook de backup e restauração

## Objetivo

Permitir recuperação verificável do código e dos dados do ERP antes de qualquer migração.

## Tipos de cópia

### 1. Código

Criar um `git bundle --all`, calcular SHA-256 e restaurar o bundle em uma pasta vazia. O commit restaurado deve ser idêntico ao commit registrado no manifesto.

### 2. Estado da aplicação

Exportar uma única vez o estado atual da aplicação, armazenar fora do repositório, calcular SHA-256 e validar o JSON e as contagens por coleção.

Essa exportação não inclui necessariamente todo o histórico técnico do banco.

### 3. PostgreSQL/Neon

Usar uma conexão não produtiva e ferramenta compatível com `pg_dump` para incluir:

- estrutura;
- dados;
- sequências;
- `sync_state`;
- `sync_mutations`;
- `sync_state_backups`.

O dump deve ser restaurado em banco isolado. Nunca testar restauração sobre produção.

### 4. Documentos

Guardar separadamente os arquivos do storage e um inventário com identificador, nome, tamanho, MIME, checksum e vínculo com o ERP.

## Critérios de aprovação

Um backup somente é considerado válido quando:

- possui data, origem, commit e versão;
- possui hash SHA-256;
- pode ser lido sem erro;
- foi restaurado em ambiente isolado;
- preserva as contagens esperadas;
- preserva totais financeiros e relacionamentos;
- possui acesso restrito;
- existe em pelo menos dois locais independentes.

## Restauração segura

1. Declarar incidente e interromper novas publicações.
2. Registrar commit, versão, horário e sintoma.
3. Criar banco isolado.
4. Restaurar o dump no banco isolado.
5. Executar verificações de integridade e totais.
6. Apontar uma homologação para o banco restaurado.
7. Executar testes de login, CRM, vendas, financeiro, projetos, protocolos, instalações e estoque.
8. Somente após aprovação definir a estratégia de recuperação da produção.

## RPO e RTO propostos

- RPO inicial: no máximo 24 horas.
- RTO inicial: no máximo 4 horas após confirmação do incidente.

Esses valores devem ser aprovados pela direção e revisados quando integrações bancárias e NFS-e entrarem em produção.

## Restrições

- Não armazenar backup dentro do repositório.
- Não incluir credenciais no manifesto.
- Não usar banco de produção para ensaios.
- Não enviar cópia com dados reais para serviços externos sem criptografia e autorização específica.
- Não considerar snapshots no mesmo banco como única estratégia de recuperação.
