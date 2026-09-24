"use strict";
// Disposable PostgreSQL WASM engine + the application's actual Prisma client.
// Never uses DATABASE_URL, never connects to an existing database.
// Install proof-only dependencies OUTSIDE this repo (no production dependency):
// npm install --prefix /tmp/onlinod-owner-proof --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.5.8 @electric-sql/pglite-socket@0.2.11
// PHASE4_PROOF_RUNTIME=/tmp/onlinod-owner-proof node scripts/audit/phase4-single-owner-postgres-proof.js
// This proves SQL/driver/commit behavior, NOT native multi-connection concurrency.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {createRequire} = require("node:module");
const {PrismaClient, Prisma} = require("@prisma/client");
const {preflight} = require("../database/phase4-single-owner-preflight");

async function main() {
  if (!process.env.PHASE4_PROOF_RUNTIME) throw new Error("PHASE4_PROOF_RUNTIME must point to the separate proof dependency directory");
  const proofRequire = createRequire(path.resolve(process.env.PHASE4_PROOF_RUNTIME, "package.json"));
  const {PGlite} = proofRequire("@electric-sql/pglite");
  const {PGLiteSocketServer} = proofRequire("@electric-sql/pglite-socket");
  const engine = await PGlite.create();
  const server = new PGLiteSocketServer({db:engine, host:"127.0.0.1", port:0});
  await server.start();
  const prisma = new PrismaClient({datasources:{db:{url:`postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`}}});
  const passed = [];
  const check = async (name, fn) => { await fn(); passed.push(name); console.log(JSON.stringify({ok:true,case:name})); };
  const ddl = `CREATE TABLE "Agency" ("id" TEXT PRIMARY KEY,"deletedAt" TIMESTAMP);
    CREATE TABLE "User" ("id" TEXT PRIMARY KEY,"disabledAt" TIMESTAMP);
    CREATE TABLE "AgencyMember" ("id" TEXT PRIMARY KEY,"agencyId" TEXT NOT NULL REFERENCES "Agency"("id") ON DELETE CASCADE,
      "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,"roleKey" TEXT,"role" TEXT,
      "deletedAt" TIMESTAMP,"deactivatedAt" TIMESTAMP);
    INSERT INTO "Agency"("id") VALUES ('a');
    INSERT INTO "User"("id") VALUES ('u1'),('u2');
    INSERT INTO "AgencyMember"("id","agencyId","userId","roleKey","role") VALUES
      ('m1','a','u1','owner','OWNER'),('m2','a','u2','chatter','CHATTER');`;
  const ownerRows = () => prisma.$queryRawUnsafe(`SELECT "id" FROM "AgencyMember" WHERE "agencyId"='a' AND "deletedAt" IS NULL AND ("roleKey"='owner' OR "role"='OWNER') ORDER BY "id"`);
  const rejectsTransaction = async (sql, message) => {
    await assert.rejects(() => engine.exec(`BEGIN; ${sql}; COMMIT;`), message);
    await engine.exec("ROLLBACK");
    assert.deepEqual(await ownerRows(), [{id:"m1"}]);
  };
  try {
    await check("empty schema bootstrap through real Prisma", async () => assert.equal((await preflight(prisma)).bootstrap,true));
    await check("partial schema fails closed through real Prisma", async () => {
      await engine.exec('CREATE TABLE "Agency" ("id" TEXT)');
      await assert.rejects(() => preflight(prisma), e=>e.code==="PHASE4_OWNER_SCHEMA_INCOMPLETE");
      await engine.exec('DROP TABLE "Agency"');
    });
    await engine.exec(ddl);
    await check("R7 SQL reproduces the exact P2010 regclass deserialization failure", async () => {
      await assert.rejects(() => prisma.$queryRawUnsafe(`SELECT to_regclass('"Agency"') AS agency,to_regclass('"AgencyMember"') AS member,to_regclass('"User"') AS account`), e=>e.code==="P2010" && /Failed to deserialize column of type 'regclass'/.test(e.message));
    });
    await check("R8 boolean probe validates one operational owner", async () => assert.equal((await preflight(prisma)).authority,"exactly-one-operational-owner"));
    await check("target schema cannot borrow public tables via search_path fallback", async () => {
      await engine.exec('CREATE SCHEMA proof_empty');
      await prisma.$executeRawUnsafe('SET search_path TO proof_empty, public');
      assert.equal((await preflight(prisma)).bootstrap,true);
      await prisma.$executeRawUnsafe('SET search_path TO public');
    });
    const blocked = [
      ["missing owner", `UPDATE "AgencyMember" SET "roleKey"='chatter',"role"='CHATTER' WHERE "id"='m1'`],
      ["second owner", `UPDATE "AgencyMember" SET "roleKey"='owner',"role"='OWNER' WHERE "id"='m2'`],
      ["deactivated owner", `UPDATE "AgencyMember" SET "deactivatedAt"=now() WHERE "id"='m1'`],
      ["disabled owner account", `UPDATE "User" SET "disabledAt"=now() WHERE "id"='u1'`],
    ];
    for (const [name,sql] of blocked) await check(`preflight rejects ${name}`, async () => {
      await engine.exec(`BEGIN; ${sql};`);
      await assert.rejects(() => preflight(prisma),e=>e.code==="PHASE4_SINGLE_OWNER_PREFLIGHT_FAILED" && e.blockers[0].agencyId==="a");
      await engine.exec("ROLLBACK");
    });
    await check("retired agency without owner remains eligible for cleanup", async () => {
      await engine.exec(`BEGIN; UPDATE "Agency" SET "deletedAt"=now(); DELETE FROM "AgencyMember";`);
      assert.equal((await preflight(prisma)).ok,true);
      await engine.exec("ROLLBACK");
    });
    const migration = fs.readFileSync(path.join(__dirname,"../../prisma/migrations/20260924010000_phase4_single_owner_authority/migration.sql"),"utf8");
    await check("unchanged R7 migration refuses bad legacy data and rolls back cleanly", async () => {
      await engine.exec(`UPDATE "AgencyMember" SET "roleKey"='owner',"role"='OWNER' WHERE "id"='m2'`);
      await assert.rejects(() => engine.exec(migration),/PHASE4_SINGLE_OWNER_PREFLIGHT_FAILED/);
      await engine.exec("ROLLBACK");
      assert.deepEqual(await prisma.$queryRawUnsafe(`SELECT to_regclass('"AgencyMember_single_owner_agency_idx"')::text AS name`),[{name:null}]);
      await engine.exec(`UPDATE "AgencyMember" SET "roleKey"='chatter',"role"='CHATTER' WHERE "id"='m2'`);
    });
    await check("unchanged R7 migration executes against valid ownership", async () => { await engine.exec(migration); });
    for (const [name,sql] of blocked) await check(`database rejects ${name} at commit`, () => rejectsTransaction(sql,/PHASE4_EXACTLY_ONE_OPERATIONAL_OWNER_REQUIRED|unique constraint/));
    await check("database rejects owner membership deletion", () => rejectsTransaction(`DELETE FROM "AgencyMember" WHERE "id"='m1'`,/PHASE4_EXACTLY_ONE_OPERATIONAL_OWNER_REQUIRED/));
    await check("database rejects owner user cascade deletion", () => rejectsTransaction(`DELETE FROM "User" WHERE "id"='u1'`,/PHASE4_EXACTLY_ONE_OPERATIONAL_OWNER_REQUIRED/));
    await check("failed promotion rolls back the former owner demotion", () => rejectsTransaction(`UPDATE "AgencyMember" SET "roleKey"='chatter',"role"='CHATTER' WHERE "id"='m1'; INSERT INTO "AgencyMember"("id","agencyId","userId","roleKey","role") VALUES ('m3','a','missing','owner','OWNER')`,/foreign key constraint/));
    await check("restore of agency without owner is rejected", async () => {
      await engine.exec(`INSERT INTO "Agency"("id","deletedAt") VALUES ('retired',now())`);
      await assert.rejects(() => engine.exec(`BEGIN; UPDATE "Agency" SET "deletedAt"=NULL WHERE "id"='retired'; COMMIT;`),/PHASE4_EXACTLY_ONE_OPERATIONAL_OWNER_REQUIRED/);
      await engine.exec("ROLLBACK");
    });
    await check("bootstrap agency and owner commit together", async () => {
      await engine.exec(`BEGIN; INSERT INTO "Agency"("id") VALUES ('new'); INSERT INTO "AgencyMember"("id","agencyId","userId","roleKey","role") VALUES ('new-owner','new','u2','owner','OWNER'); COMMIT;`);
    });
    await check("atomic handover commits exactly one new owner", async () => {
      await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(`UPDATE "AgencyMember" SET "roleKey"='chatter',"role"='CHATTER' WHERE "id"='m1'`);
        await tx.$executeRawUnsafe(`UPDATE "AgencyMember" SET "roleKey"='owner',"role"='OWNER' WHERE "id"='m2'`);
      });
      assert.deepEqual(await ownerRows(),[{id:"m2"}]);
      assert.equal((await preflight(prisma)).ok,true);
    });
    console.log(JSON.stringify({ok:true,prisma:Prisma.prismaVersion.client,engine:"PostgreSQL WASM/PGlite",passed:passed.length,nativeConcurrentPostgres:false,cases:passed}));
  } finally {
    await prisma.$disconnect();
    await server.stop();
    await engine.close();
  }
}
if (require.main === module) main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports = {main};
