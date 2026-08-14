"use strict";

const {
  createInterProvider,
  buildAgentFromEnvContent,
  isConfiguredFromEnvContent,
} = require("../_lib/bankProviders/inter");
const { getJsonBody, sendJson } = require("../_lib/http");

const inter = createInterProvider({
  buildAgent: buildAgentFromEnvContent,
  isConfigured: isConfiguredFromEnvContent,
});

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  try {
    const body = getJsonBody(req);
    const start = body.start;
    const end = body.end;
    if (!start || !end) {
      return sendJson(res, 400, { ok: false, error: "Informe start e end no formato YYYY-MM-DD." });
    }

    const account = { accountId: body.accountId || "", bankId: body.bankId || "" };
    const movements = await inter.fetchStatement({ ...account, start, end });
    const balance = await inter.fetchBalance(account);
    const investments = await safeFetchInvestments(account);

    return sendJson(res, 200, { ok: true, movements, balance, investments });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { ok: false, error: error.message || "Falha ao consultar extrato bancario." });
  }
};

async function safeFetchInvestments(account) {
  try {
    return await inter.fetchInvestmentBalance(account);
  } catch (error) {
    console.warn(error.message || "Falha ao consultar investimentos.");
    return null;
  }
}
