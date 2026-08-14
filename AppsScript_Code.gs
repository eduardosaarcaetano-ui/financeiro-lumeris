// Cole este código no editor de Apps Script (Extensões > Apps Script) de uma planilha Google.
// Ele guarda o estado inteiro do sistema (JSON) num arquivo no Google Drive (não numa célula
// da planilha), para não esbarrar no limite de 50.000 caracteres por célula conforme o
// histórico de movimentos bancários (OFX) for crescendo. A planilha só serve de "âncora"
// para o projeto do Apps Script e para achar a pasta onde o arquivo de dados fica salvo.

var DATA_FILE_NAME = "financeiro-lumeris-data.json";
var PREVIOUS_DATA_FILE_NAME = "financeiro-lumeris-last-good.json";
var CRM_ATTACHMENTS_ROOT_NAME = "Dados Oportunidades";
var SYNC_PROTOCOL_VERSION = 2;
var MAX_RECENT_MUTATIONS = 2000;
var SYNC_BACKUP_FOLDER_NAME = "ERP - Backups automaticos";
var SYNC_BACKUP_INTERVAL_MS = 5 * 60 * 1000;
var SYNC_BACKUP_RETENTION = 576;
var SYNC_METADATA_PROPERTY = "financeiroLumerisSyncMetadataV1";
var DATA_FILE_ID_PROPERTY = "financeiroLumerisDataFileIdV1";
var DATA_CACHE_MANIFEST_KEY = "financeiroLumerisDataCacheManifestV1";
var DATA_CACHE_CHUNK_PREFIX = "financeiroLumerisDataCacheChunkV1:";
var DATA_CACHE_CHUNK_SIZE = 80000;
var DATA_CACHE_TTL_SECONDS = 21600;

var SYNC_SCOPE_FIELDS = {
  crm: ["crmUnits", "crmPipelines", "opportunityStages", "opportunities", "opportunityHistory", "sales", "salesRankingEntries", "salesTargets", "sellers", "interactions", "tasks"],
  financeiro: ["transactions", "bankAccounts", "bankMovements", "bankApiConfigs", "invoices"],
  protocolo: ["protocols", "protocolHistory", "utilityCompanies", "protocolActivityTypes"],
  estoque: ["stockItems", "stockMovements", "stockLocations", "stockBaselineVersion"],
  projetos: ["projects", "costCenters", "installations", "installationWorkers"],
  config: ["users", "maintenance"],
};
var SYNC_SHARED_FIELDS = ["people"];

function doGet(e) {
  if (e && e.parameter && e.parameter.capabilities === "drive") {
    var capabilityMetadata = readSyncMetadata();
    return jsonResponse({
      ok: true,
      capabilities: {
        driveUploads: true,
        syncMetadata: true,
        dataCache: true,
        partialFields: "fields-v1",
        version: "sync-partial-fields-20260814",
      },
      syncMetadata: capabilityMetadata,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      syncMode: "atomic-record-patch",
    });
  }
  if (e && e.parameter && e.parameter.meta === "1") {
    return jsonResponse({
      ok: true,
      syncMetadata: readSyncMetadata(),
      protocolVersion: SYNC_PROTOCOL_VERSION,
      syncMode: "atomic-record-patch",
    });
  }
  if (e && e.parameter && e.parameter.maintenance === "1") {
    var maintenanceMetadata = readSyncMetadata();
    if (!maintenanceMetadata.initialized || maintenanceMetadata.dirty) {
      readDataFile();
      maintenanceMetadata = readSyncMetadata();
    }
    return jsonResponse({
      ok: true,
      maintenance: maintenanceMetadata.maintenance || defaultMaintenanceState(),
      updatedAt: maintenanceMetadata.updatedAt || "",
      version: maintenanceMetadata.version || "",
      revision: Number(maintenanceMetadata.revision || 0),
      protocolVersion: SYNC_PROTOCOL_VERSION,
    });
  }
  if (e && e.parameter && typeof e.parameter.knownVersion !== "undefined") {
    var conditionalMetadata = readSyncMetadata();
    if (
      conditionalMetadata.initialized &&
      !conditionalMetadata.dirty &&
      String(e.parameter.knownVersion || "") === String(conditionalMetadata.version || "")
    ) {
      return jsonResponse({
        ok: true,
        notModified: true,
        updatedAt: conditionalMetadata.updatedAt || "",
        version: conditionalMetadata.version || "",
        revision: Number(conditionalMetadata.revision || 0),
        maintenance: conditionalMetadata.maintenance || defaultMaintenanceState(),
        protocolVersion: SYNC_PROTOCOL_VERSION,
        syncMode: "atomic-record-patch",
      });
    }
    var knownRevision = Number(e.parameter.knownRevision || 0);
    var supportsPartialFields = e.parameter.partial === "fields-v1";
    var currentRevision = Number(conditionalMetadata.revision || 0);
    var fieldRevisions = conditionalMetadata.fieldRevisions || {};
    if (
      supportsPartialFields &&
      conditionalMetadata.initialized &&
      !conditionalMetadata.dirty &&
      knownRevision > 0 &&
      knownRevision < currentRevision &&
      Object.keys(fieldRevisions).length
    ) {
      // Leia o snapshot confirmado antes de decidir os campos. Uma gravacao pode
      // terminar entre a leitura da metadata e esta etapa; nesse caso usamos o
      // mapa da mesma revisao do snapshot para nao omitir a mudanca concorrente.
      var partialStored = readDataFile();
      var latestPartialMetadata = readSyncMetadata();
      var effectiveFieldRevisions = normalizeFieldRevisions(partialStored.fieldRevisions);
      if (
        !Object.keys(effectiveFieldRevisions).length &&
        String(latestPartialMetadata.version || "") === String(partialStored.version || "")
      ) {
        effectiveFieldRevisions = normalizeFieldRevisions(latestPartialMetadata.fieldRevisions);
      }
      if (!Object.keys(effectiveFieldRevisions).length) {
        return jsonResponse({
          ok: true,
          data: partialStored.data,
          updatedAt: partialStored.updatedAt || "",
          version: partialStored.version || "",
          revision: Number(partialStored.revision || 0),
          protocolVersion: SYNC_PROTOCOL_VERSION,
          syncMode: "atomic-record-patch",
        });
      }
      var changedFields = Object.keys(effectiveFieldRevisions).filter(function (field) {
        return Number(effectiveFieldRevisions[field] || 0) > knownRevision;
      });
      if (!changedFields.length) {
        return jsonResponse({
          ok: true,
          notModified: true,
          updatedAt: partialStored.updatedAt || "",
          version: partialStored.version || "",
          revision: Number(partialStored.revision || 0),
          maintenance: latestPartialMetadata.maintenance || conditionalMetadata.maintenance || defaultMaintenanceState(),
          protocolVersion: SYNC_PROTOCOL_VERSION,
          syncMode: "atomic-record-patch",
        });
      }
      var partialData = {};
      changedFields.forEach(function (field) {
        partialData[field] = partialStored.data && Object.prototype.hasOwnProperty.call(partialStored.data, field)
          ? partialStored.data[field]
          : null;
      });
      return jsonResponse({
        ok: true,
        partial: "fields-v1",
        changedFields: changedFields,
        data: partialData,
        updatedAt: partialStored.updatedAt || conditionalMetadata.updatedAt || "",
        version: partialStored.version || conditionalMetadata.version || "",
        revision: Number(partialStored.revision || currentRevision),
        maintenance: latestPartialMetadata.maintenance || conditionalMetadata.maintenance || defaultMaintenanceState(),
        protocolVersion: SYNC_PROTOCOL_VERSION,
        syncMode: "atomic-record-patch",
      });
    }
  }
  var stored = readDataFile();
  return jsonResponse({
    ok: true,
    data: stored.data,
    updatedAt: stored.updatedAt,
    version: stored.version || "",
    revision: Number(stored.revision || 0),
    protocolVersion: SYNC_PROTOCOL_VERSION,
    syncMode: "atomic-record-patch",
  });
}

function doPost(e) {
  var body = JSON.parse(e.postData.contents);

  // Anexos nao alteram o estado do ERP e nao devem bloquear gravacoes de outros setores.
  if (body.action === "crm.createLeadFolder") {
    return jsonResponse(createLeadFolder(body));
  }
  if (body.action === "crm.uploadLeadFile") {
    return jsonResponse(uploadLeadFile(body));
  }

  if (body.action !== "sync.patch") {
    return jsonResponse({
      ok: false,
      error: "client_update_required",
      message: "Atualize a pagina para usar a sincronizacao segura por registro.",
      protocolVersion: SYNC_PROTOCOL_VERSION,
    });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // A leitura, a mesclagem e a gravacao formam uma unica secao atomica.
    var stored = readDataFileUnderLock();
    return jsonResponse(applySyncPatch(body, stored));
  } finally {
    lock.releaseLock();
  }
}

function readDataFile() {
  var metadata = readSyncMetadata();
  var cached = metadata.initialized && !metadata.dirty
    ? readCachedData(metadata.version)
    : null;
  if (cached) return cached;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return readDataFileUnderLock();
  } finally {
    lock.releaseLock();
  }
}

function readDataFileUnderLock() {
  // Outra gravacao pode ter terminado enquanto a chamada aguardava o lock.
  var metadata = readSyncMetadata();
  var cached = metadata.initialized && !metadata.dirty
    ? readCachedData(metadata.version)
    : null;
  if (cached) return cached;

  var file = getDataFile();
  var content = file.getBlob().getDataAsString();
  if (!content) {
    var emptyStored = { data: null, updatedAt: "", version: "0:", revision: 0, fieldRevisions: {}, recentMutations: [] };
    cacheStoredData(emptyStored);
    publishSyncMetadata(emptyStored);
    return emptyStored;
  }
  var parsed;
  try {
    parsed = JSON.parse(content);
  } catch (parseError) {
    console.error("JSON principal corrompido; tentando restaurar last-good: " + parseError.message);
    var previous = readPreviousDataFile();
    if (!previous) throw parseError;
    return writeDataFile({
      revision: Math.max(Number(previous.revision || 0), Number(metadata.revision || 0)) + 1,
      updatedAt: new Date().toISOString(),
      data: previous.data || null,
      fieldRevisions: previous.fieldRevisions || {},
      recentMutations: previous.recentMutations || [],
    });
  }
  var revision = Number(parsed.revision || 0);
  var updatedAt = parsed.updatedAt || "";
  var stored = {
    data: parsed.data,
    updatedAt: updatedAt,
    version: parsed.version || syncVersion(revision, updatedAt),
    revision: revision,
    fieldRevisions: normalizeFieldRevisions(parsed.fieldRevisions),
    recentMutations: Array.isArray(parsed.recentMutations) ? parsed.recentMutations : [],
  };
  cacheStoredData(stored, JSON.stringify(stored));
  publishSyncMetadata(stored);
  return stored;
}

function writeDataFile(payload) {
  var revision = Number(payload.revision || 0);
  var updatedAt = payload.updatedAt || new Date().toISOString();
  var priorMetadata = readSyncMetadata();
  var changedFields = Array.isArray(payload.changedFields)
    ? payload.changedFields.filter(Boolean)
    : [];
  var fieldRevisions = normalizeFieldRevisions(payload.fieldRevisions || priorMetadata.fieldRevisions);
  if (!Object.keys(fieldRevisions).length) {
    // Na primeira gravacao apos a migracao, os campos que nao mudaram continuam
    // associados a revisao anterior. Assim quem ja estava atualizado recebe
    // apenas a alteracao nova, sem uma ultima descarga integral desnecessaria.
    var baselineRevision = changedFields.length
      ? Number(priorMetadata.revision || Math.max(0, revision - 1))
      : revision;
    fieldRevisions = {};
    Object.keys(payload.data || {}).forEach(function (field) { fieldRevisions[field] = baselineRevision; });
    changedFields.forEach(function (field) { fieldRevisions[field] = revision; });
  } else if (!changedFields.length) {
    fieldRevisions = {};
    Object.keys(payload.data || {}).forEach(function (field) { fieldRevisions[field] = revision; });
  } else {
    changedFields.forEach(function (field) { fieldRevisions[field] = revision; });
  }
  var stored = {
    revision: revision,
    version: payload.version || syncVersion(revision, updatedAt),
    updatedAt: updatedAt,
    data: payload.data || null,
    fieldRevisions: fieldRevisions,
    recentMutations: Array.isArray(payload.recentMutations) ? payload.recentMutations : [],
  };
  var file = getDataFile();
  var serialized = JSON.stringify(stored);
  publishDirtySyncMetadata(stored);
  file.setContent(serialized);
  cacheStoredData(stored, serialized);
  publishSyncMetadata(stored);
  return stored;
}

function defaultMaintenanceState() {
  return { enabled: false, message: "", startedAt: "", startedBy: "" };
}

function syncVersion(revision, updatedAt) {
  return String(Number(revision || 0)) + ":" + String(updatedAt || "");
}

function metadataFromStored(stored) {
  return {
    initialized: true,
    dirty: false,
    revision: Number(stored.revision || 0),
    version: stored.version || syncVersion(stored.revision, stored.updatedAt),
    updatedAt: stored.updatedAt || "",
    fieldRevisions: normalizeFieldRevisions(stored.fieldRevisions),
    maintenance: stored.data && stored.data.maintenance
      ? stored.data.maintenance
      : defaultMaintenanceState(),
  };
}

function normalizeFieldRevisions(value) {
  var source = value && typeof value === "object" ? value : {};
  var result = {};
  Object.keys(source).forEach(function (field) {
    var revision = Number(source[field] || 0);
    if (field && revision >= 0 && isFinite(revision)) result[field] = revision;
  });
  return result;
}

function normalizeSyncMetadata(metadata) {
  var value = metadata && typeof metadata === "object" ? metadata : {};
  var hasValidVersion = Boolean(String(value.version || ""));
  var dirty = Boolean(value.dirty || (value.initialized && !hasValidVersion));
  return {
    initialized: Boolean(value.initialized && hasValidVersion && !dirty),
    dirty: dirty,
    revision: Number(value.revision || 0),
    version: String(value.version || ""),
    updatedAt: String(value.updatedAt || ""),
    fieldRevisions: normalizeFieldRevisions(value.fieldRevisions),
    maintenance: value.maintenance && typeof value.maintenance === "object"
      ? value.maintenance
      : defaultMaintenanceState(),
  };
}

function readSyncMetadata() {
  // ScriptProperties e a fonte autoritativa deste pequeno registro. O cache
  // permanece apenas como espelho; usa-lo como fonte poderia ressuscitar uma
  // versao antiga durante uma gravacao concorrente.
  var raw;
  try {
    raw = PropertiesService.getScriptProperties().getProperty(SYNC_METADATA_PROPERTY);
  } catch (propertyError) {
    try {
      raw = CacheService.getScriptCache().get(SYNC_METADATA_PROPERTY);
    } catch (cacheError) {
      raw = null;
    }
  }
  if (!raw) {
    return normalizeSyncMetadata({
      initialized: false,
      revision: 0,
      version: "",
      updatedAt: "",
      maintenance: defaultMaintenanceState(),
    });
  }
  try {
    var metadata = normalizeSyncMetadata(JSON.parse(raw));
    return metadata;
  } catch (error) {
    return normalizeSyncMetadata({
      initialized: false,
      revision: 0,
      version: "",
      updatedAt: "",
      maintenance: defaultMaintenanceState(),
    });
  }
}

function clearDataCache() {
  var cache = CacheService.getScriptCache();
  var manifestRaw = cache.get(DATA_CACHE_MANIFEST_KEY);
  if (manifestRaw) {
    try {
      var manifest = JSON.parse(manifestRaw);
      var keys = [];
      for (var index = 0; index < Number(manifest.chunks || 0); index += 1) {
        keys.push(DATA_CACHE_CHUNK_PREFIX + manifest.version + ":" + index);
      }
      if (keys.length) cache.removeAll(keys);
    } catch (error) {
      // Remover o manifest ja impede reutilizacao de chunks incompletos.
    }
  }
  cache.remove(DATA_CACHE_MANIFEST_KEY);
}

// Execute manualmente no editor do Apps Script somente depois de restaurar ou
// substituir o JSON no Drive. A proxima leitura reconstrui versao e cache.
function rebuildSyncMetadataAndCache() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var previousMetadata = readSyncMetadata();
    clearDataCache();
    var properties = PropertiesService.getScriptProperties();
    properties.deleteProperty(SYNC_METADATA_PROPERTY);
    properties.deleteProperty(DATA_FILE_ID_PROPERTY);
    CacheService.getScriptCache().remove(SYNC_METADATA_PROPERTY);
    var restored = readDataFileUnderLock();
    return writeDataFile({
      revision: Math.max(Number(restored.revision || 0), Number(previousMetadata.revision || 0)) + 1,
      updatedAt: new Date().toISOString(),
      data: restored.data || null,
      fieldRevisions: restored.fieldRevisions || {},
      recentMutations: restored.recentMutations || [],
    });
  } finally {
    lock.releaseLock();
  }
}

function writeSyncMetadata(metadata) {
  var normalized = normalizeSyncMetadata(metadata);
  var serialized = JSON.stringify(normalized);
  PropertiesService.getScriptProperties().setProperty(SYNC_METADATA_PROPERTY, serialized);
  try {
    var cache = CacheService.getScriptCache();
    cache.remove(SYNC_METADATA_PROPERTY);
    cache.put(SYNC_METADATA_PROPERTY, serialized, DATA_CACHE_TTL_SECONDS);
  } catch (cacheError) {
    // O espelho e best-effort; ScriptProperties ja confirmou a gravacao.
  }
  return normalized;
}

function publishDirtySyncMetadata(stored) {
  var pending = metadataFromStored(stored);
  pending.initialized = false;
  pending.dirty = true;
  return writeSyncMetadata(pending);
}

function publishSyncMetadata(stored) {
  try {
    return writeSyncMetadata(metadataFromStored(stored));
  } catch (error) {
    console.error("Falha ao publicar metadata de sincronizacao: " + error.message);
    return metadataFromStored(stored);
  }
}

function cacheStoredData(stored, serializedValue) {
  try {
    var serialized = serializedValue || JSON.stringify(stored);
    var compressed = Utilities.gzip(Utilities.newBlob(serialized, "application/json"));
    var encoded = Utilities.base64Encode(compressed.getBytes());
    var chunkCount = Math.max(1, Math.ceil(encoded.length / DATA_CACHE_CHUNK_SIZE));
    var entries = {};
    for (var index = 0; index < chunkCount; index += 1) {
      entries[DATA_CACHE_CHUNK_PREFIX + stored.version + ":" + index] = encoded.substring(
        index * DATA_CACHE_CHUNK_SIZE,
        (index + 1) * DATA_CACHE_CHUNK_SIZE
      );
    }
    var cache = CacheService.getScriptCache();
    var previousManifestRaw = cache.get(DATA_CACHE_MANIFEST_KEY);
    cache.putAll(entries, DATA_CACHE_TTL_SECONDS);
    cache.put(DATA_CACHE_MANIFEST_KEY, JSON.stringify({
      version: stored.version || "",
      revision: Number(stored.revision || 0),
      chunks: chunkCount,
    }), DATA_CACHE_TTL_SECONDS);
    if (previousManifestRaw) {
      try {
        var previousManifest = JSON.parse(previousManifestRaw);
        if (previousManifest.version && previousManifest.version !== stored.version) {
          var oldKeys = [];
          for (var oldIndex = 0; oldIndex < Number(previousManifest.chunks || 0); oldIndex += 1) {
            oldKeys.push(DATA_CACHE_CHUNK_PREFIX + previousManifest.version + ":" + oldIndex);
          }
          if (oldKeys.length) cache.removeAll(oldKeys);
        }
      } catch (manifestError) {
        // O novo manifest ja esta valido; chunks antigos expiram automaticamente.
      }
    }
  } catch (error) {
    console.error("Falha ao guardar cache dos dados: " + error.message);
  }
}

function readCachedData(expectedVersion) {
  try {
    var cache = CacheService.getScriptCache();
    var manifestRaw = cache.get(DATA_CACHE_MANIFEST_KEY);
    if (!manifestRaw) return null;
    var manifest = JSON.parse(manifestRaw);
    if (expectedVersion && manifest.version !== expectedVersion) return null;
    var keys = [];
    for (var index = 0; index < Number(manifest.chunks || 0); index += 1) {
      keys.push(DATA_CACHE_CHUNK_PREFIX + manifest.version + ":" + index);
    }
    if (!keys.length) return null;
    var chunks = cache.getAll(keys);
    var encoded = keys.map(function (key) { return chunks[key] || ""; }).join("");
    if (!encoded || keys.some(function (key) { return !chunks[key]; })) return null;
    var bytes = Utilities.base64Decode(encoded);
    var serialized = Utilities.ungzip(Utilities.newBlob(bytes)).getDataAsString();
    var stored = JSON.parse(serialized);
    if (String(stored.version || "") !== String(manifest.version || "")) return null;
    return stored;
  } catch (error) {
    CacheService.getScriptCache().remove(DATA_CACHE_MANIFEST_KEY);
    return null;
  }
}

function writePreviousDataFile(stored) {
  var folder = getTargetFolder();
  var files = folder.getFilesByName(PREVIOUS_DATA_FILE_NAME);
  var file = files.hasNext()
    ? files.next()
    : folder.createFile(PREVIOUS_DATA_FILE_NAME, "", MimeType.PLAIN_TEXT);
  file.setContent(JSON.stringify({
    savedAt: new Date().toISOString(),
    revision: Number(stored.revision || 0),
    version: stored.version || "",
    updatedAt: stored.updatedAt || "",
    data: stored.data || null,
    fieldRevisions: stored.fieldRevisions || {},
    recentMutations: stored.recentMutations || [],
  }));
}

function readPreviousDataFile() {
  try {
    var folder = getTargetFolder();
    var files = folder.getFilesByName(PREVIOUS_DATA_FILE_NAME);
    if (!files.hasNext()) return null;
    var content = files.next().getBlob().getDataAsString();
    if (!content) return null;
    var parsed = JSON.parse(content);
    var revision = Number(parsed.revision || 0);
    var updatedAt = parsed.updatedAt || "";
    return {
      revision: revision,
      version: parsed.version || syncVersion(revision, updatedAt),
      updatedAt: updatedAt,
      data: parsed.data || null,
      fieldRevisions: normalizeFieldRevisions(parsed.fieldRevisions),
      recentMutations: Array.isArray(parsed.recentMutations) ? parsed.recentMutations : [],
    };
  } catch (error) {
    console.error("Falha ao ler o arquivo last-good: " + error.message);
    return null;
  }
}

function getDataFile() {
  var properties = PropertiesService.getScriptProperties();
  var storedId = properties.getProperty(DATA_FILE_ID_PROPERTY);
  if (storedId) {
    try {
      var storedFile = DriveApp.getFileById(storedId);
      if (storedFile.isTrashed()) throw new Error("Arquivo de dados esta na lixeira");
      return storedFile;
    } catch (error) {
      properties.deleteProperty(DATA_FILE_ID_PROPERTY);
    }
  }
  var folder = getTargetFolder();
  var files = folder.getFilesByName(DATA_FILE_NAME);
  if (files.hasNext()) {
    var existing = files.next();
    properties.setProperty(DATA_FILE_ID_PROPERTY, existing.getId());
    return existing;
  }
  var created = folder.createFile(DATA_FILE_NAME, JSON.stringify({ revision: 0, version: "0:", updatedAt: "", data: null, fieldRevisions: {} }), MimeType.PLAIN_TEXT);
  properties.setProperty(DATA_FILE_ID_PROPERTY, created.getId());
  return created;
}

function applySyncPatch(body, stored) {
  var mutationId = String(body.mutationId || "").trim();
  var operations = Array.isArray(body.operations) ? body.operations : [];
  var scopes = normalizeSyncScopes(body.scopes);

  if (Number(body.protocolVersion || 0) < SYNC_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: "client_update_required",
      message: "Atualize a pagina antes de salvar novos dados.",
      protocolVersion: SYNC_PROTOCOL_VERSION,
    };
  }
  var activeMaintenance = stored.data && stored.data.maintenance;
  var actorUsername = String(body.actorUsername || "").trim().toLowerCase();
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
  if (!operations.length) {
    return {
      ok: true,
      updatedAt: stored.updatedAt || "",
      version: stored.version || "",
      revision: Number(stored.revision || 0),
      data: stored.data || {},
      protocolVersion: SYNC_PROTOCOL_VERSION,
    };
  }
  if (operations.length > 5000) return { ok: false, error: "too_many_operations" };

  var recentMutations = Array.isArray(stored.recentMutations) ? stored.recentMutations.slice() : [];
  if (recentMutations.some(function (entry) { return entry.id === mutationId; })) {
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

  var allowedFields = syncAllowedFields(scopes);
  var working = cloneSyncValue(stored.data || {});
  var conflicts = [];
  var invalid = [];

  operations.forEach(function (operation) {
    var result = applyOneSyncOperation(working, operation, allowedFields);
    if (result.conflict) conflicts.push(result.conflict);
    if (result.invalid) invalid.push(result.invalid);
  });

  if (invalid.length) {
    return { ok: false, error: "invalid_patch", invalid: invalid };
  }
  if (conflicts.length) {
    return {
      ok: false,
      error: "record_conflict",
      conflicts: conflicts,
      updatedAt: stored.updatedAt || "",
      version: stored.version || "",
      revision: Number(stored.revision || 0),
      protocolVersion: SYNC_PROTOCOL_VERSION,
    };
  }

  var now = new Date().toISOString();
  recentMutations.push({
    id: mutationId,
    at: now,
    clientId: String(body.clientId || ""),
    actorId: String(body.actorId || ""),
    actorName: String(body.actorName || ""),
    actorUsername: actorUsername,
    view: String(body.view || ""),
    scopes: scopes,
    operationCount: operations.length,
  });
  if (recentMutations.length > MAX_RECENT_MUTATIONS) {
    recentMutations = recentMutations.slice(recentMutations.length - MAX_RECENT_MUTATIONS);
  }

  createSafetyBackupIfDue(stored);
  writePreviousDataFile(stored);
  var written = writeDataFile({
    revision: Number(stored.revision || 0) + 1,
    updatedAt: now,
    data: working,
    changedFields: operations.map(function (operation) { return String(operation.field || ""); }),
    recentMutations: recentMutations,
  });
  return {
    ok: true,
    updatedAt: written.updatedAt,
    version: written.version,
    revision: written.revision,
    data: working,
    protocolVersion: SYNC_PROTOCOL_VERSION,
  };
}

function normalizeSyncScopes(scopes) {
  var values = Array.isArray(scopes) ? scopes : [scopes];
  var result = [];
  values.forEach(function (scope) {
    if (scope === "all") {
      Object.keys(SYNC_SCOPE_FIELDS).forEach(function (item) {
        if (result.indexOf(item) < 0) result.push(item);
      });
      return;
    }
    if (SYNC_SCOPE_FIELDS[scope] && result.indexOf(scope) < 0) result.push(scope);
  });
  return result;
}

function syncAllowedFields(scopes) {
  var allowed = {};
  scopes.forEach(function (scope) {
    (SYNC_SCOPE_FIELDS[scope] || []).forEach(function (field) { allowed[field] = true; });
  });
  if (scopes.length) {
    SYNC_SHARED_FIELDS.forEach(function (field) { allowed[field] = true; });
  }
  return allowed;
}

function applyOneSyncOperation(state, operation, allowedFields) {
  var field = String(operation.field || "");
  var type = String(operation.type || "");
  if (!allowedFields[field]) return { invalid: { field: field, reason: "field_not_allowed" } };

  if (type === "replace") {
    var currentScalar = state[field];
    if (syncChecksum(currentScalar) === syncChecksum(operation.value)) return {};
    if (syncChecksum(currentScalar) !== String(operation.baseChecksum || "")) {
      return { conflict: { field: field, id: "", reason: "scalar_changed" } };
    }
    state[field] = cloneSyncValue(operation.value);
    return {};
  }

  if (type !== "upsert" && type !== "delete") {
    return { invalid: { field: field, reason: "invalid_operation" } };
  }
  if (!Array.isArray(state[field])) state[field] = [];

  var id = String(operation.id || "");
  if (!id) return { invalid: { field: field, reason: "missing_id" } };
  var index = state[field].findIndex(function (item) { return item && String(item.id || "") === id; });
  var current = index >= 0 ? state[field][index] : undefined;
  var baseExists = Boolean(operation.baseExists);
  var currentMatchesBase = baseExists
    ? index >= 0 && syncChecksum(current) === String(operation.baseChecksum || "")
    : index < 0;

  if (type === "delete") {
    if (index < 0) return {};
    if (!currentMatchesBase) {
      return { conflict: { field: field, id: id, reason: index < 0 ? "already_deleted" : "changed_before_delete" } };
    }
    state[field].splice(index, 1);
    return {};
  }

  var incoming = cloneSyncValue(operation.value);
  if (!incoming || String(incoming.id || "") !== id) {
    return { invalid: { field: field, id: id, reason: "id_mismatch" } };
  }

  if (index >= 0 && syncChecksum(current) === syncChecksum(incoming)) return {};

  if (currentMatchesBase) {
    if (index >= 0) state[field][index] = incoming;
    else state[field].push(incoming);
    return {};
  }

  if (baseExists && index >= 0 && operation.baseValue) {
    var mergeResult = threeWayMergeSyncRecord(operation.baseValue, incoming, current);
    if (!mergeResult.conflictingFields.length) {
      state[field][index] = mergeResult.value;
      return {};
    }
    return {
      conflict: {
        field: field,
        id: id,
        reason: "same_fields_changed",
        conflictingFields: mergeResult.conflictingFields,
      },
    };
  }

  return { conflict: { field: field, id: id, reason: baseExists ? "record_deleted" : "id_already_exists" } };
}

function threeWayMergeSyncRecord(baseValue, localValue, remoteValue) {
  var base = baseValue || {};
  var local = localValue || {};
  var remote = remoteValue || {};
  var keys = {};
  Object.keys(base).forEach(function (key) { keys[key] = true; });
  Object.keys(local).forEach(function (key) { keys[key] = true; });
  Object.keys(remote).forEach(function (key) { keys[key] = true; });

  var merged = {};
  var conflictingFields = [];
  Object.keys(keys).forEach(function (key) {
    if (key === "updatedAt") {
      merged[key] = [base[key], local[key], remote[key]].filter(Boolean).sort().pop() || "";
      return;
    }
    if (key === "createdAt") {
      merged[key] = remote[key] || local[key] || base[key] || "";
      return;
    }
    var localChanged = syncCanonical(local[key]) !== syncCanonical(base[key]);
    var remoteChanged = syncCanonical(remote[key]) !== syncCanonical(base[key]);
    if (localChanged && remoteChanged && syncCanonical(local[key]) !== syncCanonical(remote[key])) {
      conflictingFields.push(key);
      merged[key] = remote[key];
      return;
    }
    merged[key] = cloneSyncValue(localChanged ? local[key] : remote[key]);
  });
  return { value: merged, conflictingFields: conflictingFields };
}

function syncChecksum(value) {
  var text = syncCanonical(value);
  var hash = 2166136261;
  for (var i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return ("00000000" + hash.toString(16)).slice(-8);
}

function syncCanonical(value) {
  if (value === undefined) return "__undefined__";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(syncCanonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(function (key) {
    return JSON.stringify(key) + ":" + syncCanonical(value[key]);
  }).join(",") + "}";
}

function cloneSyncValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function createSafetyBackupIfDue(stored) {
  try {
    var properties = PropertiesService.getScriptProperties();
    var lastBackup = Number(properties.getProperty("lastAutomaticSyncBackup") || 0);
    var now = Date.now();
    if (lastBackup && now - lastBackup < SYNC_BACKUP_INTERVAL_MS) return;

    var baseFolder = getTargetFolder();
    var folders = baseFolder.getFoldersByName(SYNC_BACKUP_FOLDER_NAME);
    var backupFolder = folders.hasNext() ? folders.next() : baseFolder.createFolder(SYNC_BACKUP_FOLDER_NAME);
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "America/Sao_Paulo", "yyyy-MM-dd_HH-mm-ss");
    backupFolder.createFile(
      "financeiro-lumeris-backup_" + stamp + ".json",
      JSON.stringify({
        revision: Number(stored.revision || 0),
        version: stored.version || "",
        updatedAt: stored.updatedAt || "",
        data: stored.data || null,
        fieldRevisions: stored.fieldRevisions || {},
        recentMutations: stored.recentMutations || [],
      }),
      MimeType.PLAIN_TEXT
    );
    properties.setProperty("lastAutomaticSyncBackup", String(now));
    trimAutomaticBackups(backupFolder);
  } catch (error) {
    console.error("Falha ao criar backup automatico: " + error.message);
  }
}

function trimAutomaticBackups(folder) {
  var files = [];
  var iterator = folder.getFiles();
  while (iterator.hasNext()) {
    var file = iterator.next();
    if (file.getName().indexOf("financeiro-lumeris-backup_") === 0) files.push(file);
  }
  files.sort(function (a, b) { return b.getDateCreated().getTime() - a.getDateCreated().getTime(); });
  files.slice(SYNC_BACKUP_RETENTION).forEach(function (file) { file.setTrashed(true); });
}

function createLeadFolder(body) {
  var root = getCrmAttachmentsRootFolder();
  var folderName = getOpportunityDriveFolderName(body);
  var folders = root.getFoldersByName(folderName);
  var folder = folders.hasNext() ? folders.next() : root.createFolder(folderName);
  return {
    ok: true,
    folderId: folder.getId(),
    folderUrl: folder.getUrl(),
    folderName: folder.getName(),
  };
}

function getOpportunityDriveFolderName(body) {
  var clientName = String(body.clientName || "").trim();
  var opportunityNumber = String(body.opportunityNumber || "").trim();
  if (clientName && opportunityNumber) {
    return sanitizeDriveName(clientName + " - " + opportunityNumber);
  }
  return sanitizeDriveName(body.folderName || clientName || opportunityNumber || "Oportunidade sem nome");
}

function uploadLeadFile(body) {
  if (!body.base64) {
    return { ok: false, error: "Arquivo vazio." };
  }
  var folder = getFolderFromUrl(body.folderUrl);
  if (!folder) {
    folder = createLeadFolder(body).folderId;
    folder = DriveApp.getFolderById(folder);
  }
  var bytes = Utilities.base64Decode(body.base64);
  var blob = Utilities.newBlob(bytes, body.mimeType || "application/octet-stream", sanitizeDriveName(body.fileName || "arquivo"));
  var file = folder.createFile(blob);
  return {
    ok: true,
    fileId: file.getId(),
    fileUrl: file.getUrl(),
    fileName: file.getName(),
    folderId: folder.getId(),
    folderUrl: folder.getUrl(),
  };
}

function getCrmAttachmentsRootFolder() {
  var base = getTargetFolder();
  var folders = base.getFoldersByName(CRM_ATTACHMENTS_ROOT_NAME);
  if (folders.hasNext()) {
    return folders.next();
  }
  return base.createFolder(CRM_ATTACHMENTS_ROOT_NAME);
}

function getFolderFromUrl(url) {
  var id = extractDriveId(url);
  if (!id) return null;
  try {
    return DriveApp.getFolderById(id);
  } catch (err) {
    return null;
  }
}

function extractDriveId(url) {
  var text = String(url || "");
  var match = text.match(/\/folders\/([a-zA-Z0-9_-]+)/) || text.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : "";
}

function sanitizeDriveName(name) {
  return String(name || "Sem nome").replace(/[\\/:*?"<>|#%{}~&]/g, " ").replace(/\s+/g, " ").trim().substring(0, 140);
}

function getTargetFolder() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ssFile = DriveApp.getFileById(ss.getId());
    var parents = ssFile.getParents();
    if (parents.hasNext()) {
      return parents.next();
    }
  } catch (err) {
    // Sem planilha ativa (script standalone) — cai para a raiz do Drive abaixo.
  }
  return DriveApp.getRootFolder();
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
