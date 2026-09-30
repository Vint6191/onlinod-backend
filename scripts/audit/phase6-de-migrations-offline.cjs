"use strict";
// Only a newly created local ephemeral database is ever passed to migrate deploy.
const { createRequire } = require("node:module"),
  { spawn } = require("node:child_process"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const alive = setInterval(() => {}, 1000),
  deadline = setTimeout(() => {
    console.error("LOCAL_MIGRATION_DEADLINE");
    process.exit(2);
  }, 120000);
(async () => {
  if (!process.env.PHASE5_PROOF_RUNTIME || !process.env.DE_PRISMA_CLI)
    throw Error("Explicit offline runtime and Prisma CLI are required");
  const load = createRequire(path.resolve(process.env.PHASE5_PROOF_RUNTIME, "package.json"));
  const engine = await load("@electric-sql/pglite").PGlite.create(),
    server = new (load("@electric-sql/pglite-socket").PGLiteSocketServer)({ db: engine, host: "127.0.0.1", port: 0 });
  await server.start();
  try {
    const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          path.resolve(process.env.DE_PRISMA_CLI),
          "migrate",
          "deploy",
          "--schema",
          path.resolve(__dirname, "../../prisma/schema.prisma"),
        ],
        {
          env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "true" },
          stdio: "inherit",
        }
      );
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exit, 0);
    const rows = await engine.query(
      'SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'
    );
    assert.equal(rows.rows[0].count, 268);
    console.log(
      JSON.stringify({
        status: "PASS",
        migrationCount: 268,
        actualPrismaMigrateDeploy: true,
        physicalMultiSessionPostgres: false,
        externalDatabase: false,
      })
    );
  } finally {
    await server.stop();
    await engine.close();
  }
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    clearInterval(alive);
    clearTimeout(deadline);
  });
