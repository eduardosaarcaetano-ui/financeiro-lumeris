"use strict";

// Wrapper local (execucao com "node server.js"): usa certificado/chave em
// arquivo. A logica de verdade vive em api/_lib/bankProviders/inter.js,
// compartilhada com o endpoint da Vercel (api/bank/inter.js).
const {
  createInterProvider,
  buildAgentFromPaths,
  isConfiguredFromPaths,
} = require("../../api/_lib/bankProviders/inter");

module.exports = createInterProvider({
  buildAgent: buildAgentFromPaths,
  isConfigured: isConfiguredFromPaths,
});
