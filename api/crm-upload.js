"use strict";

const { handleUpload } = require("@vercel/blob/client");
const { getJsonBody, sendJson } = require("./_lib/http");

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  try {
    const body = getJsonBody(req);
    const jsonResponse = await handleUpload({
      body,
      request: req,
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
