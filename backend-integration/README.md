# Backend local de integracao bancaria

Este backend roda no seu computador e serve como ponte segura entre o ERP Lumeris e a API do Banco Inter.

O ERP esta publicado em GitHub Pages, entao ele nao pode guardar `client_secret`, certificado ou chave privada. Por isso a conexao real com o banco precisa passar por um backend local ou hospedado em servidor privado.

## Como testar com Banco Inter

1. Copie o arquivo de exemplo:

```powershell
Copy-Item .env.example .env
```

2. Edite o arquivo `.env` e preencha:

- `INTER_CLIENT_ID`
- `INTER_CLIENT_SECRET`
- `INTER_CERT_PATH` e `INTER_KEY_PATH`, ou `INTER_PFX_PATH`
- `INTER_CA_PATH`, se o Inter fornecer um arquivo de CA separado
- `INTER_CONTA_CORRENTE`, se o Inter exigir o header da conta

3. Rode o backend:

```powershell
node server.js
```

4. Confira se esta funcionando:

```powershell
Invoke-RestMethod http://localhost:8787/health
```

5. No ERP, abra:

`Financeiro > APIs Bancarias`

6. Cadastre a conta do Banco Inter usando:

```text
URL do backend: http://localhost:8787
Banco: Banco Inter
Conta: selecione a conta cadastrada no ERP
```

7. Clique em `Salvar configuracao` e depois em `Sincronizar agora`.

## Contrato usado pelo ERP

O ERP chama:

```http
POST http://localhost:8787/inter/extrato
```

Com corpo:

```json
{
  "accountId": "numero-da-conta",
  "bankId": "077",
  "start": "2026-07-01",
  "end": "2026-07-11"
}
```

O backend responde:

```json
{
  "ok": true,
  "movements": [
    {
      "fitid": "id-unico-do-banco",
      "date": "2026-07-10",
      "description": "PIX RECEBIDO",
      "amount": 100,
      "type": "entrada",
      "documentNumber": "123"
    }
  ]
}
```

## Observacoes importantes

- Nunca coloque dados reais no GitHub.
- O arquivo `.env` esta ignorado pelo Git.
- Certificados `.crt`, `.key`, `.pem`, `.pfx` e `.p12` tambem devem ficar fora do repositorio.
- Se o Inter alterar o caminho do endpoint de extrato, ajuste `INTER_EXTRATO_PATH` no `.env`.
- Para usar em varios computadores/usuarios, depois substituimos `localhost` por uma URL hospedada em servidor seguro.

## Rotas disponiveis

```text
GET  /health
POST /inter/extrato
POST /santander/extrato  (reservada, ainda nao implementada)
```
