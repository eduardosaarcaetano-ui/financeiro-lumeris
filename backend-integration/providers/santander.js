// Adaptador do Santander. Referência/esqueleto — confira sempre a documentação oficial atual
// (portal developer.santander.com.br / Open Finance) para o endpoint e formato exatos, pois
// APIs de banco mudam com frequência e este arquivo não deve ser tratado como fonte definitiva
// desses detalhes. Dependendo do produto de API contratado, o Santander também pode exigir
// mTLS — se for o caso, siga o mesmo padrão de https.Agent usado em providers/inter.js.

async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.SANTANDER_CLIENT_ID,
    client_secret: process.env.SANTANDER_CLIENT_SECRET,
    grant_type: "client_credentials",
  });

  const response = await fetch("https://trust-open.api.santander.com.br/auth/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) throw new Error(`Falha ao autenticar no Santander: ${response.status}`);
  const data = await response.json();
  return data.access_token;
}

async function fetchStatement(accountId, start, end) {
  const token = await getAccessToken();

  // Ajuste o path exato conforme a documentação vigente e o produto de API contratado.
  const url = `https://trust-open.api.santander.com.br/bank_account_information/v1/accounts/${accountId}/transactions?dateFrom=${start}&dateTo=${end}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Application-Key": process.env.SANTANDER_CLIENT_ID,
    },
  });

  if (!response.ok) throw new Error(`Falha ao buscar extrato no Santander: ${response.status}`);
  const data = await response.json();

  // Mapeia o formato do Santander para o contrato esperado pelo frontend (README.md).
  return (data.transactions || []).map((item) => ({
    fitid: item.transactionId,
    date: item.transactionDate,
    description: item.description,
    amount: Math.abs(Number(item.amount)),
    type: Number(item.amount) >= 0 ? "entrada" : "saida",
    documentNumber: item.documentNumber || "",
  }));
}

module.exports = { fetchStatement };
