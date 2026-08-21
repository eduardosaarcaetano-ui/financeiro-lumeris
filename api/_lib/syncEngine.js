"use strict";

// Porte do protocolo de sync que vivia em AppsScript_Code.gs (applySyncPatch e
// vizinhas). Mantido como logica pura (sem I/O) - quem le/grava o Postgres e
// gerencia a transacao/lock e o handler em api/sync.js.

// Incrementar esta versao bloqueia escritores antigos no servidor. Isso e
// intencional: uma TV/aba com JavaScript em cache nao pode continuar gerando
// gravacoes depois que o mecanismo de sincronizacao foi corrigido.
const SYNC_PROTOCOL_VERSION = 7;

const SYNC_SCOPE_FIELDS = {
  crm: ["crmUnits", "crmPipelines", "opportunityStages", "opportunities", "opportunityHistory", "sales", "salesRankingEntries", "salesTargets", "sellers", "interactions", "tasks"],
  financeiro: ["transactions", "bankAccounts", "bankMovements", "bankApiConfigs", "invoices"],
  protocolo: ["protocols", "protocolHistory", "utilityCompanies", "protocolActivityTypes"],
  estoque: ["stockItems", "stockMovements", "stockLocations", "stockBaselineVersion"],
  projetos: ["projects", "costCenters", "installations", "installationWorkers"],
  config: ["users", "maintenance"],
};
const SYNC_SHARED_FIELDS = ["people"];

function defaultMaintenanceState() {
  return { enabled: false, message: "", startedAt: "", startedBy: "" };
}

function syncVersion(revision, updatedAt) {
  return String(Number(revision || 0)) + ":" + String(updatedAt || "");
}

function cloneSyncValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function syncCanonical(value) {
  if (value === undefined) return "__undefined__";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(syncCanonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + syncCanonical(value[key])).join(",") + "}";
}

function syncChecksum(value) {
  const text = syncCanonical(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return ("00000000" + hash.toString(16)).slice(-8);
}

function normalizeSyncScopes(scopes) {
  const values = Array.isArray(scopes) ? scopes : [scopes];
  const result = [];
  values.forEach((scope) => {
    if (scope === "all") {
      Object.keys(SYNC_SCOPE_FIELDS).forEach((item) => {
        if (result.indexOf(item) < 0) result.push(item);
      });
      return;
    }
    if (SYNC_SCOPE_FIELDS[scope] && result.indexOf(scope) < 0) result.push(scope);
  });
  return result;
}

function syncAllowedFields(scopes) {
  const allowed = {};
  scopes.forEach((scope) => {
    (SYNC_SCOPE_FIELDS[scope] || []).forEach((field) => { allowed[field] = true; });
  });
  if (scopes.length) {
    SYNC_SHARED_FIELDS.forEach((field) => { allowed[field] = true; });
  }
  return allowed;
}

function threeWayMergeSyncRecord(baseValue, localValue, remoteValue) {
  const base = baseValue || {};
  const local = localValue || {};
  const remote = remoteValue || {};
  const keys = {};
  Object.keys(base).forEach((key) => { keys[key] = true; });
  Object.keys(local).forEach((key) => { keys[key] = true; });
  Object.keys(remote).forEach((key) => { keys[key] = true; });

  const merged = {};
  const conflictingFields = [];
  Object.keys(keys).forEach((key) => {
    if (key === "updatedAt") {
      merged[key] = [base[key], local[key], remote[key]].filter(Boolean).sort().pop() || "";
      return;
    }
    if (key === "createdAt") {
      merged[key] = remote[key] || local[key] || base[key] || "";
      return;
    }
    const localChanged = syncCanonical(local[key]) !== syncCanonical(base[key]);
    const remoteChanged = syncCanonical(remote[key]) !== syncCanonical(base[key]);
    if (localChanged && remoteChanged && syncCanonical(local[key]) !== syncCanonical(remote[key])) {
      conflictingFields.push(key);
      merged[key] = remote[key];
      return;
    }
    merged[key] = cloneSyncValue(localChanged ? local[key] : remote[key]);
  });
  return { value: merged, conflictingFields };
}

function applyOneSyncOperation(state, operation, allowedFields) {
  const field = String(operation.field || "");
  const type = String(operation.type || "");
  if (!allowedFields[field]) return { invalid: { field, reason: "field_not_allowed" } };

  if (type === "replace") {
    const currentScalar = state[field];
    if (syncChecksum(currentScalar) === syncChecksum(operation.value)) return {};
    if (syncChecksum(currentScalar) !== String(operation.baseChecksum || "")) {
      return { conflict: { field, id: "", reason: "scalar_changed" } };
    }
    state[field] = cloneSyncValue(operation.value);
    return {};
  }

  if (type !== "upsert" && type !== "delete") {
    return { invalid: { field, reason: "invalid_operation" } };
  }
  if (!Array.isArray(state[field])) state[field] = [];

  const id = String(operation.id || "");
  if (!id) return { invalid: { field, reason: "missing_id" } };
  const index = state[field].findIndex((item) => item && String(item.id || "") === id);
  const current = index >= 0 ? state[field][index] : undefined;
  const baseExists = Boolean(operation.baseExists);
  const currentMatchesBase = baseExists
    ? index >= 0 && syncChecksum(current) === String(operation.baseChecksum || "")
    : index < 0;

  if (type === "delete") {
    if (index < 0) return {};
    if (!currentMatchesBase) {
      return { conflict: { field, id, reason: index < 0 ? "already_deleted" : "changed_before_delete" } };
    }
    state[field].splice(index, 1);
    return {};
  }

  const incoming = cloneSyncValue(operation.value);
  if (!incoming || String(incoming.id || "") !== id) {
    return { invalid: { field, id, reason: "id_mismatch" } };
  }

  if (index >= 0 && syncChecksum(current) === syncChecksum(incoming)) return {};

  if (currentMatchesBase) {
    if (index >= 0) state[field][index] = incoming;
    else state[field].push(incoming);
    return {};
  }

  if (baseExists && index >= 0 && operation.baseValue) {
    const mergeResult = threeWayMergeSyncRecord(operation.baseValue, incoming, current);
    if (!mergeResult.conflictingFields.length) {
      state[field][index] = mergeResult.value;
      return {};
    }
    return {
      conflict: {
        field,
        id,
        reason: "same_fields_changed",
        conflictingFields: mergeResult.conflictingFields,
      },
    };
  }

  return { conflict: { field, id, reason: baseExists ? "record_deleted" : "id_already_exists" } };
}

// Calcula o resultado do patch a partir do estado atual (`stored`) e do corpo
// da requisicao. Nao toca banco - quem chama decide o que persistir a partir
// do campo `nextData` (quando ok=true e nao idempotente/vazio).
function computeSyncPatch(body, stored, { mutationAlreadyApplied = false } = {}) {
  const operations = Array.isArray(body.operations) ? body.operations : [];
  const scopes = normalizeSyncScopes(body.scopes);
  const mutationId = String(body.mutationId || "").trim();

  if (Number(body.protocolVersion || 0) < SYNC_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: "client_update_required",
      message: "Atualize a pagina antes de salvar novos dados.",
      protocolVersion: SYNC_PROTOCOL_VERSION,
    };
  }

  const activeMaintenance = stored.data && stored.data.maintenance;
  const actorUsername = String(body.actorUsername || "").trim().toLowerCase();
  if (activeMaintenance && activeMaintenance.enabled && actorUsername !== "adm") {
    return {
      ok: false,
      error: "maintenance_active",
      message: activeMaintenance.message || "Sistema em manutencao. Aguarde a liberacao do administrador.",
      maintenance: activeMaintenance,
      updatedAt: stored.updatedAt || "",
      protocolVersion: SYNC_PROTOCOL_VERSION,
    };
  }

  if (!mutationId) return { ok: false, error: "missing_mutation_id" };
  if (!scopes.length) return { ok: false, error: "missing_scope" };

  if (mutationAlreadyApplied) {
    return {
      ok: true,
      idempotent: true,
      updatedAt: stored.updatedAt || "",
      version: stored.version || "",
      revision: Number(stored.revision || 0),
      data: stored.data || {},
      protocolVersion: SYNC_PROTOCOL_VERSION,
    };
  }

  if (!operations.length) {
    return {
      ok: true,
      updatedAt: stored.updatedAt || "",
      version: stored.version || "",
      revision: Number(stored.revision || 0),
      data: stored.data || {},
      protocolVersion: SYNC_PROTOCOL_VERSION,
      skipWrite: true,
    };
  }
  if (operations.length > 5000) return { ok: false, error: "too_many_operations" };

  const allowedFields = syncAllowedFields(scopes);
  const working = cloneSyncValue(stored.data || {});
  const conflicts = [];
  const invalid = [];

  operations.forEach((operation) => {
    const result = applyOneSyncOperation(working, operation, allowedFields);
    if (result.conflict) conflicts.push(result.conflict);
    if (result.invalid) invalid.push(result.invalid);
  });

  if (invalid.length) {
    return { ok: false, error: "invalid_patch", invalid };
  }
  if (conflicts.length) {
    return {
      ok: false,
      error: "record_conflict",
      conflicts,
      updatedAt: stored.updatedAt || "",
      version: stored.version || "",
      revision: Number(stored.revision || 0),
      protocolVersion: SYNC_PROTOCOL_VERSION,
    };
  }

  // Um cliente antigo pode reenviar operacoes que ja representam exatamente o
  // estado salvo (por exemplo, apos recarregamento automatico da pagina). Nao
  // avance revisao, nao crie backup e nao grave no Neon quando nenhum dado real
  // mudou. Essa protecao permanece valida mesmo para clientes atuais.
  if (syncCanonical(working) === syncCanonical(stored.data || {})) {
    return {
      ok: true,
      updatedAt: stored.updatedAt || "",
      version: stored.version || "",
      revision: Number(stored.revision || 0),
      data: stored.data || {},
      protocolVersion: SYNC_PROTOCOL_VERSION,
      skipWrite: true,
    };
  }

  return {
    ok: true,
    nextData: working,
    protocolVersion: SYNC_PROTOCOL_VERSION,
  };
}

module.exports = {
  SYNC_PROTOCOL_VERSION,
  SYNC_SCOPE_FIELDS,
  SYNC_SHARED_FIELDS,
  defaultMaintenanceState,
  syncVersion,
  cloneSyncValue,
  syncCanonical,
  syncChecksum,
  normalizeSyncScopes,
  syncAllowedFields,
  threeWayMergeSyncRecord,
  applyOneSyncOperation,
  computeSyncPatch,
};
