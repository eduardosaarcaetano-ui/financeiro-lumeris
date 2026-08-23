"use strict";

const assert = require("node:assert/strict");
const { computeSyncPatch, SYNC_PROTOCOL_VERSION } = require("../api/_lib/syncEngine");

function storedWithPeople(people) {
  return {
    data: { people, maintenance: { enabled: false } },
    version: "1:test",
    revision: 1,
    updatedAt: "2026-08-23T12:00:00.000Z",
  };
}

function financePersonOperation(value, overrides = {}) {
  return {
    field: "people",
    type: "upsert",
    id: value.id,
    value,
    baseExists: false,
    baseChecksum: "",
    baseValue: null,
    ...overrides,
  };
}

function patch(stored, operation) {
  return computeSyncPatch({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    mutationId: `test-${Math.random()}`,
    scopes: ["financeiro"],
    operations: [operation],
  }, stored);
}

const importedId = "finance-import-person-1qbxtea";
const importedName = "ALUMINIO SUL DESCARACTERIZACAO DE RESIDUOS, INDUSTRIALIZACAO E SOLUCAO LTDA";
const importedPerson = {
  id: importedId,
  type: "cliente",
  name: importedName,
  document: "",
  contact: "",
  importSource: "contas-recebidas-2026-07",
  createdAt: "2026-07-01T12:00:00.000Z",
};

const missingOnServer = patch(
  storedWithPeople([]),
  financePersonOperation(importedPerson, { baseExists: true, baseChecksum: "synthetic-base" }),
);
assert.equal(missingOnServer.ok, true);
assert.equal(missingOnServer.nextData.people.length, 1);
assert.equal(missingOnServer.nextData.people[0].id, importedId);

const existingOnServer = {
  ...importedPerson,
  type: "cliente",
  document: "12.345.678/0001-00",
  contact: "financeiro@cliente.com",
  createdAt: "2026-08-23T12:34:56.000Z",
};
const concurrentSamePerson = patch(
  storedWithPeople([existingOnServer]),
  financePersonOperation({ ...importedPerson, type: "fornecedor" }),
);
assert.equal(concurrentSamePerson.ok, true);
assert.equal(concurrentSamePerson.nextData.people[0].type, "ambos");
assert.equal(concurrentSamePerson.nextData.people[0].document, existingOnServer.document);
assert.equal(concurrentSamePerson.nextData.people[0].contact, existingOnServer.contact);
assert.equal(concurrentSamePerson.nextData.people[0].createdAt, existingOnServer.createdAt);

const differentPersonSameId = patch(
  storedWithPeople([{ ...existingOnServer, name: "Outra empresa" }]),
  financePersonOperation(importedPerson),
);
assert.equal(differentPersonSameId.ok, false);
assert.equal(differentPersonSameId.error, "record_conflict");

const ordinaryPersonStillConflicts = patch(
  storedWithPeople([{ id: "person-1", name: "Cadastro remoto" }]),
  financePersonOperation({ id: "person-1", name: "Cadastro local" }),
);
assert.equal(ordinaryPersonStillConflicts.ok, false);
assert.equal(ordinaryPersonStillConflicts.error, "record_conflict");

console.log("syncEngine: 4 cenarios validados");
