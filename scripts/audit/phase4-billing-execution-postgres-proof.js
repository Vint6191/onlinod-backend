"use strict";
// Disposable PGlite + actual Prisma. Never connects to an environment DATABASE_URL.
// This verifies SQL/lease contracts, not native concurrency or production load.
const assert = require("node:assert/strict"), path = require("node:path"), crypto = require("node:crypto");
const { createRequire } = require("node:module"), { spawn } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const root = path.resolve(__dirname, "../..");
async function main() {
  if (!process.env.PHASE4_PROOF_RUNTIME) throw new Error("PHASE4_PROOF_RUNTIME required");
  const load = createRequire(path.resolve(process.env.PHASE4_PROOF_RUNTIME, "package.json"));
  const { PGlite } = load("@electric-sql/pglite"), { PGLiteSocketServer } = load("@electric-sql/pglite-socket");
  const engine = await PGlite.create(), server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0, maxConnections: 4 });
  await server.start();
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const cases = [], check = async (name, work) => { await work(); cases.push(name); console.log(JSON.stringify({ ok: true, case: name })); };
  let gate;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy"], { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b);
      child.once("error", reject); child.once("close", code => code ? reject(new Error(output)) : resolve());
    });
    await engine.exec("DISCARD ALL");
    await engine.exec("SET TIME ZONE 'UTC'");
    await engine.exec(`BEGIN;
      UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE';
      SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true);
      INSERT INTO "User" ("id","email","passwordHash","updatedAt") VALUES ('owner','owner@example.test','proof',now());
      INSERT INTO "Agency" ("id","name","updatedAt") VALUES ('a','A',now()),('b','B',now());
      INSERT INTO "AgencyMember" ("id","agencyId","userId","role","roleKey","updatedAt") VALUES
        ('owner-a','a','owner','OWNER','owner',now()),('owner-b','b','owner','OWNER','owner',now());
      UPDATE "Agency" SET "trialEndsAt"=now()-interval '1 day';
      INSERT INTO "CreatorAccount" ("id","agencyId","displayName","status","updatedAt") VALUES
        ('paid','a','Paid','READY',now()),('unpaid','a','Unpaid','READY',now()),('future','a','Future','READY',now()),
        ('foreign','b','Foreign','READY',now()),('deleted','a','Deleted','READY',now());
      UPDATE "CreatorAccount" SET "deletedAt"=now() WHERE "id"='deleted';
      INSERT INTO "CreatorBillingEntitlement" ("id","creatorId","agencyId","coreValidFrom","coreValidUntil","updatedAt") VALUES
        ('paid','paid','a',now()-interval '1 day',now()+interval '10 days',now()),
        ('future','future','a',now()+interval '1 day',now()+interval '10 days',now()),
        ('foreign','foreign','a',now()-interval '1 day',now()+interval '10 days',now());
      INSERT INTO "WorkerDevice" ("id","agencyId","userId","lastSeenAt","updatedAt") VALUES ('device','a','owner',clock_timestamp(),now());
      INSERT INTO "DeviceCreatorBinding" ("id","agencyId","deviceId","creatorId","sessionReadReady","sessionWriteReady","lastSeenAt","updatedAt")
        SELECT "id",'a','device',"id",true,true,clock_timestamp(),now() FROM "CreatorAccount" WHERE "agencyId"='a' AND "deletedAt" IS NULL;
      COMMIT;`);
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const access = require("../../src/services/billing-execution-access-service");
    const { requestBillingEarningsRefresh } = require("../../src/services/billing-recovery-service");
    const lease = require("../../src/services/job-lease-service");
    gate = require("../../src/services/of-request-gate-service");
    const state = (creatorId, agencyId = "a") => access.creatorBillingAccess({ db, agencyId, creatorId });
    const member = await db.agencyMember.findUnique({ where: { id: "owner-a" } });
    const actor = { agencyId: "a", userId: "owner", deviceId: "device", creatorId: "unpaid", member, capability: "read", operation: "earnings.chart" };
    const paidToken = "paid-test-lease";
    await db.jobInstance.create({ data: { id: "paid-job", agencyId: "a", creatorId: "paid", scope: "creator", jobKey: "traffic_sources_scan", status: "CLAIMED",
      claimedByDeviceId: "device", leaseTokenHash: crypto.createHash("sha256").update(paidToken).digest("hex"), leaseRevision: 1,
      leaseMemberId: member.id, leaseAccessEpoch: member.accessEpoch, leaseUntil: new Date(Date.now() + 600000) } });
    const paidActor = { ...actor, creatorId: "paid", operation: "chats.list", priority: "normal", timeoutMs: 5000,
      jobLease: { jobId: "paid-job", leaseToken: paidToken, leaseRevision: 1 } };
    const now = (await state("unpaid")).now, day = Math.floor(now.getTime() / 86400000) * 86400000;
    const params = { analyticsContractVersion: 1, sourceTimezone: "UTC", scanFrom: new Date(day - 30 * 86400000).toISOString().slice(0, 10), scanTo: new Date(day - 86400000).toISOString().slice(0, 10) };
    let recovery;
    await check("one paid creator cannot unlock another; future/foreign/retired grants do not admit execution", async () => {
      assert.equal((await state("paid")).allowed, true); assert.equal((await state("unpaid")).allowed, false);
      assert.equal((await state("future")).allowed, false); assert.equal((await state("foreign", "b")).allowed, false);
      await assert.rejects(state("foreign"), { code: "BILLING_CREATOR_NOT_FOUND" });
      await assert.rejects(state("deleted"), { code: "BILLING_CREATOR_NOT_FOUND" });
    });
    await check("stale Agency ACTIVE and cancelled subscription projection cannot grant or erase paid access", async () => {
      await db.agency.update({ where: { id: "a" }, data: { status: "ACTIVE" } });
      await db.agencySubscription.create({ data: { id: "sub", agencyId: "a", status: "CANCELLED", billingMode: "MANUAL" } });
      assert.equal((await state("unpaid")).allowed, false); assert.equal((await state("paid")).allowed, true);
    });
    await check("trial admits unpaid creators and expiry applies without reconciliation", async () => {
      await db.agency.update({ where: { id: "a" }, data: { trialEndsAt: new Date(Date.now() + 60000) } });
      assert.equal((await state("unpaid")).reason, "TRIAL");
      await db.agency.update({ where: { id: "a" }, data: { trialEndsAt: new Date(Date.now() - 1) } });
      assert.equal((await state("unpaid")).allowed, false);
    });
    await check("FREE_INTERNAL admits execution but support hold dominates it and paid grants", async () => {
      await db.agencySubscription.update({ where: { id: "sub" }, data: { billingMode: "FREE_INTERNAL" } });
      assert.equal((await state("unpaid")).reason, "FREE_INTERNAL");
      await db.agency.update({ where: { id: "a" }, data: { billingSupportHold: true } });
      assert.equal((await state("paid")).recoverable, false);
      await assert.rejects(access.assertProviderBillingAccess({ db, ...actor, capability: "security_probe", operation: "identity.bootstrap.me" }), { code: "BILLING_ACCESS_HELD" });
      await db.agency.update({ where: { id: "a" }, data: { billingSupportHold: false } });
      await db.agencySubscription.update({ where: { id: "sub" }, data: { billingMode: "MANUAL" } });
    });
    await check("ordinary provider reads/writes and a forged security label cannot bypass expiry", async () => {
      await assert.rejects(access.assertProviderBillingAccess({ db, ...actor }), { code: "CREATOR_SUBSCRIPTION_REQUIRED" });
      await assert.rejects(access.assertProviderBillingAccess({ db, ...actor, capability: "write" }), { code: "CREATOR_SUBSCRIPTION_REQUIRED" });
      await assert.rejects(access.assertProviderBillingAccess({ db, ...actor, capability: "security_probe", operation: "messages.send" }), { code: "BILLING_SECURITY_PROBE_INVALID" });
      await access.assertProviderBillingAccess({ db, ...actor, capability: "security_probe", operation: "identity.bootstrap.me" });
    });
    await check("Owner recovery plans only previous 30 closed days and repeated clicks reuse durable jobs", async () => {
      const first = await requestBillingEarningsRefresh({ db, agencyId: "a", userId: "owner", memberId: member.id, creatorId: "unpaid" });
      assert.equal(first.state, "QUEUED"); assert.ok(first.created > 0);
      assert.equal(first.startDay, params.scanFrom); assert.equal(first.endDay, params.scanTo);
      const second = await requestBillingEarningsRefresh({ db, agencyId: "a", userId: "owner", memberId: member.id, creatorId: "unpaid" });
      assert.equal(second.created, 0); assert.ok(second.reused > 0);
      const jobs = await db.jobInstance.findMany({ where: { creatorId: "unpaid" } });
      assert.ok(jobs.every(j => j.jobKey === "fetch_earnings" && access.recoveryWindow(j.params, now)));
    });
    await check("recovery rejects another agency member identity and a support hold without planning work", async () => {
      const count = await db.jobInstance.count();
      await assert.rejects(requestBillingEarningsRefresh({ db, agencyId: "a", userId: "owner", memberId: "owner-b", creatorId: "unpaid" }), { code: "DESKTOP_MEMBER_AUTHORITY_REVOKED" });
      await db.agency.update({ where: { id: "a" }, data: { billingSupportHold: true } });
      await assert.rejects(requestBillingEarningsRefresh({ db, agencyId: "a", userId: "owner", memberId: "owner-a", creatorId: "unpaid" }), { code: "BILLING_ACCESS_HELD" });
      await db.agency.update({ where: { id: "a" }, data: { billingSupportHold: false } });
      assert.equal(await db.jobInstance.count(), count);
    });
    await check("legacy Desktop cannot claim unpaid work; typed Desktop can claim recovery despite higher-priority unpaid jobs", async () => {
      await db.jobInstance.create({ data: { id: "unpaid-product", creatorId: "unpaid", agencyId: "a", jobKey: "traffic_sources_scan", scope: "creator", priority: 1000 } });
      await db.jobInstance.create({ data: { id: "old-earnings", creatorId: "unpaid", agencyId: "a", jobKey: "fetch_earnings", scope: "creator", params: { ...params, scanFrom: "2020-01-01" }, priority: 1001 } });
      const old = await lease.claimJob({ userId: "owner", deviceId: "device", jobKeys: ["traffic_sources_scan", "fetch_earnings"], capabilities: {} });
      assert.equal(old.job, null);
      const modern = await lease.claimJob({ userId: "owner", deviceId: "device", jobKeys: ["traffic_sources_scan", "fetch_earnings"], capabilities: { billingRecoveryLeaseV1: true } });
      assert.ok(modern.job, JSON.stringify({ reason: modern.reason, jobs: await db.jobInstance.findMany({ where: { creatorId: "unpaid" }, select: { id: true, status: true, jobKey: true, params: true, nextRunAt: true } }) }));
      assert.equal(modern.job.jobKey, "fetch_earnings"); assert.notEqual(modern.job.id, "old-earnings");
      recovery = { jobId: modern.job.id, leaseToken: modern.job.leaseToken, leaseRevision: modern.job.leaseRevision, scanFrom: modern.job.params.scanFrom, scanTo: modern.job.params.scanTo };
    });
    await check("live exact job/device/member/date recovery succeeds without enabling normal product traffic", async () => {
      const r = await access.assertProviderBillingAccess({ db, ...actor, billingRecovery: recovery }); assert.equal(r.recovery, true);
      const permit = await gate.acquireOfRequestSlot({ ...actor, billingRecovery: recovery, priority: "background", timeoutMs: 5000 });
      await gate.cancelOfRequestPermit({ ...actor, permitId: permit.permitId });
      await assert.rejects(access.assertProviderBillingAccess({ db, ...actor, operation: "chats.list", billingRecovery: recovery }), { code: "CREATOR_SUBSCRIPTION_REQUIRED" });
    });
    await check("wrong token, lease revision, device, agency, creator, member or dates fail recovery", async () => {
      for (const change of [{ leaseToken: "wrong" }, { leaseRevision: recovery.leaseRevision + 1 }, { scanFrom: "2020-01-01" }, { scanTo: "2099-01-01" }]) {
        await assert.rejects(access.assertProviderBillingAccess({ db, ...actor, billingRecovery: { ...recovery, ...change } }), { code: "BILLING_RECOVERY_LEASE_INVALID" });
      }
      for (const change of [{ deviceId: "other" }, { member: { ...member, accessEpoch: member.accessEpoch + 1 } }, { member: { ...member, id: "owner-b" } }]) {
        await assert.rejects(access.assertProviderBillingAccess({ db, ...actor, ...change, billingRecovery: recovery }), { code: "BILLING_RECOVERY_LEASE_INVALID" });
      }
      await assert.rejects(access.assertProviderBillingAccess({ db, ...actor, agencyId: "b", billingRecovery: recovery }), { code: "BILLING_CREATOR_NOT_FOUND" });
      await assert.rejects(access.assertProviderBillingAccess({ db, ...actor, creatorId: "future", billingRecovery: recovery }), { code: "BILLING_RECOVERY_LEASE_INVALID" });
    });
    await check("reclaimed or expired job cannot use old recovery proof; restart reads DB authority", async () => {
      await db.jobInstance.update({ where: { id: recovery.jobId }, data: { leaseRevision: { increment: 1 } } });
      delete require.cache[require.resolve("../../src/services/billing-execution-access-service")];
      await assert.rejects(require("../../src/services/billing-execution-access-service").assertProviderBillingAccess({ db, ...actor, billingRecovery: recovery }), { code: "BILLING_RECOVERY_LEASE_INVALID" });
      await db.jobInstance.update({ where: { id: recovery.jobId }, data: { leaseRevision: recovery.leaseRevision, leaseUntil: new Date(Date.now() - 1000) } });
      await assert.rejects(access.assertProviderBillingAccess({ db, ...actor, billingRecovery: recovery }), { code: "BILLING_RECOVERY_LEASE_INVALID" });
    });
    await check("billing hold committed while a request waits is rechecked after grant and its durable permit is released", async () => {
      const blocker = await gate.acquireOfRequestSlot(paidActor);
      const pending = gate.acquireOfRequestSlot(paidActor);
      const rejection = assert.rejects(pending, { code: "BILLING_ACCESS_HELD" });
      for (let i = 0; i < 100 && gate.getOfRequestGateSnapshot().queued === 0; i++) await new Promise(r => setTimeout(r, 5));
      assert.ok(gate.getOfRequestGateSnapshot().queued > 0);
      await db.agency.update({ where: { id: "a" }, data: { billingSupportHold: true } });
      await gate.cancelOfRequestPermit({ ...actor, creatorId: "paid", permitId: blocker.permitId });
      await rejection;
      await db.agency.update({ where: { id: "a" }, data: { billingSupportHold: false } });
      const fresh = await gate.acquireOfRequestSlot(paidActor);
      await gate.acknowledgeOfRequestStarted({ ...actor, creatorId: "paid", permitId: fresh.permitId });
    });
    await check("provider permit expires at paid deadline; started acknowledgement remains usable after hold", async () => {
      const deadline = new Date(Date.now() + 4000);
      await db.creatorBillingEntitlement.update({ where: { creatorId: "paid" }, data: { coreValidUntil: deadline } });
      const permit = await gate.acquireOfRequestSlot(paidActor);
      assert.ok(Date.parse(permit.expiresAt) <= deadline.getTime());
      await db.agency.update({ where: { id: "a" }, data: { billingSupportHold: true } });
      await gate.acknowledgeOfRequestStarted({ ...actor, creatorId: "paid", permitId: permit.permitId });
      await db.agency.update({ where: { id: "a" }, data: { billingSupportHold: false } });
    });
    await check("successful payment facts restore only that creator immediately without projection repair", async () => {
      await db.creatorBillingEntitlement.create({ data: { creatorId: "unpaid", agencyId: "a", coreValidFrom: new Date(Date.now() - 1000), coreValidUntil: new Date(Date.now() + 86400000) } });
      assert.equal((await state("unpaid")).allowed, true); assert.equal((await state("future")).allowed, false);
      await access.assertProviderBillingAccess({ db, ...actor, operation: "chats.list" });
    });
    await check("one thousand and one creators are fully classified across query batches; foreign ids stay absent", async () => {
      await db.$executeRawUnsafe(`INSERT INTO "CreatorAccount" ("id","agencyId","displayName","updatedAt") SELECT 'scale-'||n,'a','Scale',now() FROM generate_series(1,1001) n`);
      const ids = Array.from({ length: 1001 }, (_, i) => `scale-${i + 1}`);
      const rows = await access.readBillingExecutionAccess({ db, agencyId: "a", creatorIds: [...ids, "foreign"] });
      assert.equal(rows.size, 1001); assert.equal(rows.has("scale-1001"), true); assert.equal(rows.has("foreign"), false);
    });
    await check("singleton access query uses existing creator, agency, entitlement and latest-subscription index paths", async () => {
      await db.$executeRawUnsafe(`INSERT INTO "CreatorBillingEntitlement" ("id","creatorId","agencyId","updatedAt") SELECT 'scale-'||n,'scale-'||n,'a',now() FROM generate_series(1,1001) n`);
      for (const table of ["CreatorAccount", "CreatorBillingEntitlement", "AgencySubscription"]) await db.$executeRawUnsafe(`ANALYZE "${table}"`);
      await db.$executeRawUnsafe("SET enable_seqscan=off");
      const plan = await db.$queryRawUnsafe(`EXPLAIN (FORMAT JSON) ${access.ACCESS_SQL}`, "a", ["paid"]);
      const text = JSON.stringify(plan); assert.match(text, /CreatorAccount_(pkey|agencyId_id_key)/); assert.match(text, /CreatorBillingEntitlement_creatorId_key/); assert.match(text, /AgencySubscription_agency_created_id_idx/);
      await db.$executeRawUnsafe("RESET enable_seqscan");
    });
    await check("billing validity uses UTC even when the database session uses another time zone", async () => {
      await db.$executeRawUnsafe("SET TIME ZONE 'Etc/GMT+5'");
      assert.equal((await state("unpaid")).allowed, true); assert.equal((await state("future")).allowed, false);
      await db.$executeRawUnsafe("SET TIME ZONE 'UTC'");
    });
    await require("../test-support/billing-write-postgres-cases")({ db, check, member });
    console.log(JSON.stringify({ ok: true, passed: cases.length, cases, engine: "PGlite with Prisma 5.22", nativeConcurrency: false, productionScale: false }));
  } finally { gate?._test.reset(); await db.$disconnect(); await server.stop(); await engine.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
