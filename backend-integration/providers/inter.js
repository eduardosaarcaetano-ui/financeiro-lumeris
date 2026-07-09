// Adaptador do Banco Inter. Referência/esqueleto — confira sempre a documentação oficial
// atual do Inter (portal developers.bancointer.com.br) para o endpoint e formato exatos,
// pois APIs de banco mudam com frequência e este arquivo não deve ser tratado como fonte
// definitiva desses detalhes.
//
// A API do Inter exige mTLS (certificado cliente) em toda chamada, inclusive na obtenção
// do token OAuth2. O cliente HTTP abaixo usa um https.Agent com o certificado/chave lidos
// do caminho definido em INTER_CERT_PATH / INTER_KEY_PATH (variáveis de ambiente).

const fs = require("fs");
const https = require("https");

function buildAgent() {
  return new https.Agent({
    cert: fs.readFileSync(process.env.INTER_CERT_PATH),
    key: fs.readFileSync(process.env.INTER_KEY_PATH),
  });
}

async function getAccessToken() {
  const agent = buildAgent();
  const body = new URLSearchParams({
    client_id: process.env.INTER_CLIENT_ID,
    client_secret: process.env.INTER_CLIENT_SECRET,
    grant_type: "client_credentials",
    scope: "extrato.read",
  });

  const response = await fetch("https://cdpj.partners.bancointer.com.br/oauth/v2/token", {
    method: "POST",
    // @ts-ignore - Node 18+/undici aceita um https.Agent nativo via "dispatcher" em fetch;
    // se estiver usando axios, passe { httpsAgent: agent } nas options em vez disso.
    agent,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) throw new Error(`Falha ao autenticar no Inter: ${response.status}`);
  const data = await response.json();
  return { token: data.access_token, agent };
}

async function fetchStatement(accountId, start, end) {
  const { token, agent } = await getAccessToken();

  // Ajuste o path exato conforme a documentação vigente (ex.: /banking/v2/extrato).
  const url = `https://cdpj.partners.bancointer.com.br/banking/v2/extrato?dataInicio=${start}&dataFim=${end}`;
  const response = await fetch(url, {
    // @ts-ignore ver nota acima sobre agent/dispatcher
    agent,
    headers: {
      Authorization: `Bearer ${token}`,
      "x-conta-corrente": process.env.INTER_CONTA_CORRENTE,
    },
  });

  if (!response.ok) throw new Error(`Falha ao buscar extrato no Inter: ${response.status}`);
  const data = await response.json();

  // Mapeia o formato do Inter para o contrato esperado pelo frontend (README.md).
  return (data.transacoes || []).map((item) => ({
    fitid: item.idTransacao || item.codigoTransacao,
    date: item.dataEntrada,
    description: item.descricao,
    amount: Math.abs(Number(item.valor)),
    type: item.tipoOperacao === "C" ? "entrada" : "saida",
    documentNumber: item.numeroDocumento || "",
  }));
}

module.exports = { fetchStatement };
