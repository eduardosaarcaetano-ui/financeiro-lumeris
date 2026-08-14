"use strict";

// Porte de sanitizeDriveName/getOpportunityDriveFolderName do AppsScript_Code.gs.
// No Vercel Blob nao existem pastas de verdade - isto so gera um prefixo
// deterministico usado para agrupar os arquivos de uma oportunidade.
function sanitizeName(name) {
  return String(name || "Sem nome").replace(/[\\/:*?"<>|#%{}~&]/g, " ").replace(/\s+/g, " ").trim().substring(0, 140);
}

function opportunityFolderName(body) {
  const clientName = String(body.clientName || "").trim();
  const opportunityNumber = String(body.opportunityNumber || "").trim();
  if (clientName && opportunityNumber) {
    return sanitizeName(`${clientName} - ${opportunityNumber}`);
  }
  return sanitizeName(body.folderName || clientName || opportunityNumber || "Oportunidade sem nome");
}

module.exports = { sanitizeName, opportunityFolderName };
