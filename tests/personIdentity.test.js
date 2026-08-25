"use strict";

const assert = require("node:assert/strict");
const identity = require("../person-identity");

assert.equal(identity.normalizeName("  José   DA Silva "), "jose da silva");
assert.equal(identity.normalizeDocument("12.345.678/0001-90"), "12345678000190");

const duplicateState = {
 people: [
  { id: "person-a", type: "cliente", name: "José da Silva", document: "", contact: "" },
  { id: "person-b", type: "cliente", name: " JOSE  DA SILVA ", document: "123.456.789-00", contact: "" },
  { id: "person-c", type: "fornecedor", name: "José da Silva", document: "12345678900", contact: "jose@example.com" },
 ],
 opportunities: [{ id: "op-1", personId: "person-a", contractDraft: { client: { id: "person-a" } } }],
 projects: [{ id: "project-1", customerId: "person-b" }],
 transactions: [{ id: "tx-1", personId: "person-c" }],
 stockItems: [{ id: "stock-1", primarySupplierId: "person-c" }],
 stockMovements: [{ id: "move-1", supplierId: "person-c" }],
 salesRankingEntries: [{ id: "rank-1", client: "Jose da Silva", amount: 100 }],
};

const consolidated = identity.consolidatePeopleState(duplicateState, { mergedAt: "2026-08-25T12:00:00.000Z" });
assert.equal(consolidated.report.peopleBefore, 3);
assert.equal(consolidated.report.peopleAfter, 1);
assert.equal(consolidated.report.mergedRecords, 2);
assert.equal(consolidated.report.conflicts.length, 0);
const canonical = consolidated.state.people[0];
assert.equal(canonical.type, "ambos");
assert.equal(identity.normalizeDocument(canonical.document), "12345678900");
assert.equal(canonical.contact, "jose@example.com");
assert.equal(canonical.mergedRecords.length, 2);
assert.equal(consolidated.state.opportunities[0].personId, canonical.id);
assert.equal(consolidated.state.opportunities[0].contractDraft.client.id, canonical.id);
assert.equal(consolidated.state.projects[0].customerId, canonical.id);
assert.equal(consolidated.state.transactions[0].personId, canonical.id);
assert.equal(consolidated.state.stockItems[0].primarySupplierId, canonical.id);
assert.equal(consolidated.state.stockMovements[0].supplierId, canonical.id);
assert.equal(consolidated.state.salesRankingEntries[0].personId, canonical.id);

const sameDocument = identity.consolidatePeopleState({
 people: [
  { id: "one", type: "cliente", name: "Empresa Antiga", document: "11.222.333/0001-44", contact: "" },
  { id: "two", type: "cliente", name: "Empresa Atual", document: "11222333000144", contact: "" },
 ],
});
assert.equal(sameDocument.state.people.length, 1);

const homonyms = identity.consolidatePeopleState({
 people: [
  { id: "one", type: "cliente", name: "Maria de Souza", document: "11111111111", contact: "" },
  { id: "two", type: "cliente", name: "MARIA DE SOUZA", document: "22222222222", contact: "" },
 ],
});
assert.equal(homonyms.state.people.length, 2);
assert.equal(homonyms.report.conflicts.length, 1);

const existing = identity.findMatchingPerson(
 [{ id: "known", name: "João Ferreira", document: "", type: "cliente" }],
 { name: " joao  ferreira ", document: "" },
);
assert.equal(existing.person.id, "known");

const conflicting = identity.findMatchingPerson(
 [{ id: "known", name: "João Ferreira", document: "11111111111", type: "cliente" }],
 { name: "Joao Ferreira", document: "22222222222" },
);
assert.equal(conflicting.person, null);
assert.equal(conflicting.conflict.reason, "same_name_different_document");

console.log("personIdentity: normalização, consolidação, vínculos e conflitos validados");
