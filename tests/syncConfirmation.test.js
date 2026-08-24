"use strict";

const assert = require("node:assert/strict");
const { assertSyncAcknowledgement } = require("../sync-confirmation");

const mutationId = "mutation-crm-20260824";
const acknowledgement = {
  ok: true,
  committed: true,
  mutationId,
  operationCount: 2,
  revision: 3462,
  version: "3462:2026-08-24T12:00:00.000Z",
};

assert.equal(assertSyncAcknowledgement(acknowledgement, { mutationId, operationCount: 2 }), acknowledgement);

[
  [{ ...acknowledgement, committed: false }, { mutationId, operationCount: 2 }],
  [{ ...acknowledgement, mutationId: "outra-mutacao" }, { mutationId, operationCount: 2 }],
  [{ ...acknowledgement, operationCount: 1 }, { mutationId, operationCount: 2 }],
  [{ ...acknowledgement, version: "" }, { mutationId, operationCount: 2 }],
].forEach(([result, expected]) => {
  assert.throws(
    () => assertSyncAcknowledgement(result, expected),
    (error) => error?.code === "remote_confirmation_missing",
  );
});

console.log("syncConfirmation: recibo remoto e 4 falhas de confirmação validados");
