(function initSyncConfirmation(root, factory) {
 if (typeof module === "object" && module.exports) module.exports = factory();
 else root.LumerisSyncConfirmation = factory();
}(typeof globalThis !== "undefined" ? globalThis : this, function buildSyncConfirmation() {
 "use strict";

 function confirmationError(message) {
  const error = new Error(message);
  error.code = "remote_confirmation_missing";
  return error;
 }

 function assertSyncAcknowledgement(result, expected = {}) {
  if (!result || result.ok !== true || result.committed !== true) {
   throw confirmationError("O servidor não confirmou a gravação da alteração");
  }

  const expectedMutationId = String(expected.mutationId || "");
  if (!expectedMutationId || String(result.mutationId || "") !== expectedMutationId) {
   throw confirmationError("A confirmação recebida não pertence à alteração enviada");
  }

  const revision = Number(result.revision);
  if (!Number.isInteger(revision) || revision < 0 || !String(result.version || "").trim()) {
   throw confirmationError("A confirmação do servidor não contém uma revisão válida");
  }

  if (Number.isInteger(expected.operationCount) && Number(result.operationCount) !== expected.operationCount) {
   throw confirmationError("O servidor não confirmou todas as operações enviadas");
  }

  return result;
 }

 return { assertSyncAcknowledgement };
}));
