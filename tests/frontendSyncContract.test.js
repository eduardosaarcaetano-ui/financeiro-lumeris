"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const api = fs.readFileSync(path.join(root, "api", "sync.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const crmRanking = fs.readFileSync(path.join(root, "crm-ranking.js"), "utf8");
const vercel = fs.readFileSync(path.join(root, "vercel.json"), "utf8");

assert.match(app, /const SYNC_PROTOCOL_VERSION = 10;/);
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
assert.match(index, /Versão 10\.3/);
assert.ok(index.indexOf("person-identity.js?v=10.3-person-unification-r1") < index.indexOf("sync-confirmation.js"));
assert.ok(index.indexOf("sync-confirmation.js") < index.indexOf("crm-ranking.js?v=10.3-person-unification-r1"));
assert.ok(index.indexOf("crm-ranking.js?v=10.3-person-unification-r1") < index.indexOf("app.js?v=10.3-person-unification-r1"));
assert.match(crmRanking, /crm_won_sale/);
assert.match(app, /syncOpportunitySalesRank/);
assert.match(app, /syncOpportunitySalesRank\(data,[\s\S]{0,200}createIfMissing:/);
assert.match(app, /syncOpportunitySalesRank\(opportunity, \{ createIfMissing: newStage === "ganho"/);
assert.match(app, /seller: opportunityOwnerDisplay\(opportunity\)/);
assert.match(app, /saleDate: opportunityWonDate\(opportunity\) \|\| todayIso/);
assert.match(app, /personId: opportunity\.personId/);
assert.match(app, /Automático do CRM\$\{item\.manualOverrideAt \? " — editado manualmente"/);
assert.match(app, /reason: "manual_rank_exclusion"/);
assert.match(app, /existing\.manualOverrideAt/);
[
 "opportunityPerson",
 "opportunityUnit",
 "opportunityPipeline",
 "opportunityStage",
 "opportunityOwner",
 "opportunityProject",
 "salePerson",
 "saleProject",
].forEach((field) => assert.match(app, new RegExp(`enhanceSearchableSelect\\(els\\.${field}`)));
assert.match(app, /normalizeText\(option\.label\)\.includes\(filter\)/);
assert.match(app, /SEARCHABLE_SELECT_RESULT_LIMIT = 100/);
assert.match(app, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
assert.match(app, /role="option"/);
assert.match(app, /function sortPeopleByName/);
assert.match(app, /localeCompare\(String\(b\?\.name \|\| ""\), "pt-BR", \{ sensitivity: "base" \}\)/);
assert.match(vercel, /crm-ranking\.js/);
assert.match(vercel, /app\.js\|styles\.css\|sync-confirmation\.js/);
assert.match(vercel, /max-age=0, must-revalidate/);
assert.match(vercel, /no-store, max-age=0/);

console.log("frontendSyncContract: confirmação, versão e cache crítico validados");
