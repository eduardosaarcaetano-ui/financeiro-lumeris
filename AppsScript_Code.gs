// Cole este código no editor de Apps Script (Extensões > Apps Script) de uma planilha Google.
// Ele guarda o estado inteiro do sistema (JSON) num arquivo no Google Drive (não numa célula
// da planilha), para não esbarrar no limite de 50.000 caracteres por célula conforme o
// histórico de movimentos bancários (OFX) for crescendo. A planilha só serve de "âncora"
// para o projeto do Apps Script e para achar a pasta onde o arquivo de dados fica salvo.

var DATA_FILE_NAME = "financeiro-lumeris-data.json";

function doGet() {
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
