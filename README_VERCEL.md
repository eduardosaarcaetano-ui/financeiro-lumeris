# Backend na Vercel (Postgres) + anexos no Google Drive

O ERP passou a usar a Vercel para hospedar o front-end estático (`index.html`,
`app.js`, `styles.css`) e as funções serverless em `api/` que fazem a
sincronização geral de dados (Postgres) e a integração bancária. Os **anexos
do CRM continuam indo para o Google Drive via Apps Script**, em qualquer host
— ver seção "Anexos do CRM" abaixo. O Apps Script (`AppsScript_Code.gs`) e o
GitHub Pages ficam também como referência/rollback do backend antigo — veja
[README_GITHUB_PAGES.md](README_GITHUB_PAGES.md).

## Configuração inicial (uma vez)

1. **Importar o repositório na Vercel** (`vercel.com/new`), preset "Other" — o
   projeto não tem build step, é HTML/JS estático na raiz + funções em `api/`.
2. **Storage → Create Database → Postgres (Neon)**, conectar ao projeto. Isso
   injeta `POSTGRES_URL` (pooled) e `POSTGRES_URL_NON_POOLING` nas env vars
   (ou variantes com prefixo customizado — `api/_lib/db.js` reconhece qualquer
   uma delas).
3. As tabelas (`sync_state`, `sync_mutations`, `sync_state_backups`) são
   criadas automaticamente na primeira chamada a `api/sync.js` (ver
   `api/_lib/db.js` → `ensureSchema`). Não precisa rodar migração manual, exceto
   para trazer os dados que já existiam no Apps Script (ver seção de corte
   abaixo).

## Integração bancária (Banco Inter / Receita Federal) — opcional

Se for usar a sincronização automática de extrato do Banco Inter (ou, no
futuro, notas fiscais pela Receita Federal), preencha estas env vars no
projeto Vercel (Settings → Environment Variables). São as mesmas do
`backend-integration/.env.example`, só sem o sufixo `_PATH` — aqui o conteúdo
do certificado entra direto na env var (a Vercel não tem sistema de arquivos
persistente para apontar um caminho):

- `INTER_CLIENT_ID`, `INTER_CLIENT_SECRET`
- `INTER_CERT` e `INTER_KEY` — conteúdo PEM do certificado/chave, colado direto
  (ou `INTER_PFX_BASE64` + `INTER_CERT_PASSPHRASE` se o Inter fornecer PFX/P12)
- `INTER_CA` — opcional, cadeia extra fornecida pelo banco
- `INTER_CONTA_CORRENTE` — opcional, mesma regra do backend local
- Demais opcionais (`INTER_BASE_URL`, `INTER_EXTRATO_PATH`, etc.) — normalmente
  não precisam mudar
- `RECEITA_CNPJ`, `RECEITA_CERT`/`RECEITA_KEY` (ou `RECEITA_PFX_BASE64`),
  `RECEITA_CERT_PASSWORD` — mesma ideia (a consulta em si ainda não está
  implementada, só a validação de configuração)

Depois de configurar, na tela **Financeiro > APIs Bancárias** do ERP, use como
"URL do backend" a própria URL do app na Vercel (ex.:
`https://erp-lumeris.vercel.app/api/bank`) — não mais `http://localhost:8787`.

Para testar localmente com certificado em arquivo (sem publicar nada), o
backend antigo em `backend-integration/` continua funcionando do jeito que
sempre funcionou — ver `backend-integration/README.md`.

## Corte de produção (migrar os dados que já existem no Apps Script)

Se o Apps Script ainda tem dados de produção que precisam ir para o Postgres
novo, faça isso **uma única vez**, com o app em modo de manutenção (para
congelar novas escritas enquanto migra):

```powershell
node tools/migrate_from_apps_script.js "https://script.google.com/macros/s/SEU_ID/exec" "POSTGRES_URL_DA_VERCEL"
```

O script lê o JSON completo do Apps Script e grava como o estado inicial do
`sync_state` no Postgres. Ele se recusa a rodar se `sync_state` já tiver
`revision > 0` (proteção contra sobrescrever dados que já estão em uso pelo
backend novo). Depois de migrar, publique o app com `SHEETS_ENDPOINT =
"/api/sync"` (já é o padrão em `app.js`) e desative o modo de manutenção.

## Anexos do CRM

Os anexos de oportunidades continuam indo para o Google Drive, através do
mesmo Apps Script (`crm.createLeadFolder`/`crm.uploadLeadFile`) — em
`app.js`, a constante `ATTACHMENTS_ENDPOINT` aponta sempre para a URL do Apps
Script, em qualquer host (Vercel ou GitHub Pages). Só a sincronização geral
dos dados (`SHEETS_ENDPOINT`) mudou para o backend novo. Isso mantém o limite
de ~9 MB por arquivo que já existia (limite de corpo de requisição do Apps
Script) e a necessidade do Apps Script continuar publicado.
