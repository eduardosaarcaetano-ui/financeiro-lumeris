// Cole este código no editor de Apps Script (Extensões > Apps Script) de uma planilha Google.
// Ele guarda o estado inteiro do sistema (JSON) num arquivo no Google Drive (não numa célula
// da planilha), para não esbarrar no limite de 50.000 caracteres por célula conforme o
// histórico de movimentos bancários (OFX) for crescendo. A planilha só serve de "âncora"
// para o projeto do Apps Script e para achar a pasta onde o arquivo de dados fica salvo.

var DATA_FILE_NAME = "financeiro-lumeris-data.json";
var PREVIOUS_DATA_FILE_NAME = "financeiro-lumeris-last-good.json";
var CRM_ATTACHMENTS_ROOT_NAME = "CRM - Anexos Lumeris";
var SYNC_PROTOCOL_VERSION = 2;
var MAX_RECENT_MUTATIONS = 2000;
var SYNC_BACKUP_FOLDER_NAME = "ERP - Backups automaticos";
var SYNC_BACKUP_INTERVAL_MS = 5 * 60 * 1000;
var SYNC_BACKUP_RETENTION = 576;

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
    return jsonResponse({
      ok: true,
      capabilities: {
        driveUploads: true,
        version: "crm-drive-attachments-20260715",
      },
    });
  }
  if (e && e.parameter && e.parameter.maintenance === "1") {
    var maintenanceStored = readDataFile();
    var maintenance = maintenanceStored.data && maintenanceStored.data.maintenance
      ? maintenanceStored.data.maintenance
      : { enabled: false, message: "", startedAt: "", startedBy: "" };
    return jsonResponse({
      ok: true,
      maintenance: maintenance,
      updatedAt: maintenanceStored.updatedAt || "",
      protocolVersion: SYNC_PROTOCOL_VERSION,
    });
  }
  var stored = readDataFile();
  return jsonResponse({
    ok: true,
    data: stored.data,
    updatedAt: stored.updatedAt,
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
    var stored = readDataFile();
    return jsonResponse(applySyncPatch(body, stored));
  } finally {
    lock.releaseLock();
  }
}

function readDataFile() {
  var file = getDataFile();
  var content = file.getBlob().getDataAsString();
  if (!content) {
    return { data: null, updatedAt: "", recentMutations: [] };
  }
  var parsed = JSON.parse(content);
  return {
    data: parsed.data,
    updatedAt: parsed.updatedAt || "",
    recentMutations: Array.isArray(parsed.recentMutations) ? parsed.recentMutations : [],
  };
}

function writeDataFile(payload) {
  var file = getDataFile();
  file.setContent(JSON.stringify(payload));
}

function writePreviousDataFile(stored) {
  var folder = getTargetFolder();
  var files = folder.getFilesByName(PREVIOUS_DATA_FILE_NAME);
  var file = files.hasNext()
    ? files.next()
    : folder.createFile(PREVIOUS_DATA_FILE_NAME, "", MimeType.PLAIN_TEXT);
  file.setContent(JSON.stringify({
    savedAt: new Date().toISOString(),
    updatedAt: stored.updatedAt || "",
    data: stored.data || null,
    recentMutations: stored.recentMutations || [],
  }));
}

function getDataFile() {
  var folder = getTargetFolder();
  var files = folder.getFilesByName(DATA_FILE_NAME);
  if (files.hasNext()) {
    return files.next();
  }
  return folder.createFile(DATA_FILE_NAME, JSON.stringify({ updatedAt: "", data: null }), MimeType.PLAIN_TEXT);
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
      data: stored.data || {},
      protocolVersion: SYNC_PROTOCOL_VERSION,
    };
  }
  if (operations.length > 5000) return { ok: false, error: "too_many_operations" };

  var recentMutations = Array.isArray(stored.recentMutations) ? stored.recentMutations : [];
  if (recentMutations.some(function (entry) { return entry.id === mutationId; })) {
    return {
      ok: true,
      idempotent: true,
      updatedAt: stored.updatedAt || "",
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
  writeDataFile({ updatedAt: now, data: working, recentMutations: recentMutations });
  return {
    ok: true,
    updatedAt: now,
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
      JSON.stringify({ updatedAt: stored.updatedAt || "", data: stored.data || null }),
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
  var folderName = sanitizeDriveName(body.folderName || body.clientName || "Lead sem nome");
  var folders = root.getFoldersByName(folderName);
  var folder = folders.hasNext() ? folders.next() : root.createFolder(folderName);
  return {
    ok: true,
    folderId: folder.getId(),
    folderUrl: folder.getUrl(),
    folderName: folder.getName(),
  };
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
