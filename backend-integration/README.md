# Backend de integração bancária (Inter / Santander)

Este diretório é um **esqueleto de referência**, não é publicado no GitHub Pages e não roda
sozinho no site estático. Ele existe para documentar o contrato que o campo "URL do backend
de integração" (tela Banco > Contas conectadas > Sincronizar extrato) espera, e para servir de
ponto de partida quando você tiver as credenciais/certificado reais do Inter e do Santander.

## Por que precisa de um backend separado

O `app.js` do sistema roda 100% no navegador de quem usa (GitHub Pages é hospedagem estática).
Um site assim **não tem onde guardar segredo com segurança** e **não consegue apresentar
certificado cliente (mTLS)** — e a API do Banco Inter exige mTLS em toda chamada. Por isso,
"conectar de verdade" exige um servidor à parte (rodando em algum lugar seu: uma VPS, um
serviço de nuvem que suporte certificados, etc.) que guarda o certificado/segredos e conversa
com o banco por trás. O frontend só chama esse backend, nunca o banco diretamente.

## Contrato esperado pelo frontend

Para cada banco, o frontend faz:

```
POST {syncEndpoint}/inter/extrato
POST {syncEndpoint}/santander/extrato
Content-Type: text/plain (corpo é JSON serializado, para evitar preflight de CORS)

{ "accountId": "...", "bankId": "077", "start": "2026-06-01", "end": "2026-07-01" }
```

Resposta esperada:

```json
{
  "ok": true,
  "movements": [
    {
      "fitid": "identificador único do banco para essa transação",
      "date": "2026-06-15",
      "description": "Pix recebido - Fulano",
      "amount": 150.5,
      "type": "entrada",
      "documentNumber": "opcional"
    }
  ]
}
```

Em caso de erro: `{ "ok": false, "error": "mensagem para mostrar ao usuário" }`.

O `fitid` é o identificador único que o banco atribui à transação — é ele que garante que o
mesmo lançamento não seja importado duas vezes, então **sempre inclua o identificador real
que o banco retornar**, nunca um valor gerado por você.

## Estrutura sugerida

```
backend-integration/
  .env.example       # variáveis sensíveis (nunca commitar o .env real)
  server.example.js  # servidor Express mínimo, só como referência
  providers/
    inter.js         # adaptador do Banco Inter (mTLS + OAuth2)
    santander.js      # adaptador do Santander (OAuth2)
```

Cada arquivo em `providers/` é isolado por banco — para adicionar um banco novo no futuro,
basta criar `providers/novo-banco.js` com a mesma assinatura (`fetchStatement(accountId, start, end)`)
e uma nova rota `POST /novo-banco/extrato`, sem tocar nos outros.

## Antes de usar de verdade

- Baixe o certificado cliente e as credenciais no portal de desenvolvedores do Inter/Santander.
- Nunca coloque o certificado, a chave privada ou os segredos dentro deste repositório do site
  (`financeiro-lumeris`) — eles devem existir só no servidor do backend, fora do controle de
  versão público, referenciados via `.env`.
- Habilite CORS no backend apenas para o domínio do GitHub Pages
  (`https://eduardosaarcaetano-ui.github.io`), não para "qualquer origem".
