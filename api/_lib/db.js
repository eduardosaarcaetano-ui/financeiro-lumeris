"use strict";

const { Pool } = require("pg");

const CONNECTION_STRING =
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  "";

let pool = null;
let schemaReadyPromise = null;

function getPool() {
  if (!CONNECTION_STRING) {
    throw new Error("POSTGRES_URL nao configurada. Conecte um banco Postgres (Neon) ao projeto na Vercel.");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: CONNECTION_STRING,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
  }
  return pool;
}

async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = getPool().query(`
      create table if not exists sync_state (
        id integer primary key default 1,
        revision bigint not null default 0,
        version text not null default '0:',
        updated_at timestamptz,
        data jsonb
      );
      insert into sync_state (id, revision, version, data)
        values (1, 0, '0:', null)
        on conflict (id) do nothing;

      create table if not exists sync_mutations (
        mutation_id text primary key,
        created_at timestamptz not null default now(),
        client_id text,
        actor_id text,
        actor_name text,
        actor_username text,
        view text,
        scopes jsonb,
        operation_count integer
      );
      create index if not exists sync_mutations_created_at_idx on sync_mutations (created_at);

      create table if not exists sync_state_backups (
        id bigserial primary key,
        created_at timestamptz not null default now(),
        revision bigint,
        version text,
        updated_at timestamptz,
        data jsonb
      );
    `).catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }
  return schemaReadyPromise;
}

async function withTransaction(fn) {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch (rollbackError) {
      console.error("Falha ao reverter transacao: " + rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function query(text, params) {
  await ensureSchema();
  return getPool().query(text, params);
}

module.exports = { getPool, ensureSchema, withTransaction, query };
