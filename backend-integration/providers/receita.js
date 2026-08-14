"use strict";

// Wrapper local (execucao com "node server.js"): usa certificado/chave em
// arquivo. A logica de verdade vive em api/_lib/bankProviders/receita.js,
// compartilhada com o endpoint da Vercel (api/bank/receita.js).
const {
  createReceitaProvider,
  buildAgentFromPaths,
  isConfiguredFromPaths,
} = require("../../api/_lib/bankProviders/receita");

module.exports = createReceitaProvider({
  buildAgent: buildAgentFromPaths,
  isConfigured: isConfiguredFromPaths,
});
