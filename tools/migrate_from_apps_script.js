"use strict";

// Migracao unica dos dados de producao: le o estado atual do backend antigo
// (Google Apps Script, AppsScript_Code.gs) e grava como o estado inicial do
// novo backend (Postgres/Neon na Vercel). Rodar UMA vez, com o app em modo de
// manutencao (para congelar novas escritas no Apps Script durante a migracao).
//
// Uso:
//   node tools/migrate_from_apps_script.js <URL_DO_APPS_SCRIPT> <POSTGRES_CONNECTION_STRING>
//
// A URL do Apps Script e a mesma que hoje esta em SHEETS_ENDPOINT (termina em
// /exec). A connection string do Postgres e a POSTGRES_URL (pooled) que a
// Vercel injetou ao conectar o banco Neon ao projeto (Storage > seu banco >
// .env.local / Quickstart).

const { Client } = require("pg");

async function main() {
  const [, , appsScriptUrl, connectionString] = process.argv;
  if (!appsScriptUrl || !connectionString) {
    console.error("Uso: node tools/migrate_from_apps_script.js <URL_DO_APPS_SCRIPT> <POSTGRES_CONNECTION_STRING>");
    process.exit(1);
  }

  console.log("Lendo estado atual do Apps Script...");
  const response = await fetch(appsScriptUrl, { cache: "no-store" });
  const result = await response.json();
  if (!result.ok) {
    throw new Error("Falha ao ler dados do Apps Script: " + (result.error || "resposta invalida"));
  }
  const data = result.data || {};
  const revision = Number(result.revision || 0);
  const updatedAt = result.updatedAt || new Date().toISOString();
  const version = result.version || `${revision}:${updatedAt}`;

  console.log(`Estado lido - revision ${revision}, updatedAt ${updatedAt}`);
  Object.keys(data).forEach((key) => {
    if (Array.isArray(data[key])) console.log(`  ${key}: ${data[key].length} registro(s)`);
  });

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(`
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
        client_id text, actor_id text, actor_name text, actor_username text,
        view text, scopes jsonb, operation_count integer
      );
      create table if not exists sync_state_backups (
        id bigserial primary key,
        created_at timestamptz not null default now(),
        revision bigint, version text, updated_at timestamptz, data jsonb
      );
    `);

    const existing = await client.query(`select revision from sync_state where id = 1`);
    if (Number(existing.rows[0]?.revision || 0) > 0) {
      console.error(
        "sync_state ja tem dados (revision > 0). Para evitar sobrescrever um estado ja em uso pelo novo " +
          "backend, a migracao foi interrompida. Se isso e intencional, apague a linha manualmente antes de rodar de novo."
      );
      process.exit(1);
    }

    await client.query(
      `update sync_state set revision = $1, version = $2, updated_at = $3, data = $4 where id = 1`,
      [revision, version, updatedAt, JSON.stringify(data)]
    );
    console.log("Migracao concluida. sync_state atualizado no Postgres.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
