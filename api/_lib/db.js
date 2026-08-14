"use strict";

const { Pool } = require("pg");

// A integracao Neon/Postgres da Vercel permite escolher um prefixo customizado
// para as env vars (ex.: "STORAGE_POSTGRES_URL" em vez de "POSTGRES_URL"), e
// isso muda dependendo do que foi digitado na tela "Connect a Project" - por
// isso nao fixamos um unico nome, e sim procuramos qualquer variavel que
// pareca uma connection string de Postgres, preferindo a variante pooled
// (evitando NON_POOLING/UNPOOLED/NO_SSL/PRISMA, usadas para outros fins).
function resolveConnectionString() {
  const explicit = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_PRISMA_URL;
  if (explicit) return explicit;

  const isPostgresUrl = (value) =>
    typeof value === "string" && (value.startsWith("postgres://") || value.startsWith("postgresql://"));

  const keys = Object.keys(process.env).filter(
    (key) => /(^|_)POSTGRES_URL$|(^|_)DATABASE_URL$/.test(key) && isPostgresUrl(process.env[key])
  );
  const pooled = keys.find((key) => !/NON_POOLING|UNPOOLED|NO_SSL|PRISMA/.test(key));
  if (pooled) return process.env[pooled];
  if (keys.length) return process.env[keys[0]];

  const anyPostgresVar = Object.keys(process.env).find((key) => isPostgresUrl(process.env[key]));
  return anyPostgresVar ? process.env[anyPostgresVar] : "";
}

const CONNECTION_STRING = resolveConnectionString();

let pool = null;
let schemaReadyPromise = null;

function getPool() {
  if (!CONNECTION_STRING) {
    throw new Error("Nenhuma connection string de Postgres encontrada nas env vars. Conecte um banco Postgres (Neon) ao projeto na Vercel.");
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
