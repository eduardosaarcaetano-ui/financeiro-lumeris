"use strict";

// Helpers comuns para as funcoes serverless em api/. O runtime Node da Vercel
// ja preenche req.body (string, quando o Content-Type e text/plain - o caso do
// app.js, que evita JSON explicito para nao disparar preflight de CORS) ou
// objeto (quando Content-Type e application/json).
function getJsonBody(req) {
  if (req.body === undefined || req.body === null || req.body === "") return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch (error) {
      throw new Error("JSON invalido no corpo da requisicao.");
    }
  }
  return req.body;
}

function sendJson(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

module.exports = { getJsonBody, sendJson };
