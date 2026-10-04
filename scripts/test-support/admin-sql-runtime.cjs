"use strict";
// Disposable retained-schema SQL fixture. Uses the normal deployment plan;
// explicit Phase7 contract/destruction remains gated and is never requested.
const fs = require("node:fs"), path = require("node:path");
const { createRequire } = require("node:module");
const { PrismaClient } = require("@prisma/client");
async function createAdminSqlRuntime({ runtimePath } = {}) {
  if (!runtimePath) throw Error("An explicit local proof runtime is required");
  const root = path.resolve(__dirname, "../..");
  const load = createRequire(path.resolve(runtimePath, "package.json"));
  const { PGlite } = load("@electric-sql/pglite"), { PGLiteSocketServer } = load("@electric-sql/pglite-socket");
  const engine = await PGlite.create();
  let server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0 });
  await server.start();
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const queries = [];
  const db = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: "event", level: "query" }] });
  db.$on("query", event => queries.push({ query: event.query, duration: event.duration }));
  try {
    const { migrationPlan, CONTRACT } = require("../database/phase7-deploy");
    const plan = await migrationPlan(db, { contract: false, onCompatibility() {}, onHistorical() {} });
    if (!plan.fresh || plan.purged || plan.names.includes(CONTRACT)) throw Error("Expected a fresh retained-schema plan");
    const port = Number(new URL(url).port);
    await db.$disconnect(); await server.stop();
    await engine.exec("DISCARD ALL");
    for (const name of plan.names) {
      try { await engine.exec(fs.readFileSync(path.join(root, "prisma/migrations", name, "migration.sql"), "utf8")); }
      catch (error) { error.message = name + ": " + error.message; throw error; }
    }
    await engine.exec("DISCARD ALL"); await engine.exec("SET TIME ZONE 'UTC'");
    server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port }); await server.start();
    queries.length = 0;
    return { root, engine, server, db, url, queries, migrations: plan.names, excludedContract: CONTRACT,
      async close() { await db.$disconnect(); await server.stop(); await engine.close(); },
    };
  } catch (error) {
    await db.$disconnect(); await server.stop(); await engine.close(); throw error;
  }
}
module.exports = { createAdminSqlRuntime };
