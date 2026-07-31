"use strict";

// Esqueleto do provider de consulta automática de NF-e na Receita Federal/SEFAZ.
// A consulta oficial (NFe Distribuição DFe) exige certificado digital e-CNPJ (mTLS,
// mesmo padrão do provider do Banco Inter), fala SOAP/XML e devolve os documentos
// compactados em gzip — a implementação completa do parser fica para quando o
// certificado estiver disponível. Por enquanto isConfigured()/fetchNotas() só
// validam a configuração e apontam o que falta.

const fs = require("fs");
const https = require("https");

function isConfigured() {
  return Boolean(
    (process.env.RECEITA_CERT_PATH || process.env.RECEITA_PFX_PATH) &&
      process.env.RECEITA_CERT_PASSWORD &&
      process.env.RECEITA_CNPJ
  );
}

function buildAgent() {
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

async function fetchNotas({ cnpj, start, end }) {
  if (!isConfigured()) {
    const error = new Error(
      "Consulta a Receita Federal ainda nao configurada. Preencha RECEITA_CERT_PATH (ou " +
        "RECEITA_PFX_PATH), RECEITA_CERT_PASSWORD e RECEITA_CNPJ no .env do backend."
    );
    error.code = "not_configured";
    throw error;
  }

  // TODO: implementar a chamada real ao webservice NFeDistribuicaoDFe (SOAP, envelope
  // com CNPJ/NSU, resposta em XML/gzip) usando o agente mTLS de buildAgent(). Mantido
  // como esqueleto ate o certificado digital estar disponivel para testar contra o
  // ambiente de producao/homologacao da SEFAZ.
  const error = new Error("Integracao com a Receita Federal ainda nao implementada neste backend.");
  error.code = "not_implemented";
  throw error;
}

module.exports = { isConfigured, fetchNotas, buildAgent };
