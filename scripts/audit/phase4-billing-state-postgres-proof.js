"use strict";
// Disposable PostgreSQL WASM + real Prisma. Deliberately never reads the
// application's DATABASE_URL. Lease interleavings below are fault injection,
// not evidence of native simultaneous PostgreSQL sessions or production load.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawn } = require("node:child_process"), { createRequire } = require("node:module");
const { PrismaClient } = require("@prisma/client");
const root = path.resolve(__dirname, "../..");
const migrationName = "20260924050000_phase4_billing_reconciliation_cursor";

async function main() {
  if (!process.env.PHASE4_PROOF_RUNTIME) throw new Error("PHASE4_PROOF_RUNTIME required");
  const load = createRequire(path.resolve(process.env.PHASE4_PROOF_RUNTIME, "package.json"));
  const { PGlite } = load("@electric-sql/pglite"), { PGLiteSocketServer } = load("@electric-sql/pglite-socket");
  const engine = await PGlite.create(), server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0, maxConnections: 4 });
  await server.start();
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const baseline = fs.mkdtempSync(path.join(os.tmpdir(), "onlinod-billing-state-proof-"));
  fs.mkdirSync(path.join(baseline, "prisma"));
  fs.copyFileSync(path.join(root, "prisma/schema.prisma"), path.join(baseline, "prisma/schema.prisma"));
  fs.cpSync(path.join(root, "prisma/migrations"), path.join(baseline, "prisma/migrations"), { recursive: true, filter: p => path.basename(p) !== migrationName });
  const migrate = schema => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", schema], { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b);
    child.once("error", reject); child.once("close", code => code ? reject(new Error(output)) : resolve());
  });
  let db;
  const cases = [], check = async (name, work) => { await work(); cases.push(name); console.log(JSON.stringify({ ok: true, case: name })); };
  try {
    await migrate(path.join(baseline, "prisma/schema.prisma")); await engine.exec("DISCARD ALL");
    db = new PrismaClient({ datasources: { db: { url } } });
    await engine.exec(`BEGIN;
      UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE';
      SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true);
      INSERT INTO "User" ("id","email","passwordHash","updatedAt") VALUES ('owner','owner@example.test','proof',now());
      INSERT INTO "Agency" ("id","name","updatedAt")
        SELECT 'agency-'||lpad(n::text,3,'0'),'Agency '||n,now() FROM generate_series(1,140) n;
      INSERT INTO "AgencyMember" ("id","agencyId","userId","role","roleKey","updatedAt")
        SELECT 'owner-'||"id","id",'owner','OWNER','owner',now() FROM "Agency";
      UPDATE "Agency" SET "trialEndsAt"=clock_timestamp() AT TIME ZONE 'UTC' - interval '1 day';
      INSERT INTO "CreatorAccount" ("id","agencyId","displayName","updatedAt") VALUES
        ('paid','agency-002','Paid',now()),('future','agency-002','Future',now()),('deleted','agency-003','Deleted',now()),
        ('foreign','agency-004','Foreign',now());
      INSERT INTO "CreatorBillingEntitlement" ("id","creatorId","agencyId","coreValidFrom","coreValidUntil","corePriceCents","updatedAt") VALUES
        ('paid','paid','agency-002',now()-interval '1 day',now()+interval '20 days',2300,now()),
        ('future','future','agency-002',now()+interval '30 days',now()+interval '60 days',9000,now()),
        ('deleted','deleted','agency-003',now()-interval '1 day',now()+interval '40 days',3000,now()),
        ('foreign','foreign','agency-003',now()-interval '1 day',now()+interval '50 days',4000,now());
      UPDATE "CreatorAccount" SET "deletedAt"=now() WHERE "id"='deleted';
      INSERT INTO "AgencySubscription" ("id","agencyId","billingMode","status","updatedAt") VALUES
        ('sub-free','agency-005','FREE_INTERNAL','PAST_DUE',now()),
        ('sub-cancelled','agency-006','MANUAL','CANCELLED',now()),
        ('sub-held','agency-007','FREE_INTERNAL','ACTIVE',now());
      UPDATE "Agency" SET "billingSupportHold"=true WHERE "id"='agency-007';
      UPDATE "Agency" SET "trialEndsAt"=now()+interval '2 days' WHERE "id"='agency-008';
      COMMIT;`);
    const original = await db.agency.findUnique({ where: { id: "agency-001" } });
    await db.$disconnect(); await engine.exec("DISCARD ALL");
    await migrate(path.join(root, "prisma/schema.prisma")); await engine.exec("DISCARD ALL");
    console.log(JSON.stringify({ ok: true, baselineMigrations: 257, currentMigrations: 258 }));
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const { syncAgencyBillingAggregate } = require("../../src/services/billing-entitlement-service");
    const { reconcileBillingStates, CURSOR_ID } = require("../../src/services/billing-reconciliation-service");
    const { effectiveBillingState, liveEntitlementEnd, readBillingDashboard } = require("../../src/services/billing-state-service");
    const cursor = () => db.billingReconciliationCursor.findUnique({ where: { id: CURSOR_ID } });
    const setCursor = data => db.billingReconciliationCursor.update({ where: { id: CURSOR_ID }, data });
    const reset = () => setCursor({ lastAgencyId: null, ownerToken: null, leaseUntil: null });
    const repair = id => db.$transaction(tx => syncAgencyBillingAggregate(tx, id, new Date("2000-01-01")));

    await check("forward migration preserves historical agencies and initializes one idle cursor", async () => {
      assert.deepEqual(await db.agency.findUnique({ where: { id: original.id } }), original);
      assert.equal((await cursor()).ownerToken, null); assert.equal(await db.billingReconciliationCursor.count(), 1);
    });
    await check("aggregate ignores stale caller clock and expires trial without a subscription", async () => {
      const r = await repair("agency-001"); assert.equal(r.status, "PAST_DUE");
      assert.equal(await db.agencySubscription.count({ where: { agencyId: "agency-001" } }), 0);
    });
    await check("future-start grant cannot lengthen current paid validity", async () => {
      const r = await repair("agency-002"), e = await db.creatorBillingEntitlement.findUnique({ where: { creatorId: "paid" } });
      assert.equal(r.status, "ACTIVE"); assert.deepEqual(r.currentPeriodEnd, e.coreValidUntil);
    });
    await check("deleted creator and mismatched historical agency facts do not grant access", async () => {
      assert.equal((await repair("agency-003")).status, "PAST_DUE"); assert.equal((await repair("agency-004")).status, "PAST_DUE");
      assert.equal(await db.creatorBillingEntitlement.count(), 4);
    });
    await check("FREE_INTERNAL, CANCELLED, support hold and future trial retain their meanings", async () => {
      for (const [id, status] of [["005", "ACTIVE"], ["006", "CANCELLED"], ["007", "LOCKED"], ["008", "TRIAL"]]) assert.equal((await repair(`agency-${id}`)).status, status);
    });
    await check("healthy reconciliation performs no Agency or Subscription update", async () => {
      const a = await db.agency.findUnique({ where: { id: "agency-002" } }), s = await db.agencySubscription.findFirst({ where: { agencyId: a.id } });
      await repair(a.id);
      assert.deepEqual(await db.agency.findUnique({ where: { id: a.id } }), a);
      assert.deepEqual(await db.agencySubscription.findUnique({ where: { id: s.id } }), s);
    });
    await check("SQL dashboard and per-agency state agree without trusting stored status", async () => {
      const rows = await db.agency.findMany({ include: { creators: { include: { billingEntitlement: true } }, subscriptions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } });
      const now = (await db.$queryRawUnsafe('SELECT clock_timestamp() AS "at"'))[0].at;
      const statuses = rows.map(a => effectiveBillingState({ agency: a, subscription: a.subscriptions[0], activeUntil: liveEntitlementEnd(a.creators, a.id, now), now }).status);
      const r = await readBillingDashboard({ db });
      assert.deepEqual(r.counts, { total: 140, active: statuses.filter(s => s === "ACTIVE").length, trial: statuses.filter(s => s === "TRIAL").length, locked: statuses.filter(s => ["LOCKED", "PAST_DUE"].includes(s)).length });
      assert.deepEqual(r.mrr, { coreCents: 2300, aiChatterCents: 0, outreachCents: 0 });
    });
    await check("persistent keyset progress resumes after a process/module restart", async () => {
      await reset(); const first = await reconcileBillingStates({ db, limit: 2 }); assert.equal(first.scanned, 2); assert.equal((await cursor()).lastAgencyId, "agency-002");
      delete require.cache[require.resolve("../../src/services/billing-reconciliation-service")];
      const next = await require("../../src/services/billing-reconciliation-service").reconcileBillingStates({ db, limit: 2 });
      assert.equal(next.scanned, 2); assert.equal((await cursor()).lastAgencyId, "agency-004");
    });
    await check("live lease rejects another claimant without moving its cursor", async () => {
      await setCursor({ ownerToken: "other", leaseUntil: new Date(Date.now() + 120000) }); const before = await cursor();
      const r = await reconcileBillingStates({ db }); assert.equal(r.busy, true); assert.equal(r.scanned, 0); assert.deepEqual(await cursor(), before);
    });
    await check("expired process lease is reclaimed from the last committed agency", async () => {
      await setCursor({ ownerToken: "crashed", leaseUntil: new Date(Date.now() - 1000) });
      const r = await reconcileBillingStates({ db, limit: 1 }); assert.equal(r.scanned, 1); assert.equal((await cursor()).lastAgencyId, "agency-005");
    });
    await check("oversized requested page is capped and subsequent pages reach agencies beyond it", async () => {
      await reset(); const r = await reconcileBillingStates({ db, limit: 100000 }); assert.ok(r.scanned > 0 && r.scanned <= 100);
      let completed = false; for (let i = 0; i < 145 && !completed; i++) completed = (await reconcileBillingStates({ db, limit: 20 })).cycleCompleted;
      assert.equal(completed, true); assert.equal((await cursor()).lastAgencyId, null);
      assert.equal((await db.agency.findUnique({ where: { id: "agency-140" } })).status, "PAST_DUE");
    });
    await check("one failed tenant rolls back its projection, records debt and cannot starve the next tenant", async () => {
      await reset(); await db.agency.update({ where: { id: "agency-001" }, data: { status: "TRIAL" } });
      const failing = new Proxy(db, { get(target, key) { if (key === "$transaction") return (fn, options) => db.$transaction(tx => fn(new Proxy(tx, { get(t, k) {
        if (k === "agency") return new Proxy(t.agency, { get(a, method) { if (method === "update") return async args => { if (args.where.id === "agency-001") throw Object.assign(new Error("injected storage rejection"), { code: "PROOF_TENANT_FAILURE" }); return a.update(args); }; return a[method]; } });
        return t[k];
      } })), options); return target[key]; } });
      const r = await reconcileBillingStates({ db: failing, limit: 2 }); assert.equal(r.failed, 1); assert.equal(r.scanned, 2);
      assert.equal((await db.agency.findUnique({ where: { id: "agency-001" } })).status, "TRIAL");
      assert.equal((await cursor()).lastAgencyId, "agency-002"); assert.equal((await cursor()).lastErrorCode, "PROOF_TENANT_FAILURE");
      await reset(); await reconcileBillingStates({ db, limit: 1 }); assert.equal((await db.agency.findUnique({ where: { id: "agency-001" } })).status, "PAST_DUE");
    });
    await check("projection and cursor advancement commit atomically on cursor storage failure", async () => {
      await reset(); await db.agency.update({ where: { id: "agency-001" }, data: { status: "TRIAL" } });
      const failing = new Proxy(db, { get(target, key) { if (key === "$transaction") return (fn, options) => db.$transaction(tx => fn(new Proxy(tx, { get(t, k) {
        if (k === "billingReconciliationCursor") return new Proxy(t[k], { get(model, method) { if (method === "update") return async args => { if (args.data.lastAgencyId) throw new Error("injected cursor outage"); return model.update(args); }; return model[method]; } }); return t[k];
      } })), options); return target[key]; } });
      await assert.rejects(reconcileBillingStates({ db: failing, limit: 1 }), /cursor outage/);
      assert.equal((await cursor()).lastAgencyId, null); assert.equal((await db.agency.findUnique({ where: { id: "agency-001" } })).status, "TRIAL");
    });
    await check("lease expiry during projection rolls back both the state repair and progress", async () => {
      await reset(); await db.agency.update({ where: { id: "agency-001" }, data: { status: "TRIAL" } });
      let clocks = 0;
      const delayed = new Proxy(db, { get(target, key) { if (key === "$transaction") return (fn, options) => db.$transaction(tx => fn(new Proxy(tx, { get(t, k) {
        if (k === "$queryRawUnsafe") return async (sql, ...args) => {
          const rows = await t.$queryRawUnsafe(sql, ...args);
          if (sql.includes("clock_timestamp") && ++clocks === 4) rows[0].authorityNow = new Date(rows[0].authorityNow.getTime() + 31000);
          return rows;
        };
        return t[k];
      } })), options); return target[key]; } });
      const r = await reconcileBillingStates({ db: delayed, limit: 1 });
      assert.equal(r.leaseLost, true); assert.equal(r.scanned, 0); assert.equal((await cursor()).lastAgencyId, null);
      assert.equal((await db.agency.findUnique({ where: { id: "agency-001" } })).status, "TRIAL");
    });
    await check("stolen lease fences an old worker and its finalizer preserves the successor", async () => {
      await reset(); let commits = 0;
      const intercepted = new Proxy(db, { get(target, key) { if (key === "$transaction") return async (fn, options) => {
        const r = await db.$transaction(fn, options); commits++;
        if (commits === 1) await setCursor({ ownerToken: "successor", leaseUntil: new Date(Date.now() + 120000) });
        return r;
      }; return target[key]; } });
      const r = await reconcileBillingStates({ db: intercepted, limit: 1 }); assert.equal(r.leaseLost, true); assert.equal(r.scanned, 0);
      assert.equal((await cursor()).ownerToken, "successor"); assert.equal((await cursor()).lastAgencyId, null);
    });
    await check("next cycle includes agencies inserted before the prior cursor", async () => {
      await setCursor({ ownerToken: null, leaseUntil: null, lastAgencyId: "zzzz" });
      assert.equal((await reconcileBillingStates({ db, limit: 1 })).cycleCompleted, true);
      assert.equal((await reconcileBillingStates({ db, limit: 1 })).scanned, 1); assert.equal((await cursor()).lastAgencyId, "agency-001");
    });
    await check("keyset and active-grant reads have suitable existing indexes", async () => {
      await db.$executeRawUnsafe("SET enable_seqscan=off");
      const page = await db.$queryRawUnsafe('EXPLAIN SELECT "id" FROM "Agency" WHERE "id">$1 ORDER BY "id" LIMIT 100', "agency-020");
      const paid = await db.$queryRawUnsafe('EXPLAIN SELECT "coreValidUntil" FROM "CreatorBillingEntitlement" WHERE "agencyId"=$1 AND "coreValidUntil">now() ORDER BY "coreValidUntil" DESC LIMIT 1', "agency-002");
      assert.match(JSON.stringify(page), /Agency_pkey/); assert.match(JSON.stringify(paid), /agencyId_coreValidUntil/);
      await db.$executeRawUnsafe("RESET enable_seqscan");
    });
    console.log(JSON.stringify({ ok: true, passed: cases.length, cases, engine: "PGlite PostgreSQL WASM + Prisma 5.22", nativeConcurrencyProven: false, scaleProven: false, agencyFixtureCount: 140, faultInjection: true }));
  } finally {
    if (db) await db.$disconnect(); await server.stop(); await engine.close(); fs.rmSync(baseline, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
