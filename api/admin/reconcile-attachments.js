"use strict";

// Reconciliacao unica: recupera anexos que existem fisicamente nas pastas do
// Google Drive (Financeiro/Dados Oportunidades) mas que nao estao registrados
// no campo `attachments` das oportunidades no Postgres - caso de arquivos
// colocados manualmente na pasta, ou anexados antes do fluxo automatico
// existir. Idempotente: rodar de novo nao duplica (compara por URL).
//
// GET  /api/admin/reconcile-attachments        -> so mostra o que seria adicionado (dry-run)
// POST /api/admin/reconcile-attachments?apply=1 -> grava de fato
//
// Depende da acao crm.listAttachmentFolders no Apps Script (AppsScript_Code.gs).

const { randomUUID } = require("crypto");
const { withTransaction } = require("../_lib/db");
const { sendJson } = require("../_lib/http");

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwvq0ov-i-Zdk3T5G-jm5WGPYLPnvZTvxxM53lTy4yAqd9XWQL4I2UKVeGAOdWCzQ83/exec";

function sanitizeDriveName(name) {
  return String(name || "Sem nome").replace(/[:*?"<>|#%{}~&]/g, " ").replace(/\s+/g, " ").trim().substring(0, 140);
}

function inferAttachmentType(fileName, mimeType) {
  const name = String(fileName || "").toLowerCase();
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic)$/i.test(name)) return "foto";
  if (name.includes("conta") || name.includes("energia")) return "conta_energia";
  if (mime.includes("pdf") || /\.pdf$/i.test(name)) return "pdf";
  if (/\.(xlsx|csv)$/i.test(name)) return "planilha";
  if (/\.(docx|txt)$/i.test(name)) return "documento";
  return "outro";
}

function opportunityClientName(opportunity, peopleById) {
  const person = opportunity.personId ? peopleById.get(opportunity.personId) : null;
  const name = (person && person.name) || opportunity.company || "";
  return name.trim() || "Oportunidade sem cliente";
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }
  const apply = req.method === "POST" && String((req.query || {}).apply || "") === "1";

  try {
    const listResponse = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      body: JSON.stringify({ action: "crm.listAttachmentFolders" }),
    });
    const listResult = await listResponse.json();
    if (!listResult.ok) {
      return sendJson(res, 502, {
        ok: false,
        error: listResult.error || "Falha ao listar pastas no Drive. Publique a nova versao do Apps Script (acao crm.listAttachmentFolders).",
      });
    }
    const foldersByName = new Map(listResult.folders.map((folder) => [folder.folderName, folder]));

    const summary = await withTransaction(async (client) => {
      const selectSql = apply
        ? "select revision, data from sync_state where id = 1 for update"
        : "select revision, data from sync_state where id = 1";
      const { rows } = await client.query(selectSql);
      const stored = rows[0];
      if (!stored || !stored.data) throw new Error("sync_state vazio.");
      const data = stored.data;
      const opportunities = Array.isArray(data.opportunities) ? data.opportunities : [];
      const peopleById = new Map((Array.isArray(data.people) ? data.people : []).map((person) => [person.id, person]));

      const details = [];
      opportunities.forEach((opportunity) => {
        const number = String(opportunity.number || "").trim();
        if (!number) return;
        const clientName = opportunityClientName(opportunity, peopleById);
        const folderName = sanitizeDriveName(`${clientName} - ${number}`);
        let folder = foldersByName.get(folderName);
        if (!folder) folder = listResult.folders.find((item) => item.folderName.endsWith(` - ${number}`));
        if (!folder) return;

        const existingUrls = new Set((Array.isArray(opportunity.attachments) ? opportunity.attachments : []).map((att) => att.url));
        const newAttachments = folder.files
          .filter((file) => !existingUrls.has(file.url))
          .map((file) => ({
            id: randomUUID(),
            type: inferAttachmentType(file.name, file.mimeType),
            name: file.name,
            url: file.url,
            notes: "Recuperado automaticamente do Google Drive",
            createdAt: file.createdTime || new Date().toISOString(),
          }));
        if (!newAttachments.length) return;

        details.push({ opportunityId: opportunity.id, number, folderName, added: newAttachments.length });
        if (apply) {
          opportunity.attachments = [...(opportunity.attachments || []), ...newAttachments];
          if (!opportunity.driveFolderUrl) opportunity.driveFolderUrl = folder.folderUrl;
        }
      });

      const totalAdded = details.reduce((sum, item) => sum + item.added, 0);
      if (!apply || !totalAdded) {
        return { applied: false, totalAdded, details };
      }

      const revision = Number(stored.revision || 0) + 1;
      const updatedAt = new Date().toISOString();
      const version = `${revision}:${updatedAt}`;
      await client.query(
        "update sync_state set revision = $1, version = $2, updated_at = $3, data = $4 where id = 1",
        [revision, version, updatedAt, JSON.stringify(data)]
      );
      return { applied: true, revision, totalAdded, details };
    });

    return sendJson(res, 200, { ok: true, ...summary });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { ok: false, error: error.message || "internal_error" });
  }
};
