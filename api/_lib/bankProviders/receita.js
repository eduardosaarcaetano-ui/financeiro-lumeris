"use strict";

// Esqueleto do provider de consulta automática de NF-e na Receita Federal/SEFAZ,
// compartilhado entre backend-integration/ (certificado em arquivo) e
// api/bank/receita.js (Vercel, certificado em env var). A consulta oficial
// (NFe Distribuição DFe) exige certificado digital e-CNPJ (mTLS), fala
// SOAP/XML e devolve os documentos compactados em gzip - a implementação
// completa do parser fica para quando o certificado estiver disponível.

const fs = require("fs");
const https = require("https");

function createReceitaProvider({ buildAgent, isConfigured }) {
  async function fetchNotas({ cnpj, start, end }) {
    if (!isConfigured()) {
      const error = new Error(
        "Consulta a Receita Federal ainda nao configurada. Preencha o certificado/chave e o CNPJ."
      );
      error.code = "not_configured";
      throw error;
    }

    // TODO: implementar a chamada real ao webservice NFeDistribuicaoDFe (SOAP,
    // envelope com CNPJ/NSU, resposta em XML/gzip) usando buildAgent(). Mantido
    // como esqueleto ate o certificado digital estar disponivel para testar
    // contra o ambiente de producao/homologacao da SEFAZ.
    const error = new Error("Integracao com a Receita Federal ainda nao implementada.");
    error.code = "not_implemented";
    throw error;
  }

  return { fetchNotas, isConfigured, buildAgent };
}

function isConfiguredFromPaths() {
  return Boolean(
    (process.env.RECEITA_CERT_PATH || process.env.RECEITA_PFX_PATH) &&
      process.env.RECEITA_CERT_PASSWORD &&
      process.env.RECEITA_CNPJ
  );
}

function buildAgentFromPaths() {
  if (process.env.RECEITA_PFX_PATH) {
    return new https.Agent({
      pfx: fs.readFileSync(process.env.RECEITA_PFX_PATH),
      passphrase: process.env.RECEITA_CERT_PASSWORD,
    });
  }
  return new https.Agent({
    cert: fs.readFileSync(process.env.RECEITA_CERT_PATH),
    key: fs.readFileSync(process.env.RECEITA_KEY_PATH),
    passphrase: process.env.RECEITA_CERT_PASSWORD,
  });
}

function isConfiguredFromEnvContent() {
  return Boolean(
    (process.env.RECEITA_CERT || process.env.RECEITA_PFX_BASE64) &&
      process.env.RECEITA_CERT_PASSWORD &&
      process.env.RECEITA_CNPJ
  );
}

function buildAgentFromEnvContent() {
  if (process.env.RECEITA_PFX_BASE64) {
    return new https.Agent({
      pfx: Buffer.from(process.env.RECEITA_PFX_BASE64, "base64"),
      passphrase: process.env.RECEITA_CERT_PASSWORD,
    });
  }
  return new https.Agent({
    cert: process.env.RECEITA_CERT,
    key: process.env.RECEITA_KEY,
    passphrase: process.env.RECEITA_CERT_PASSWORD,
  });
}

module.exports = {
  createReceitaProvider,
  buildAgentFromPaths,
  isConfiguredFromPaths,
  buildAgentFromEnvContent,
  isConfiguredFromEnvContent,
};
