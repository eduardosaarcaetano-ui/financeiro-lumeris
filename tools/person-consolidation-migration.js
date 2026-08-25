"use strict";

const crypto = require("crypto");
const personIdentity = require("../person-identity");
const { syncCanonical, syncChecksum, SYNC_PROTOCOL_VERSION } = require("../api/_lib/syncEngine");

const DEFAULT_ENDPOINT = "https://erp-lumeris.vercel.app/api/sync";
const ARRAY_FIELDS = [
  "people", "opportunities", "opportunityHistory", "sales", "salesRankingEntries",
  "transactions", "invoices", "projects", "protocols", "protocolHistory",
  "installations", "tasks", "stockItems", "stockMovements",
];

function parseArguments(argv) {
  const args = { endpoint: DEFAULT_ENDPOINT, apply: false, expectedRevision: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") args.apply = true;
    else if (value === "--endpoint") args.endpoint = String(argv[++index] || "").replace(/\/$/, "");
    else if (value === "--expected-revision") args.expectedRevision = Number(argv[++index]);
    else throw new Error(`Argumento desconhecido: ${value}`);
  }
  if (!args.endpoint) throw new Error("Endpoint obrigatorio.");
  if (args.apply && !Number.isInteger(args.expectedRevision)) {
    throw new Error("Use --expected-revision N ao aplicar a migracao.");
  }
  return args;
}

function indexById(records) {
  return new Map((Array.isArray(records) ? records : []).map((record) => [String(record?.id || ""), record]));
}

function buildOperations(before, after) {
  const operations = [];
  ARRAY_FIELDS.forEach((field) => {
    const previous = indexById(before[field]);
    const next = indexById(after[field]);
    previous.forEach((record, id) => {
      if (!id || next.has(id)) return;
      operations.push({
        field,
        type: "delete",
        id,
        baseExists: true,
        baseChecksum: syncChecksum(record),
        baseValue: record,
      });
    });
    next.forEach((record, id) => {
      if (!id) throw new Error(`Registro sem id em ${field}.`);
      const previousRecord = previous.get(id);
      if (previousRecord && syncCanonical(previousRecord) === syncCanonical(record)) return;
      operations.push({
        field,
        type: "upsert",
        id,
        value: record,
        baseExists: Boolean(previousRecord),
        baseChecksum: previousRecord ? syncChecksum(previousRecord) : "",
        baseValue: previousRecord,
      });
    });
  });
  return operations;
}

function countByField(state) {
  return Object.fromEntries(ARRAY_FIELDS.map((field) => [field, Array.isArray(state[field]) ? state[field].length : 0]));
}

function sum(records, property) {
  return Number((records || []).reduce((total, record) => total + Number(record?.[property] || 0), 0).toFixed(2));
}

function businessTotals(state) {
  return {
    transactions: sum(state.transactions, "amount"),
    sales: sum(state.sales, "total"),
    ranking: sum(state.salesRankingEntries, "amount"),
  };
}

function duplicateSummary(state) {
  const names = new Map();
  (state.people || []).forEach((person) => {
    const key = personIdentity.normalizeName(person?.name);
    if (!key) return;
    names.set(key, (names.get(key) || 0) + 1);
  });
  return Array.from(names.values()).filter((count) => count > 1).length;
}

function assertInvariants(before, after, report) {
  if (report.conflicts.length) throw new Error(`Conflitos de documento detectados: ${report.conflicts.length}.`);
  if (duplicateSummary(after) !== 0) throw new Error("Ainda existem nomes completos duplicados apos a simulacao.");
  const beforeCounts = countByField(before);
  const afterCounts = countByField(after);
  Object.keys(beforeCounts).forEach((field) => {
    if (field === "people") return;
    if (beforeCounts[field] !== afterCounts[field]) throw new Error(`Contagem alterada em ${field}.`);
  });
  if (syncCanonical(businessTotals(before)) !== syncCanonical(businessTotals(after))) {
    throw new Error("Totais financeiros mudaram durante a simulacao.");
  }
  if (afterCounts.people !== beforeCounts.people - report.mergedRecords) {
    throw new Error("Quantidade de pessoas consolidada diverge do relatorio.");
  }
}

async function fetchSnapshot(endpoint) {
  const response = await fetch(endpoint, { headers: { "cache-control": "no-cache" } });
  if (!response.ok) throw new Error(`GET ${endpoint} retornou HTTP ${response.status}.`);
  const payload = await response.json();
  if (!payload.ok || !payload.data) throw new Error(`Snapshot invalido: ${payload.error || "sem dados"}.`);
  return payload;
}

async function run(options) {
  const snapshot = await fetchSnapshot(options.endpoint);
  if (options.apply && snapshot.protocolVersion !== SYNC_PROTOCOL_VERSION) {
    throw new Error(`Protocolo em producao ${snapshot.protocolVersion}; esperado ${SYNC_PROTOCOL_VERSION}. Publique e valide o codigo antes da migracao.`);
  }
  if (options.apply && snapshot.revision !== options.expectedRevision) {
    throw new Error(`Revisao mudou: producao ${snapshot.revision}; esperada ${options.expectedRevision}. Nada foi gravado.`);
  }

  const before = snapshot.data;
  const mergedAt = new Date().toISOString();
  const consolidation = personIdentity.consolidatePeopleState(before, { mergedAt });
  const after = consolidation.state;
  assertInvariants(before, after, consolidation.report);
  const operations = buildOperations(before, after);
  if (operations.length > 5000) throw new Error(`Patch excede o limite: ${operations.length} operacoes.`);

  const summary = {
    mode: options.apply ? "apply" : "dry-run",
    endpoint: options.endpoint,
    revisionBefore: snapshot.revision,
    protocolVersion: snapshot.protocolVersion,
    peopleBefore: consolidation.report.peopleBefore,
    peopleAfter: consolidation.report.peopleAfter,
    mergedRecords: consolidation.report.mergedRecords,
    mergedGroups: consolidation.report.mergedGroups,
    conflicts: consolidation.report.conflicts.length,
    operations: operations.length,
    countsBefore: countByField(before),
    countsAfter: countByField(after),
    totalsBefore: businessTotals(before),
    totalsAfter: businessTotals(after),
    predictedChecksum: syncChecksum(after),
  };
  if (!options.apply) return summary;

  const mutationId = `person-consolidation-10.3-${crypto.randomUUID()}`;
  const response = await fetch(options.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "sync.patch",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      mutationId,
      clientId: "codex-production-migration-10.3",
      actorId: "adm",
      actorName: "Administrador",
      actorUsername: "adm",
      view: "controlled-person-consolidation",
      scopes: ["all"],
      operations,
      baseVersion: snapshot.version,
    }),
  });
  if (!response.ok) throw new Error(`POST retornou HTTP ${response.status}.`);
  const acknowledgement = await response.json();
  if (!acknowledgement.ok || !acknowledgement.committed || acknowledgement.mutationId !== mutationId || acknowledgement.operationCount !== operations.length) {
    throw new Error(`Migracao nao confirmada: ${JSON.stringify(acknowledgement)}`);
  }

  const verified = await fetchSnapshot(options.endpoint);
  if (verified.revision !== snapshot.revision + 1) throw new Error("Revisao final inesperada apos a migracao.");
  if (syncChecksum(verified.data) !== summary.predictedChecksum) throw new Error("Checksum final diverge do estado simulado.");
  assertInvariants(before, verified.data, consolidation.report);
  return {
    ...summary,
    mutationId,
    revisionAfter: verified.revision,
    versionAfter: verified.version,
    verifiedChecksum: syncChecksum(verified.data),
    verified: true,
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    });
}

module.exports = { ARRAY_FIELDS, buildOperations, businessTotals, countByField, duplicateSummary, assertInvariants, parseArguments, run };
