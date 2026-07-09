// Servidor de referência (Node + Express). Renomeie para server.js, rode `npm init -y &&
// npm install express dotenv` e ajuste conforme necessário. Não é usado pelo GitHub Pages —
// você quem hospeda este backend separadamente (VPS, container, etc.) e cola a URL dele no
// campo "URL do backend de integração" da tela Banco do sistema.

require("dotenv").config();
const express = require("express");
const inter = require("./providers/inter");
const santander = require("./providers/santander");

const app = express();
app.use(express.text({ type: "*/*" })); // o frontend envia o corpo como text/plain para evitar preflight de CORS

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function parseBody(req) {
  try {
    return JSON.parse(req.body || "{}");
  } catch {
    return {};
  }
}

app.post("/inter/extrato", async (req, res) => {
  const { accountId, start, end } = parseBody(req);
  try {
    const movements = await inter.fetchStatement(accountId, start, end);
    res.json({ ok: true, movements });
  } catch (error) {
    console.error(error);
    res.json({ ok: false, error: error.message });
  }
});

app.post("/santander/extrato", async (req, res) => {
  const { accountId, start, end } = parseBody(req);
  try {
    const movements = await santander.fetchStatement(accountId, start, end);
    res.json({ ok: true, movements });
  } catch (error) {
    console.error(error);
    res.json({ ok: false, error: error.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Backend de integração bancária rodando na porta ${port}`));
