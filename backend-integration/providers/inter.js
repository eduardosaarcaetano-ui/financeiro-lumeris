"use strict";

const fs = require("fs");
const https = require("https");
const tls = require("tls");
const { URL } = require("url");

let tokenCache = null;
const REQUEST_TIMEOUT_MS = Number(process.env.INTER_REQUEST_TIMEOUT_MS || 45_000);

function isConfigured() {
  return Boolean(
    process.env.INTER_CLIENT_ID &&
      process.env.INTER_CLIENT_SECRET &&
      (process.env.INTER_CERT_PATH || process.env.INTER_PFX_PATH) &&
      (process.env.INTER_KEY_PATH || process.env.INTER_PFX_PATH)
  );
}

async function fetchStatement({ accountId, start, end }) {
  assertConfigured();

  const token = await getAccessToken();
  const baseUrl = process.env.INTER_BASE_URL || "https://cdpj.partners.bancointer.com.br";
  const statementPath = process.env.INTER_EXTRATO_PATH || "/banking/v2/extrato";
  const url = new URL(statementPath, baseUrl);
  url.searchParams.set("dataInicio", start);
  url.searchParams.set("dataFim", end);

  const currentAccount = process.env.INTER_CONTA_CORRENTE || accountId;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (currentAccount) headers["x-conta-corrente"] = currentAccount;

  const data = await requestJson("GET", url, { headers, label: "extrato" });
  return extractInterTransactions(data).map((item) => normalizeInterMovement(item));
}

async function fetchBalance({ accountId }) {
  assertConfigured();

  const token = await getAccessToken();
  const baseUrl = process.env.INTER_BASE_URL || "https://cdpj.partners.bancointer.com.br";
  const balancePath = process.env.INTER_SALDO_PATH || "/banking/v2/saldo";
  const url = new URL(balancePath, baseUrl);
  const currentAccount = process.env.INTER_CONTA_CORRENTE || accountId;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (currentAccount) headers["x-conta-corrente"] = currentAccount;

  const data = await requestJson("GET", url, { headers, label: "saldo" });
  return normalizeInterBalance(data);
}

async function fetchInvestmentBalance({ accountId }) {
  assertConfigured();

  if (process.env.INTER_INVESTMENT_BALANCE) {
    return {
      amount: parseMoney(process.env.INTER_INVESTMENT_BALANCE),
      date: process.env.INTER_INVESTMENT_BALANCE_DATE || new Date().toISOString().slice(0, 10),
      source: "env",
    };
  }

  if (!process.env.INTER_INVESTMENTS_PATH) {
    return null;
  }

  const token = await getAccessToken();
  const baseUrl = process.env.INTER_BASE_URL || "https://cdpj.partners.bancointer.com.br";
  const url = new URL(process.env.INTER_INVESTMENTS_PATH, baseUrl);
  const currentAccount = process.env.INTER_CONTA_CORRENTE || accountId;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (currentAccount) headers["x-conta-corrente"] = currentAccount;

  const data = await requestJson("GET", url, { headers, label: "investimentos" });
  return normalizeInterInvestments(data);
}

async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }

  const baseUrl = process.env.INTER_BASE_URL || "https://cdpj.partners.bancointer.com.br";
  const tokenPath = process.env.INTER_TOKEN_PATH || "/oauth/v2/token";
  const url = new URL(tokenPath, baseUrl);
  const scope = process.env.INTER_SCOPE || "extrato.read";
  const body = new URLSearchParams({
    client_id: process.env.INTER_CLIENT_ID,
    client_secret: process.env.INTER_CLIENT_SECRET,
    grant_type: "client_credentials",
    scope,
  }).toString();

  const data = await requestJson("POST", url, {
    label: "token",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });

  if (!data.access_token) {
    throw new Error("Banco Inter nao retornou access_token.");
  }

  const expiresIn = Number(data.expires_in || 300);
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return tokenCache.accessToken;
}

function requestJson(method, url, { headers = {}, body = "", label = "requisicao" } = {}) {
  const agent = buildAgent();

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        agent,
        headers,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const parsed = parseJson(raw);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const detail = getErrorDetail(parsed);
            reject(new Error(`Inter ${label} respondeu HTTP ${res.statusCode}${detail ? `: ${detail}` : ""}`));
            return;
          }
          resolve(parsed || {});
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Tempo limite ao consultar Inter ${label}. Tente novamente em instantes.`));
    });
    if (body) req.write(body);
    req.end();
  });
}

function buildAgent() {
  const options = {
    rejectUnauthorized: process.env.INTER_REJECT_UNAUTHORIZED !== "false",
  };

  if (process.env.INTER_PFX_PATH) {
    options.pfx = fs.readFileSync(process.env.INTER_PFX_PATH);
    if (process.env.INTER_CERT_PASSPHRASE) {
      options.passphrase = process.env.INTER_CERT_PASSPHRASE;
    }
  } else {
    options.cert = fs.readFileSync(process.env.INTER_CERT_PATH);
    options.key = fs.readFileSync(process.env.INTER_KEY_PATH);
    if (process.env.INTER_CERT_PASSPHRASE) {
      options.passphrase = process.env.INTER_CERT_PASSPHRASE;
    }
  }

  const trustedCertificates =
    typeof tls.getCACertificates === "function"
      ? [...tls.getCACertificates("default"), ...tls.getCACertificates("system")]
      : [...tls.rootCertificates];
  if (process.env.INTER_CA_PATH) {
    trustedCertificates.push(fs.readFileSync(process.env.INTER_CA_PATH, "utf8"));
  }
  options.ca = trustedCertificates;

  return new https.Agent(options);
}

function assertConfigured() {
  if (!isConfigured()) {
    throw new Error("Configure INTER_CLIENT_ID, INTER_CLIENT_SECRET e certificado/chave do Inter no arquivo .env.");
  }
}

function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function getErrorDetail(parsed) {
  if (!parsed) return "";
  const detail = parsed.message || parsed.error_description || parsed.error || parsed.title;
  if (detail) return String(detail).slice(0, 300);
  if (parsed.raw) {
    return String(parsed.raw).replace(/\s+/g, " ").trim().slice(0, 300);
  }
  return "";
}

function extractInterTransactions(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.transacoes)) return data.transacoes;
  if (Array.isArray(data.movimentacoes)) return data.movimentacoes;
  if (Array.isArray(data.movimentos)) return data.movimentos;
  if (Array.isArray(data.items)) return data.items;
  if (data.data) return extractInterTransactions(data.data);
  if (data.result) return extractInterTransactions(data.result);
  return [];
}

function normalizeInterBalance(data) {
  const source = data?.data || data?.result || data || {};
  const rawBalance = firstValue(source, [
    "disponivel",
    "saldoDisponivel",
    "saldoAtual",
    "saldo",
    "valor",
    "availableBalance",
    "balance",
  ]);
  const amount = parseMoney(rawBalance);
  if (!Number.isFinite(amount)) {
    throw new Error("Banco Inter nao retornou saldo em formato reconhecido.");
  }
  const rawDate = firstValue(source, ["data", "dataSaldo", "dataHoraSaldo", "date", "timestamp"]);
  return {
    amount,
    date: rawDate ? normalizeDate(rawDate) : new Date().toISOString().slice(0, 10),
    raw: source,
  };
}

function normalizeInterInvestments(data) {
  const source = data?.data || data?.result || data || {};
  const directValue = firstValue(source, [
    "saldoInvestimentos",
    "valorAtual",
    "valorBruto",
    "valorLiquido",
    "saldoBruto",
    "saldoLiquido",
    "total",
    "amount",
  ]);
  const amount = directValue !== "" ? parseMoney(directValue) : sumInvestmentItems(source);
  if (!Number.isFinite(amount)) {
    throw new Error("Banco Inter nao retornou investimentos em formato reconhecido.");
  }
  const rawDate = firstValue(source, ["data", "dataReferencia", "dataPosicao", "date", "timestamp"]);
  return {
    amount,
    date: rawDate ? normalizeDate(rawDate) : new Date().toISOString().slice(0, 10),
    source: "api",
  };
}

function sumInvestmentItems(source) {
  const arrays = [
    source.investimentos,
    source.aplicacoes,
    source.posicoes,
    source.items,
    Array.isArray(source) ? source : null,
  ].filter(Array.isArray);
  if (!arrays.length) return 0;
  return arrays.flat().reduce((total, item) => {
    const value = firstValue(item, ["valorAtual", "valorBruto", "valorLiquido", "saldoBruto", "saldoLiquido", "valor", "amount"]);
    return total + parseMoney(value);
  }, 0);
}

function normalizeInterMovement(item) {
  const rawAmount = firstValue(item, ["valor", "valorLancamento", "amount", "value"]);
  const signedAmount = normalizeSignedAmount(rawAmount, item);
  const date = normalizeDate(firstValue(item, ["dataEntrada", "dataMovimento", "dataLancamento", "data", "date"]));
  const fitid = String(
    firstValue(item, ["idTransacao", "codigoTransacao", "numeroDocumento", "documento", "id", "transactionId"]) ||
      `${date}-${signedAmount}-${firstValue(item, ["descricao", "historico", "description"]) || ""}`
  );

  return {
    fitid,
    date,
    description: String(firstValue(item, ["descricao", "historico", "description", "titulo", "tipoOperacao"]) || "Movimento Inter"),
    amount: Math.abs(signedAmount),
    signedAmount,
    type: signedAmount >= 0 ? "entrada" : "saida",
    documentNumber: String(firstValue(item, ["numeroDocumento", "documento", "codigoTransacao"]) || ""),
  };
}

function normalizeSignedAmount(rawAmount, item) {
  const amount = parseMoney(rawAmount);
  const type = String(firstValue(item, ["tipoOperacao", "tipo", "natureza"]) || "").toLowerCase();
  const creditWords = ["c", "credito", "credit", "entrada", "recebimento"];
  const debitWords = ["d", "debito", "debit", "saida", "pagamento"];

  if (amount < 0) return amount;
  if (debitWords.includes(type)) return -Math.abs(amount);
  if (creditWords.includes(type)) return Math.abs(amount);
  return amount;
}

function parseMoney(value) {
  if (typeof value === "number") return value;
  const text = String(value || "0").trim();
  if (text.includes(",") && text.includes(".")) {
    return Number(text.replace(/\./g, "").replace(",", "."));
  }
  if (text.includes(",")) {
    return Number(text.replace(",", "."));
  }
  return Number(text);
}

function normalizeDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const text = String(value);
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return new Date(text).toISOString().slice(0, 10);
}

function firstValue(source, keys) {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null && source[key] !== "") {
      return source[key];
    }
  }
  return "";
}

module.exports = { fetchStatement, fetchBalance, fetchInvestmentBalance, isConfigured };
