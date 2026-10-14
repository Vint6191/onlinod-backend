"use strict";

// Actual installer against a populated, isolated baseline; no configured DB is read.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const {
    createRequire
  } = require("node:module"),
  {
    spawn
  } = require("node:child_process");
const root = path.resolve(__dirname, "../.."),
  runtime = process.env.ONLINOD_SQL_PROOF_RUNTIME;
if (!runtime) throw Error("Explicit isolated PGlite runtime required");
const load = createRequire(path.resolve(runtime, "package.json"));
const baseline = require("../../src/services/database-contract.json"),
  {
    migrations
  } = require("../../src/services/database-migration-chain");
const {
    PGlite
  } = load("@electric-sql/pglite"),
  {
    PGLiteSocketServer
  } = load("@electric-sql/pglite-socket");
function install(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/database/install-current.js"], {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: url
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", v => {
      output += v;
    });
    child.stderr.on("data", v => {
      output += v;
    });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(output) : reject(Error(output)));
  });
}
(async () => {
  const keep = setInterval(() => {}, 1000);
  let pg, server;
  try {
    pg = await PGlite.create();
    await pg.exec(fs.readFileSync(path.join(root, "prisma/migrations", baseline.migration, "migration.sql"), "utf8"));
    await pg.exec(`CREATE TABLE "_prisma_migrations"(id varchar(36) PRIMARY KEY,checksum varchar(64) NOT NULL,finished_at timestamptz,migration_name varchar(255) NOT NULL,logs text,rolled_back_at timestamptz,started_at timestamptz NOT NULL DEFAULT now(),applied_steps_count integer NOT NULL DEFAULT 0)`);
    await pg.query('INSERT INTO "_prisma_migrations"(id,checksum,migration_name,finished_at,applied_steps_count) VALUES($1,$2,$3,now(),1)', [crypto.randomUUID(), baseline.checksum, baseline.migration]);
    await pg.exec(`INSERT INTO "LoginAdmissionBucket"("id","windowStartedAt","expiresAt","attempts") VALUES('preserved-notification-upgrade',now(),now()+interval '1 hour',3)`);
    const original = (await pg.query('SELECT * FROM "LoginAdmissionBucket" WHERE id=$1', ["preserved-notification-upgrade"])).rows;
    server = new PGLiteSocketServer({
      db: pg,
      host: "127.0.0.1",
      port: 0
    });
    server.addEventListener("connection", () => {
      pg.exec("DISCARD ALL").catch(() => {});
    });
    await server.start();
    const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
    const first = await install(url);
    assert.match(first, /20261014000000_notification_source_ledger/);
    assert.deepEqual((await pg.query('SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name')).rows, migrations.map(m => ({
      migration_name: m.migration,
      checksum: m.checksum
    })));
    assert.deepEqual((await pg.query('SELECT * FROM "LoginAdmissionBucket" WHERE id=$1', ["preserved-notification-upgrade"])).rows, original);
    console.log("PASS real Prisma installer upgrades populated baseline without resetting existing rows");
    const before = (await pg.query('SELECT * FROM "_prisma_migrations" ORDER BY migration_name')).rows;
    await install(url);
    assert.deepEqual((await pg.query('SELECT * FROM "_prisma_migrations" ORDER BY migration_name')).rows, before);
    assert.deepEqual((await pg.query('SELECT * FROM "LoginAdmissionBucket" WHERE id=$1', ["preserved-notification-upgrade"])).rows, original);
    console.log("PASS repeat installation is unchanged and startup validates the approved two-migration chain");
    const baselineSql = fs.readFileSync(path.join(root, "prisma/migrations", baseline.migration, "migration.sql"));
    assert.equal(crypto.createHash("sha256").update(baselineSql).digest("hex"), baseline.checksum);
    console.log(JSON.stringify({
      ok: true,
      productionAccessed: false,
      nativePostgres: false,
      engine: "PGlite + actual Prisma CLI",
      baselineUnchanged: true,
      existingRowsPreserved: true
    }));
  } finally {
    if (server) await server.stop();
    if (pg) await pg.close();
    clearInterval(keep);
  }
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
