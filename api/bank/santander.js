"use strict";

const { sendJson } = require("../_lib/http");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }
  return sendJson(res, 501, { ok: false, error: "Santander ainda nao configurado neste backend." });
};
