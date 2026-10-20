"use strict";
// Isolated current-schema SQL fixture. Never reads the caller's DATABASE_URL.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { PrismaClient } = require("@prisma/client");
async function createAdminSqlRuntime({ runtimePath, maxConnections = 1, beforeMigration = null } = {}) {
  if (!runtimePath) throw Error("An explicit local proof runtime is required");
  const root = path.resolve(__dirname, "../..");
  const load = createRequire(path.resolve(runtimePath, "package.json"));
  const { PGlite } = load("@electric-sql/pglite");
  const { createPgliteSocketServer } = require("./pglite-socket-runtime.cjs");
  const migrations = require("./proof-migration-chain.cjs").selectProofMigrations(beforeMigration);
  const sources = migrations.map(item => {
    const sql = fs.readFileSync(path.join(root, "prisma/migrations", item.migration, "migration.sql"));
    if (crypto.createHash("sha256").update(sql).digest("hex") !== item.checksum) throw Error("BASELINE_SOURCE_CHECKSUM_MISMATCH");
    return { ...item, sql };
  });
  const engine = await PGlite.create();
  let server, db;
  try {
    for (const source of sources) await engine.exec(source.sql.toString("utf8"));
    await engine.exec(`CREATE TABLE "_prisma_migrations" (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL,
      finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
      started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)`);
    for (const source of sources) await engine.query('INSERT INTO "_prisma_migrations"(id,checksum,migration_name,finished_at,applied_steps_count) VALUES($1,$2,$3,now(),1)', [crypto.randomUUID(),source.checksum,source.migration]);
    server = await createPgliteSocketServer({ engine, load, maxConnections, debug: process.env.ONLINOD_SQL_DEBUG === "1" });
    const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
    const queries = [];
    db = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: "event", level: "query" }] });
    db.$on("query", event => queries.push({ query: event.query, duration: event.duration }));
    return { root, engine, server, db, url, queries, migrations: migrations.map(item => item.migration),
      async waitForIdle() { await server.waitForIdle(); },
      async close() { await db.$disconnect(); await server.stop(); await engine.close(); },
    };
  } catch (error) {
    if (db) await db.$disconnect(); if (server) await server.stop(); await engine.close(); throw error;
  }
}
module.exports = { createAdminSqlRuntime };
