"use strict";

(function exposeCrmRanking(root, factory) {
 const api = factory();
 if (typeof module === "object" && module.exports) module.exports = api;
 if (root) root.LumerisCrmRanking = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCrmRankingApi() {
 const RECORD_TYPE = "crm_won_sale";
 const SOURCE = "crm";
 const STATUS_ACTIVE = "active";
 const STATUS_CANCELLED = "cancelled";

 function automaticEntryId(opportunityId) {
  const cleanId = String(opportunityId || "").trim();
  if (!cleanId) throw new Error("Oportunidade sem identificador para vincular ao ranking.");
  return `crm-won-sale-${cleanId}`;
 }

 function isAutomaticEntry(entry) {
  return Boolean(entry && (
   entry.recordType === RECORD_TYPE
   || (entry.source === SOURCE && entry.opportunityId)
   || String(entry.id || "").startsWith("crm-won-sale-")
  ));
 }

 function isActiveEntry(entry) {
  return Boolean(entry) && entry.status !== STATUS_CANCELLED;
 }

 function buildActiveEntry(input = {}) {
  const opportunityId = String(input.opportunityId || "").trim();
  const seller = String(input.seller || "").trim();
  const client = String(input.client || "").trim();
  const saleDate = String(input.saleDate || "").slice(0, 10);
  const amount = Math.round((Number(input.amount || 0) + Number.EPSILON) * 100) / 100;
  if (!opportunityId) throw new Error("Oportunidade sem identificador para vincular ao ranking.");
  if (!seller) throw new Error("Oportunidade ganha sem vendedor responsável.");
  if (!client) throw new Error("Oportunidade ganha sem cliente.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) throw new Error("Oportunidade ganha sem data válida.");
  if (amount <= 0) throw new Error("Oportunidade ganha sem valor positivo.");

  const existing = input.existing && typeof input.existing === "object" ? input.existing : {};
  const now = String(input.now || new Date().toISOString());
  return {
   ...existing,
   id: automaticEntryId(opportunityId),
   recordType: RECORD_TYPE,
   source: SOURCE,
   opportunityId,
   seller,
   sellerUserId: String(input.sellerUserId || ""),
   client,
   city: String(input.city || "").trim(),
   amount,
   saleDate,
   period: saleDate.slice(0, 7),
   status: STATUS_ACTIVE,
   cancelledAt: "",
   cancellationReason: "",
   createdAt: existing.createdAt || now,
   updatedAt: now,
  };
 }

 function buildCancelledEntry(existing, options = {}) {
  if (!isAutomaticEntry(existing)) throw new Error("Somente lançamentos automáticos do CRM podem ser cancelados por este fluxo.");
  const now = String(options.now || new Date().toISOString());
  return {
   ...existing,
   status: STATUS_CANCELLED,
   cancelledAt: existing.cancelledAt || now,
   cancellationReason: String(options.reason || "opportunity_no_longer_won"),
   updatedAt: now,
  };
 }

 return {
  RECORD_TYPE,
  STATUS_ACTIVE,
  STATUS_CANCELLED,
  automaticEntryId,
  isAutomaticEntry,
  isActiveEntry,
  buildActiveEntry,
  buildCancelledEntry,
 };
});
