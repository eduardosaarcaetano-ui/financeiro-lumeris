"use strict";

const {
  createReceitaProvider,
  buildAgentFromEnvContent,
  isConfiguredFromEnvContent,
} = require("../_lib/bankProviders/receita");
const { getJsonBody, sendJson } = require("../_lib/http");

const receita = createReceitaProvider({
  buildAgent: buildAgentFromEnvContent,
  isConfigured: isConfiguredFromEnvContent,
});

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  try {
    const body = getJsonBody(req);
    const cnpj = body.cnpj;
    const start = body.start;
    const end = body.end;
    if (!cnpj || !start || !end) {
      return sendJson(res, 400, { ok: false, error: "Informe cnpj, start e end (YYYY-MM-DD)." });
    }

    const notas = await receita.fetchNotas({ cnpj, start, end });
    return sendJson(res, 200, { ok: true, notas });
  } catch (error) {
    console.error(error);
    return sendJson(res, error.code === "not_configured" ? 409 : 500, {
      ok: false,
      error: error.message || "Falha ao consultar notas fiscais na Receita Federal.",
    });
  }
};
