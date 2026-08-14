"use strict";

const { isConfiguredFromEnvContent: interConfigured } = require("../_lib/bankProviders/inter");
const { isConfiguredFromEnvContent: receitaConfigured } = require("../_lib/bankProviders/receita");
const { sendJson } = require("../_lib/http");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }
  return sendJson(res, 200, {
    ok: true,
    service: "financeiro-lumeris-bank-backend",
    interConfigured: interConfigured(),
    receitaConfigured: receitaConfigured(),
  });
};
