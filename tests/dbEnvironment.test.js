"use strict";

const assert = require("node:assert/strict");
const { resolveConnectionString } = require("../api/_lib/db");

const productionUrl = "postgresql://production.example/database";
const homologationUrl = "postgresql://homologation.example/database";

assert.equal(resolveConnectionString({
  VERCEL_ENV: "preview",
  POSTGRES_URL: productionUrl,
  DATABASE_URL: productionUrl,
  HOMOLOGATION_DATABASE_URL: homologationUrl,
}), homologationUrl, "Preview deve usar exclusivamente o banco de homologacao");

assert.equal(resolveConnectionString({
  VERCEL_ENV: "preview",
  POSTGRES_URL: productionUrl,
  DATABASE_URL: productionUrl,
}), "", "Preview sem credencial isolada deve falhar fechado");

assert.equal(resolveConnectionString({
  APP_ENV: "homologacao",
  POSTGRES_URL: productionUrl,
  HOMOLOGATION_DATABASE_URL: homologationUrl,
}), homologationUrl, "APP_ENV de homologacao deve impedir fallback produtivo");

assert.equal(resolveConnectionString({
  VERCEL_ENV: "production",
  POSTGRES_URL: productionUrl,
  HOMOLOGATION_DATABASE_URL: homologationUrl,
}), productionUrl, "Producao deve preservar a conexao atual");

console.log("dbEnvironment: 4 cenarios de isolamento validados");
