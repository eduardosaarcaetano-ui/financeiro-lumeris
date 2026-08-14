"use strict";

const { withTransaction, query } = require("./_lib/db");
const engine = require("./_lib/syncEngine");
const { opportunityFolderName } = require("./_lib/attachments");
const { getJsonBody, sendJson } = require("./_lib/http");

const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const BACKUP_RETENTION = 576;
const MUTATION_RETENTION_DAYS = 30;

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method === "POST") return await handlePost(req, res);
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { ok: false, error: error.message || "internal_error" });
  }
};

async function handleGet(req, res) {
  const q = req.query || {};

  if (q.capabilities === "drive") {
    const meta = await readMetaRow();
    return sendJson(res, 200, {
      ok: true,
      capabilities: {
        driveUploads: true,
        syncMetadata: true,
        dataCache: false,
        version: "vercel-postgres-blob-1",
      },
      syncMetadata: meta,
      protocolVersion: engine.SYNC_PROTOCOL_VERSION,
      syncMode: "atomic-record-patch",
    });
  }

  if (q.meta === "1") {
    const meta = await readMetaRow();
    return sendJson(res, 200, { ok: true, syncMetadata: meta, protocolVersion: engine.SYNC_PROTOCOL_VERSION });
  }

  if (q.maintenance === "1") {
    const meta = await readMetaRow();
    return sendJson(res, 200, {
      ok: true,
      maintenance: meta.maintenance || engine.defaultMaintenanceState(),
      updatedAt: meta.updatedAt || "",
      version: meta.version || "",
      revision: meta.revision || 0,
      protocolVersion: engine.SYNC_PROTOCOL_VERSION,
    });
  }

  if (typeof q.knownVersion !== "undefined") {
    const meta = await readMetaRow();
    if (meta.initialized && String(q.knownVersion || "") === String(meta.version || "")) {
      return sendJson(res, 200, {
        ok: true,
        notModified: true,
        updatedAt: meta.updatedAt || "",
        version: meta.version || "",
        revision: meta.revision || 0,
        maintenance: meta.maintenance || engine.defaultMaintenanceState(),
        protocolVersion: engine.SYNC_PROTOCOL_VERSION,
        syncMode: "atomic-record-patch",
      });
    }
  }

  const stored = await readFullRow();
  return sendJson(res, 200, {
    ok: true,
    data: stored.data,
    updatedAt: stored.updatedAt,
    version: stored.version,
    revision: stored.revision,
    protocolVersion: engine.SYNC_PROTOCOL_VERSION,
    syncMode: "atomic-record-patch",
  });
}

async function handlePost(req, res) {
  const body = getJsonBody(req);

  if (body.action === "crm.createLeadFolder") {
    const folderName = opportunityFolderName(body);
    return sendJson(res, 200, {
      ok: true,
      folderId: folderName,
      folderUrl: folderName,
      folderName,
    });
  }

  if (body.action !== "sync.patch") {
    return sendJson(res, 200, {
      ok: false,
      error: "client_update_required",
      message: "Atualize a pagina para usar a sincronizacao segura por registro.",
      protocolVersion: engine.SYNC_PROTOCOL_VERSION,
    });
  }

  const result = await runSyncPatch(body);
  return sendJson(res, 200, result);
}

async function readMetaRow() {
  const result = await query(
    `select revision, version, updated_at, data -> 'maintenance' as maintenance from sync_state where id = 1`
  );
  const row = result.rows[0];
  return normalizeMetaRow(row);
}

async function readFullRow() {
  const result = await query(`select revision, version, updated_at, data from sync_state where id = 1`);
  const row = result.rows[0];
  return {
    revision: Number(row.revision || 0),
    version: row.version || engine.syncVersion(0, ""),
    updatedAt: row.updated_at ? row.updated_at.toISOString() : "",
    data: row.data || null,
  };
}

function normalizeMetaRow(row) {
  const revision = Number(row?.revision || 0);
  const updatedAt = row?.updated_at ? row.updated_at.toISOString() : "";
  const version = row?.version || engine.syncVersion(revision, updatedAt);
  return {
    initialized: Boolean(revision || updatedAt),
    revision,
    version,
    updatedAt,
    maintenance: row?.maintenance || engine.defaultMaintenanceState(),
  };
}

async function runSyncPatch(body) {
  return withTransaction(async (client) => {
    const storedResult = await client.query(
      `select revision, version, updated_at, data from sync_state where id = 1 for update`
    );
    const storedRow = storedResult.rows[0];
    const stored = {
      revision: Number(storedRow.revision || 0),
      version: storedRow.version || engine.syncVersion(0, ""),
      updatedAt: storedRow.updated_at ? storedRow.updated_at.toISOString() : "",
      data: storedRow.data || null,
    };

    const mutationId = String(body.mutationId || "").trim();
    let mutationAlreadyApplied = false;
    if (mutationId) {
      const existing = await client.query(`select 1 from sync_mutations where mutation_id = $1`, [mutationId]);
      mutationAlreadyApplied = existing.rowCount > 0;
    }

    const result = engine.computeSyncPatch(body, stored, { mutationAlreadyApplied });
    if (!result.ok || result.idempotent || result.skipWrite) {
      delete result.skipWrite;
      return result;
    }

    const now = new Date();
    const nextRevision = stored.revision + 1;
    const nextVersion = engine.syncVersion(nextRevision, now.toISOString());

    await maybeCreateBackup(client, stored);

    await client.query(
      `update sync_state set revision = $1, version = $2, updated_at = $3, data = $4 where id = 1`,
      [nextRevision, nextVersion, now.toISOString(), JSON.stringify(result.nextData)]
    );

    await client.query(
      `insert into sync_mutations (mutation_id, client_id, actor_id, actor_name, actor_username, view, scopes, operation_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (mutation_id) do nothing`,
      [
        mutationId,
        String(body.clientId || ""),
        String(body.actorId || ""),
        String(body.actorName || ""),
        String(body.actorUsername || "").trim().toLowerCase(),
        String(body.view || ""),
        JSON.stringify(engine.normalizeSyncScopes(body.scopes)),
        Array.isArray(body.operations) ? body.operations.length : 0,
      ]
    );

    await pruneOldMutations(client);

    return {
      ok: true,
      updatedAt: now.toISOString(),
      version: nextVersion,
      revision: nextRevision,
      data: result.nextData,
      protocolVersion: engine.SYNC_PROTOCOL_VERSION,
    };
  });
}

async function maybeCreateBackup(client, stored) {
  const last = await client.query(`select created_at from sync_state_backups order by created_at desc limit 1`);
  const lastAt = last.rows[0]?.created_at ? new Date(last.rows[0].created_at).getTime() : 0;
  if (lastAt && Date.now() - lastAt < BACKUP_INTERVAL_MS) return;

  await client.query(
    `insert into sync_state_backups (revision, version, updated_at, data) values ($1, $2, $3, $4)`,
    [stored.revision, stored.version, stored.updatedAt || null, JSON.stringify(stored.data)]
  );
  await client.query(
    `delete from sync_state_backups where id in (
       select id from sync_state_backups order by created_at desc offset $1
     )`,
    [BACKUP_RETENTION]
  );
}

async function pruneOldMutations(client) {
  await client.query(`delete from sync_mutations where created_at < now() - interval '${MUTATION_RETENTION_DAYS} days'`);
}
