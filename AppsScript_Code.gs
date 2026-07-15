// Cole este código no editor de Apps Script (Extensões > Apps Script) de uma planilha Google.
// Ele guarda o estado inteiro do sistema (JSON) num arquivo no Google Drive (não numa célula
// da planilha), para não esbarrar no limite de 50.000 caracteres por célula conforme o
// histórico de movimentos bancários (OFX) for crescendo. A planilha só serve de "âncora"
// para o projeto do Apps Script e para achar a pasta onde o arquivo de dados fica salvo.

var DATA_FILE_NAME = "financeiro-lumeris-data.json";
var CRM_ATTACHMENTS_ROOT_NAME = "CRM - Anexos Lumeris";

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
  var stored = readDataFile();
  return jsonResponse({
    ok: true,
    data: stored.data,
    updatedAt: stored.updatedAt,
  });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var body = JSON.parse(e.postData.contents);

    if (body.action === "crm.createLeadFolder") {
      return jsonResponse(createLeadFolder(body));
    }

    if (body.action === "crm.uploadLeadFile") {
      return jsonResponse(uploadLeadFile(body));
    }

    var stored = readDataFile();

    if (body.baseUpdatedAt && stored.updatedAt && body.baseUpdatedAt !== stored.updatedAt) {
      return jsonResponse({ ok: false, error: "conflict", updatedAt: stored.updatedAt });
    }

    var now = new Date().toISOString();
    writeDataFile({ updatedAt: now, data: body.data });
    return jsonResponse({ ok: true, updatedAt: now });
  } finally {
    lock.releaseLock();
  }
}

function readDataFile() {
  var file = getDataFile();
  var content = file.getBlob().getDataAsString();
  if (!content) {
    return { data: null, updatedAt: "" };
  }
  var parsed = JSON.parse(content);
  return { data: parsed.data, updatedAt: parsed.updatedAt || "" };
}

function writeDataFile(payload) {
  var file = getDataFile();
  file.setContent(JSON.stringify(payload));
}

function getDataFile() {
  var folder = getTargetFolder();
  var files = folder.getFilesByName(DATA_FILE_NAME);
  if (files.hasNext()) {
    return files.next();
  }
  return folder.createFile(DATA_FILE_NAME, JSON.stringify({ updatedAt: "", data: null }), MimeType.PLAIN_TEXT);
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
