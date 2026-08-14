"use strict";

const { handleUpload } = require("@vercel/blob/client");
const { getJsonBody, sendJson } = require("./_lib/http");

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// A integracao Blob da Vercel permite um prefixo customizado nas env vars
// (mesma pegadinha que ja vimos no Postgres), entao BLOB_READ_WRITE_TOKEN
// pode nao existir com esse nome exato - procura qualquer variavel que
// termine assim antes de desistir.
function resolveBlobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const key = Object.keys(process.env).find(
    (name) => name.endsWith("BLOB_READ_WRITE_TOKEN") && process.env[name]
  );
  return key ? process.env[key] : undefined;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  try {
    const body = getJsonBody(req);
    const token = resolveBlobToken();
    if (!token) {
      return sendJson(res, 500, {
        ok: false,
        error: "Nenhum token do Vercel Blob encontrado nas env vars. Conecte um Blob store ao projeto na Vercel.",
      });
    }
    const jsonResponse = await handleUpload({
      body,
      request: req,
      token,
      onBeforeGenerateToken: async () => ({
        access: "public",
        addRandomSuffix: true,
        maximumSizeInBytes: MAX_UPLOAD_BYTES,
      }),
      onUploadCompleted: async () => {
        // Nada a fazer aqui - o registro do anexo (nome/url) e salvo pelo
        // proprio ERP no proximo sync.patch, junto com o resto da oportunidade.
      },
    });
    return sendJson(res, 200, jsonResponse);
  } catch (error) {
    console.error(error);
    return sendJson(res, 400, { ok: false, error: error.message || "upload_failed" });
  }
};
