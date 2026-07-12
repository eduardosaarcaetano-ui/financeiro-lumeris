"use strict";

const http = require("http");
const { URL } = require("url");
const inter = require("./providers/inter");

loadEnv();

const PORT = Number(process.env.PORT || 8787);
const DEFAULT_ALLOWED_ORIGINS = [
  "https://eduardosaarcaetano-ui.github.io",
  "http://localhost",
  "http://127.0.0.1",
  "null",
];

const server = http.createServer(async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return sendJson(res, 204, null);
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "financeiro-lumeris-bank-backend",
      interConfigured: inter.isConfigured(),
    });
  }

  if (req.method === "POST" && url.pathname === "/inter/extrato") {
    return handleStatement(req, res, inter.fetchStatement, inter.fetchBalance, inter.fetchInvestmentBalance);
  }

  if (req.method === "POST" && url.pathname === "/santander/extrato") {
    return sendJson(res, 501, {
      ok: false,
      error: "Santander ainda nao configurado neste backend local.",
    });
  }

  return sendJson(res, 404, { ok: false, error: "Rota nao encontrada." });
});

server.listen(PORT, () => {
  console.log(`Backend bancario Lumeris rodando em http://localhost:${PORT}`);
});

async function handleStatement(req, res, fetchStatement, fetchBalance, fetchInvestmentBalance) {
  try {
    const body = await readJsonBody(req);
    const start = body.start;
    const end = body.end;

    if (!start || !end) {
      return sendJson(res, 400, {
        ok: false,
        error: "Informe start e end no formato YYYY-MM-DD.",
      });
    }

    const account = {
      accountId: body.accountId || "",
      bankId: body.bankId || "",
    };
    const movements = await fetchStatement({
      ...account,
      start,
      end,
    });
    const balance = fetchBalance ? await fetchBalance(account) : null;
    const investments = fetchInvestmentBalance ? await safeFetchInvestments(fetchInvestmentBalance, account) : null;

    return sendJson(res, 200, { ok: true, movements, balance, investments });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, {
      ok: false,
      error: error.message || "Falha ao consultar extrato bancario.",
    });
  }
}

async function safeFetchInvestments(fetchInvestmentBalance, account) {
  try {
    return await fetchInvestmentBalance(account);
  } catch (error) {
    console.warn(error.message || "Falha ao consultar investimentos.");
    return null;
  }
}

function setCorsHeaders(req, res) {
  const configured = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowedOrigins = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  const origin = req.headers.origin || "";
  const matched = allowedOrigins.find((allowed) => {
    if (allowed === "*") return true;
    if (allowed === "null" && origin === "null") return true;
    return origin === allowed || (origin && origin.startsWith(`${allowed}:`));
  });

  if (matched) {
    res.setHeader("Access-Control-Allow-Origin", matched === "*" ? "*" : origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  if (payload === null) return res.end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Corpo da requisicao muito grande."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("JSON invalido no corpo da requisicao."));
      }
    });
    req.on("error", reject);
  });
}

function loadEnv() {
  const fs = require("fs");
  const path = require("path");
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}
