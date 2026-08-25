"use strict";

const assert = require("assert");
const personIdentity = require("../person-identity");
const migration = require("../tools/person-consolidation-migration");
const { computeSyncPatch, SYNC_PROTOCOL_VERSION } = require("../api/_lib/syncEngine");

const before = {
  people: [
    { id: "p1", name: "Maria da Silva", type: "cliente", document: "", contact: "" },
    { id: "p2", name: " MARIA  DA SILVA ", type: "cliente", document: "123", contact: "maria@example.com" },
  ],
  opportunities: [{ id: "o1", personId: "p2", customerId: "p2", value: 100 }],
  opportunityHistory: [], sales: [], salesRankingEntries: [], transactions: [], invoices: [],
  projects: [], protocols: [], protocolHistory: [], installations: [], tasks: [],
  stockItems: [], stockMovements: [],
};
const consolidation = personIdentity.consolidatePeopleState(before, { mergedAt: "2026-08-25T00:00:00.000Z" });
migration.assertInvariants(before, consolidation.state, consolidation.report);
const operations = migration.buildOperations(before, consolidation.state);
const result = computeSyncPatch({
  action: "sync.patch",
  protocolVersion: SYNC_PROTOCOL_VERSION,
  mutationId: "migration-test",
  actorUsername: "adm",
  scopes: ["all"],
  operations,
}, { data: before, revision: 1, version: "1:x", updatedAt: "x" });

assert.equal(result.ok, true);
assert.deepEqual(result.nextData, consolidation.state);
assert.equal(migration.duplicateSummary(result.nextData), 0);
assert.equal(result.nextData.opportunities[0].personId, result.nextData.people[0].id);
assert.equal(
  migration.migrationChecksum({ people: [{ id: "b" }, { id: "a" }] }),
  migration.migrationChecksum({ people: [{ id: "a" }, { id: "b" }] })
);
assert.equal(migration.parseArguments(["--expected-revision", "42", "--apply"]).expectedRevision, 42);
assert.throws(() => migration.parseArguments(["--apply"]), /expected-revision/);
console.log("personConsolidationMigration: patch atomico, invariantes e protecao de revisao validados");
