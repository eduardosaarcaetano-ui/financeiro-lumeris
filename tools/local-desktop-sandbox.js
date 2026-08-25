"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const engine = require("../api/_lib/syncEngine");

const HOST = "127.0.0.1";
const PORT = Number(process.env.ERP_DESKTOP_PORT || 4174);
const ROOT = path.resolve(__dirname, "..");
const PRODUCTION_SYNC_URL = "https://erp-lumeris.vercel.app/api/sync";
const CONTENT_TYPES = {
 ".css": "text/css; charset=utf-8",
 ".html": "text/html; charset=utf-8",
 ".jpeg": "image/jpeg",
 ".jpg": "image/jpeg",
 ".js": "application/javascript; charset=utf-8",
 ".json": "application/json; charset=utf-8",
 ".png": "image/png",
 ".svg": "image/svg+xml",
};

let stored = null;
const appliedMutations = new Set();

function sendJson(response, status, value) {
 const payload = JSON.stringify(value);
 response.writeHead(status, {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  "Content-Length": Buffer.byteLength(payload),
 });
 response.end(payload);
}

async function loadReadOnlyProductionSnapshot() {
 const response = await fetch(PRODUCTION_SYNC_URL, {
  method: "GET",
  headers: { Accept: "application/json", "Cache-Control": "no-cache" },
 });
 if (!response.ok) throw new Error(`Falha ao carregar cópia de produção: HTTP ${response.status}`);
 const payload = await response.json();
 if (!payload?.ok || !payload.data) throw new Error("A produção não devolveu uma cópia válida dos dados.");
 stored = {
  data: structuredClone(payload.data),
  revision: Number(payload.revision || 0),
  updatedAt: payload.updatedAt || "",
  version: payload.version || engine.syncVersion(Number(payload.revision || 0), payload.updatedAt || ""),
 };
}

function syncMetadata() {
 return {
  initialized: true,
  revision: stored.revision,
  version: stored.version,
  updatedAt: stored.updatedAt,
  maintenance: stored.data?.maintenance || engine.defaultMaintenanceState(),
 };
}

function handleSyncGet(requestUrl, response) {
 const meta = syncMetadata();
 if (requestUrl.searchParams.get("meta") === "1") {
  return sendJson(response, 200, { ok: true, syncMetadata: meta, protocolVersion: engine.SYNC_PROTOCOL_VERSION });
 }
 if (requestUrl.searchParams.get("maintenance") === "1") {
  return sendJson(response, 200, { ok: true, ...meta, protocolVersion: engine.SYNC_PROTOCOL_VERSION });
 }
 const knownVersion = requestUrl.searchParams.get("knownVersion");
 if (knownVersion !== null && knownVersion === stored.version) {
  return sendJson(response, 200, {
   ok: true,
   notModified: true,
   ...meta,
   protocolVersion: engine.SYNC_PROTOCOL_VERSION,
   syncMode: "atomic-record-patch",
   desktopSandbox: true,
  });
 }
 return sendJson(response, 200, {
  ok: true,
  data: structuredClone(stored.data),
  updatedAt: stored.updatedAt,
  version: stored.version,
  revision: stored.revision,
  protocolVersion: engine.SYNC_PROTOCOL_VERSION,
  syncMode: "atomic-record-patch",
  desktopSandbox: true,
 });
}

async function readJsonBody(request) {
 const chunks = [];
 let size = 0;
 for await (const chunk of request) {
  size += chunk.length;
  if (size > 50 * 1024 * 1024) throw new Error("Requisição de teste excedeu 50 MB.");
  chunks.push(chunk);
 }
 return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function handleSyncPost(request, response) {
 const body = await readJsonBody(request);
 if (body.action !== "sync.patch") {
  return sendJson(response, 200, {
   ok: false,
   error: "client_update_required",
   protocolVersion: engine.SYNC_PROTOCOL_VERSION,
  });
 }

 const mutationId = String(body.mutationId || "").trim();
 const result = engine.computeSyncPatch(body, stored, { mutationAlreadyApplied: appliedMutations.has(mutationId) });
 if (!result.ok) return sendJson(response, 200, result);
 if (!result.idempotent && !result.skipWrite) {
  const now = new Date().toISOString();
  stored = {
   data: result.nextData,
   revision: stored.revision + 1,
   updatedAt: now,
   version: engine.syncVersion(stored.revision + 1, now),
  };
  if (mutationId) appliedMutations.add(mutationId);
 }
 return sendJson(response, 200, {
  ok: true,
  committed: true,
  mutationId,
  operationCount: Array.isArray(body.operations) ? body.operations.length : 0,
  updatedAt: stored.updatedAt,
  version: stored.version,
  revision: stored.revision,
  protocolVersion: engine.SYNC_PROTOCOL_VERSION,
  desktopSandbox: true,
  idempotent: Boolean(result.idempotent),
 });
}

function serveStatic(requestUrl, response) {
 const relativePath = requestUrl.pathname === "/" ? "index.html" : decodeURIComponent(requestUrl.pathname.slice(1));
 const filePath = path.resolve(ROOT, relativePath);
 if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) {
  response.writeHead(403);
  return response.end("Forbidden");
 }
 fs.readFile(filePath, (error, data) => {
  if (error) {
   response.writeHead(error.code === "ENOENT" ? 404 : 500);
   return response.end(error.code === "ENOENT" ? "Not found" : "Read error");
  }
  response.writeHead(200, {
   "Content-Type": CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
   "Cache-Control": "no-store, max-age=0",
  });
  response.end(data);
 });
}

async function handleRequest(request, response) {
 try {
  const requestUrl = new URL(request.url, `http://${HOST}:${PORT}`);
  if (requestUrl.pathname === "/api/sync") {
   if (request.method === "GET") return handleSyncGet(requestUrl, response);
   if (request.method === "POST") return await handleSyncPost(request, response);
   return sendJson(response, 405, { ok: false, error: "method_not_allowed" });
  }
  if (requestUrl.pathname.startsWith("/api/")) return sendJson(response, 404, { ok: false, error: "disabled_in_desktop_sandbox" });
  return serveStatic(requestUrl, response);
 } catch (error) {
  console.error(error);
  return sendJson(response, 500, { ok: false, error: error.message || "desktop_sandbox_error" });
 }
}

async function start() {
 await loadReadOnlyProductionSnapshot();
 const server = http.createServer((request, response) => void handleRequest(request, response));
 server.listen(PORT, HOST, () => {
  console.log(`ERP 10.0 desktop: http://${HOST}:${PORT}/?desktoptest=1`);
  console.log(`Cópia carregada da revisão ${stored.revision}. Alterações ficam somente na memória local.`);
 });
}

start().catch((error) => {
 console.error(error);
 process.exitCode = 1;
});
