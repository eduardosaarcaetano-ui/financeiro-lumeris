"use strict";

const assert = require("node:assert/strict");
const {
 automaticEntryId,
 isAutomaticEntry,
 isActiveEntry,
 buildActiveEntry,
 buildCancelledEntry,
} = require("../crm-ranking");

const opportunityId = "opp-ganho-001";
const created = buildActiveEntry({
 opportunityId,
 seller: "Victor Hugo",
 sellerUserId: "user-victor",
 client: "Daniel Pataro",
 city: "Sorocaba - SP",
 amount: 12500,
 saleDate: "2026-08-24",
 now: "2026-08-24T12:00:00.000Z",
});

assert.equal(created.id, automaticEntryId(opportunityId));
assert.equal(created.recordType, "crm_won_sale");
assert.equal(created.source, "crm");
assert.equal(created.period, "2026-08");
assert.equal(created.amount, 12500);
assert.equal(created.status, "active");
assert.ok(isAutomaticEntry(created));
assert.ok(isActiveEntry(created));

const updated = buildActiveEntry({
 opportunityId,
 seller: "Eduardo Saar",
 sellerUserId: "user-eduardo",
 client: "Daniel Pataro",
 city: "Sorocaba - SP",
 amount: 15000.456,
 saleDate: "2026-09-02",
 existing: created,
 now: "2026-09-02T09:00:00.000Z",
});

assert.equal(updated.id, created.id, "a edição deve atualizar o mesmo lançamento");
assert.equal(updated.createdAt, created.createdAt, "a auditoria deve preservar a criação original");
assert.equal(updated.seller, "Eduardo Saar");
assert.equal(updated.amount, 15000.46);
assert.equal(updated.period, "2026-09");

const cancelled = buildCancelledEntry(updated, {
 now: "2026-09-03T09:00:00.000Z",
 reason: "opportunity_no_longer_won",
});
assert.equal(cancelled.status, "cancelled");
assert.ok(!isActiveEntry(cancelled));
assert.equal(cancelled.amount, updated.amount, "cancelar não pode apagar o valor histórico");

const reactivated = buildActiveEntry({
 opportunityId,
 seller: "Eduardo Saar",
 sellerUserId: "user-eduardo",
 client: "Daniel Pataro",
 city: "Sorocaba - SP",
 amount: 15000.46,
 saleDate: "2026-09-04",
 existing: cancelled,
 now: "2026-09-04T09:00:00.000Z",
});
assert.equal(reactivated.status, "active");
assert.equal(reactivated.cancelledAt, "");
assert.equal(reactivated.id, created.id, "reativar não pode duplicar o lançamento");

assert.throws(() => buildActiveEntry({ opportunityId, seller: "", client: "Cliente", amount: 1, saleDate: "2026-08-24" }), /vendedor/);
assert.throws(() => buildActiveEntry({ opportunityId, seller: "Victor", client: "Cliente", amount: 0, saleDate: "2026-08-24" }), /valor/);
assert.throws(() => buildCancelledEntry({ source: "manual" }), /automáticos/);

console.log("crmRanking: criação, atualização, cancelamento, reativação e validações aprovados");
