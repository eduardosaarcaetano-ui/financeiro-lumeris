"use strict";

const { Pool } = require("pg");

// A integracao Neon/Postgres da Vercel permite escolher um prefixo customizado
// para as env vars (ex.: "STORAGE_POSTGRES_URL" em vez de "POSTGRES_URL"), e
// isso muda dependendo do que foi digitado na tela "Connect a Project" - por
// isso nao fixamos um unico nome, e sim procuramos qualquer variavel que
// pareca uma connection string de Postgres, preferindo a variante pooled
// (evitando NON_POOLING/UNPOOLED/NO_SSL/PRISMA, usadas para outros fins).
function resolveConnectionString(env = process.env) {
  const isPostgresUrl = (value) =>
    typeof value === "string" && (value.startsWith("postgres://") || value.startsWith("postgresql://"));

  // Preview e a homologacao devem falhar fechados: mesmo que a integracao
  // Vercel ainda exponha variaveis produtivas nesse escopo, elas nunca podem
  // ser escolhidas como fallback.
  const requiresHomologationDatabase = env.VERCEL_ENV === "preview" || env.APP_ENV === "homologacao";
  if (requiresHomologationDatabase) {
    return isPostgresUrl(env.HOMOLOGATION_DATABASE_URL) ? env.HOMOLOGATION_DATABASE_URL : "";
  }

  const explicit = env.POSTGRES_URL || env.DATABASE_URL || env.POSTGRES_PRISMA_URL;
  if (explicit) return explicit;

  const keys = Object.keys(env).filter(
    (key) => /(^|_)POSTGRES_URL$|(^|_)DATABASE_URL$/.test(key) && isPostgresUrl(env[key])
  );
  const pooled = keys.find((key) => !/NON_POOLING|UNPOOLED|NO_SSL|PRISMA/.test(key));
  if (pooled) return env[pooled];
  if (keys.length) return env[keys[0]];

  const anyPostgresVar = Object.keys(env).find((key) => isPostgresUrl(env[key]));
  return anyPostgresVar ? env[anyPostgresVar] : "";
}

const CONNECTION_STRING = resolveConnectionString();

let pool = null;
let schemaReadyPromise = null;

function getPool() {
  if (!CONNECTION_STRING) {
    const message = process.env.VERCEL_ENV === "preview" || process.env.APP_ENV === "homologacao"
      ? "HOMOLOGATION_DATABASE_URL ausente ou invalida. O Preview foi bloqueado para impedir acesso ao banco de producao."
      : "Nenhuma connection string de Postgres encontrada nas env vars. Conecte um banco Postgres (Neon) ao projeto na Vercel.";
    throw new Error(message);
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

module.exports = { resolveConnectionString, getPool, ensureSchema, withTransaction, query };
