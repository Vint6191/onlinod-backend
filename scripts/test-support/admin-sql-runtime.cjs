"use strict";
// Isolated current-schema SQL fixture. Never reads the caller's DATABASE_URL.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { PrismaClient } = require("@prisma/client");
async function createAdminSqlRuntime({ runtimePath, maxConnections = 1 } = {}) {
  if (!runtimePath) throw Error("An explicit local proof runtime is required");
  const root = path.resolve(__dirname, "../..");
  const load = createRequire(path.resolve(runtimePath, "package.json"));
  const { PGlite } = load("@electric-sql/pglite"), { PGLiteSocketServer } = load("@electric-sql/pglite-socket");
  const contract = require("../../src/services/database-contract.json");
  const sql = fs.readFileSync(path.join(root, "prisma/migrations", contract.migration, "migration.sql"));
  if (crypto.createHash("sha256").update(sql).digest("hex") !== contract.checksum) throw Error("BASELINE_SOURCE_CHECKSUM_MISMATCH");
  const engine = await PGlite.create();
  let server, db;
  try {
    await engine.exec(sql.toString("utf8"));
    await engine.exec(`CREATE TABLE "_prisma_migrations" (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL,
      finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
      started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)`);
    await engine.query('INSERT INTO "_prisma_migrations"(id,checksum,migration_name,finished_at,applied_steps_count) VALUES($1,$2,$3,now(),1)', [crypto.randomUUID(),contract.checksum,contract.migration]);
    server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0, maxConnections });
    server.addEventListener("connection", () => { engine.exec("DISCARD ALL").catch(() => {}); });
    await server.start();
    const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
    const queries = [];
    db = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: "event", level: "query" }] });
    db.$on("query", event => queries.push({ query: event.query, duration: event.duration }));
    return { root, engine, server, db, url, queries, migrations: [contract.migration],
      async close() { await db.$disconnect(); await server.stop(); await engine.close(); },
    };
  } catch (error) {
    if (db) await db.$disconnect(); if (server) await server.stop(); await engine.close(); throw error;
  }
}
module.exports = { createAdminSqlRuntime };
