"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const api = fs.readFileSync(path.join(root, "api", "sync.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const vercel = fs.readFileSync(path.join(root, "vercel.json"), "utf8");

assert.match(app, /const SYNC_PROTOCOL_VERSION = 9;/);
assert.match(app, /async function saveOpportunity[\s\S]{0,9000}await persistAndConfirm\("crm"\)/);
assert.match(app, /async function saveManualSalesRankEntry[\s\S]{0,3500}await persistAndConfirm\("crm"\)/);
assert.match(app, /LumerisSyncConfirmation\.assertSyncAcknowledgement/);

const noopStart = app.indexOf("function discardNoopPendingSyncScopes");
const noopBlock = app.slice(noopStart, noopStart + 1300);
assert.ok(noopStart >= 0);
assert.doesNotMatch(noopBlock, /setSyncStatus\("Sincronizado com a nuvem"/);
assert.match(noopBlock, /Nenhuma alteração nova para enviar/);

assert.match(api, /committed: true/);
assert.match(api, /mutationId/);
assert.match(index, /Versão 9\.9/);
assert.ok(index.indexOf("sync-confirmation.js") < index.indexOf("app.js?v=9.9-sync-confirmation-r1"));
assert.match(vercel, /app\.js\|styles\.css\|sync-confirmation\.js/);
assert.match(vercel, /max-age=0, must-revalidate/);
assert.match(vercel, /no-store, max-age=0/);

console.log("frontendSyncContract: confirmação, versão e cache crítico validados");
