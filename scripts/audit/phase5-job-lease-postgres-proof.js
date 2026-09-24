"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { spawn } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const root = path.resolve(__dirname, "../..");
async function main() {
  if (!process.env.PHASE5_PROOF_RUNTIME) throw new Error("PHASE5_PROOF_RUNTIME required");
  const load = createRequire(path.resolve(process.env.PHASE5_PROOF_RUNTIME, "package.json"));
  const { PGlite } = load("@electric-sql/pglite");
  const { PGLiteSocketServer } = load("@electric-sql/pglite-socket");
  const engine = await PGlite.create();
  const server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0 });
  await server.start();
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const cases = [];
  const check = async (name, fn) => { await fn(); cases.push({ name, status: "PASS" }); console.log(JSON.stringify(cases.at(-1))); };
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy"], {
        cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = ""; child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
      child.once("error", reject); child.once("close", code => code ? reject(new Error(output)) : resolve());
    });
    await engine.exec("DISCARD ALL");
    await engine.exec("SET TIME ZONE 'UTC'");
    await engine.exec(`UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE'`);
    await engine.exec(`UPDATE "Phase2ReleaseCompatibilityAuthority" SET "requiredGeneration"='phase3_domain_executor_v6_failure_policy',"activationState"='ACTIVE' WHERE "scope"='DOMAIN_WORK_EXECUTOR'`);
    // Controlled failures execute AFTER production effects and BEFORE the
    // durable intent/cursor commit. This database is entirely disposable.
    await engine.exec(`CREATE TABLE "I3ProofFault" (kind text PRIMARY KEY);
      CREATE FUNCTION i3_proof_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."workClass"='NOTIFICATION_CONSEQUENCES' THEN
          IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM "I3ProofFault" WHERE kind='publish') THEN
            RAISE EXCEPTION 'I3_PUBLISH_ROLLBACK';
          END IF;
          IF TG_OP='UPDATE' AND NEW."progressCursor" IS DISTINCT FROM OLD."progressCursor"
              AND EXISTS(SELECT 1 FROM "I3ProofFault" WHERE kind='cursor') THEN
            RAISE EXCEPTION 'I3_CURSOR_ROLLBACK';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER i3_proof_fault BEFORE INSERT OR UPDATE ON "DomainWorkItem"
        FOR EACH ROW EXECUTE FUNCTION i3_proof_fault()`);
    let expireAtLock = null, changeCandidateAtLock = null, failCommit = false, attempts = 0, injected = 0;
    const proxy = new Proxy({}, { get(_target, key) {
      const target = db;
      if (key === "$transaction") return (fn, options) => target.$transaction(async tx => {
        attempts++;
        const wrapped = new Proxy({}, { get(_t, k) {
          const t = tx;
          if (k === "$queryRawUnsafe") return async (sql, ...args) => {
            if (changeCandidateAtLock && sql.startsWith('SELECT * FROM "JobInstance"') && args[0] === changeCandidateAtLock) {
              await t.jobInstance.update({ where: { id: changeCandidateAtLock }, data: { params: { dialogId: "new-dialog", plannedAgain: true } } });
              changeCandidateAtLock = null;
            }
            if (expireAtLock && sql.startsWith('SELECT * FROM "JobInstance"') && args[0] === expireAtLock) {
              injected++;
              await t.$executeRawUnsafe(`UPDATE "JobInstance" SET "leaseUntil"=(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 second' WHERE "id"=$1`, expireAtLock);
            }
            return t.$queryRawUnsafe(sql, ...args);
          };
          const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
        } });
        const result = await fn(wrapped);
        if (failCommit) { failCommit = false; await tx.$executeRawUnsafe("DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='I3_CONTROLLED_CONFLICT'; END $$"); }
        return result;
      }, options);
      const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
    } });
    require.cache[require.resolve("../../src/prisma")] = { exports: proxy };
    const lease = require("../../src/services/job-lease-service");
    const effects = require("../../src/services/notification-consequence-service");
    const work = require("../../src/services/domain-work-authority-service");
    let seq = 0;
    async function seed(jobKey = "fan_data_point_refresh") {
      const label = `i3-${++seq}`;
      return db.$transaction(async tx => {
        await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)", "phase2_team_control_plane_v2_durable_access");
        const user = await tx.user.create({ data: { email: label + "@example.test", passwordHash: "proof" } });
        const agency = await tx.agency.create({ data: { name: label, trialEndsAt: new Date(Date.now() + 86400000) } });
        const member = await tx.agencyMember.create({ data: { agencyId: agency.id, userId: user.id, role: "OWNER", roleKey: "owner", assignedCreators: "all" } });
        const creator = await tx.creatorAccount.create({ data: { agencyId: agency.id, displayName: label, status: "READY" } });
        const device = await tx.workerDevice.create({ data: { agencyId: agency.id, userId: user.id, id: label, lastSeenAt: new Date() } });
        const token = crypto.randomBytes(32).toString("base64url");
        const job = await tx.jobInstance.create({ data: { agencyId: agency.id, creatorId: creator.id, jobKey, scope: "creator", status: "CLAIMED",
          claimedByDeviceId: device.id, leaseTokenHash: crypto.createHash("sha256").update(token).digest("hex"), leaseRevision: 1,
          leaseMemberId: member.id, leaseAccessEpoch: member.accessEpoch, leaseUntil: new Date(Date.now() + 60000),
          params: { observationReadLeaseVersion: 1, notificationMode: "catchup" } } });
        return { agency, user, member, creator, device, job, input: { jobId: job.id, userId: user.id, deviceId: device.id, leaseToken: token, leaseRevision: 1 } };
      });
    }
    for (const command of ["renewLease", "progressJob", "completeJob", "acquireJobFanObservationReadLease", "issueFanObservationToken"]) {
      await check(command + ": expiry during row-lock boundary rolls back and rejects", async () => {
        const s = await seed(); const before = await db.jobInstance.findUnique({ where: { id: s.job.id } });
        expireAtLock = s.job.id;
        try { await assert.rejects(() => lease[command]({ ...s.input, purpose: "fan_data_point_refresh", requestId: "proof", subjects: ["fan"] }), { code: "JOB_LEASE_EXPIRED" }); }
        finally { expireAtLock = null; }
        assert.ok(injected > 0);
        assert.deepEqual(await db.jobInstance.findUnique({ where: { id: s.job.id } }), before);
        assert.equal(await db.fanObservationReadLease.count({ where: { jobId: s.job.id } }), 0);
      });
    }
    await check("renewal raw SQLSTATE retries once; one committed progress and full fresh TTL", async () => {
      const s = await seed(); const n = attempts; failCommit = true;
      const result = await lease.renewLease({ ...s.input, leaseMs: 30000, progress: { current: 7 } });
      assert.equal(attempts - n, 2); assert.equal(result.progress.current, 7);
      assert.ok(new Date(result.leaseUntil).getTime() > Date.now() + 25000);
    });
    await check("claim re-discovers changed command after lock wait and preserves new planner data", async () => {
      const s = await seed("dialog_intelligence_scan");
      await db.jobInstance.update({ where: { id: s.job.id }, data: { status: "SCHEDULED", leaseUntil: null,
        leaseTokenHash: null, claimedByDeviceId: null, params: { dialogId: "old-dialog" } } });
      await db.deviceCreatorBinding.create({ data: { agencyId: s.agency.id, creatorId: s.creator.id,
        deviceId: s.device.id, sessionReadReady: true, lastSeenAt: new Date() } });
      const n = attempts; changeCandidateAtLock = s.job.id;
      const claimed = await lease.claimJob({ userId: s.user.id, deviceId: s.device.id,
        jobKeys: ["dialog_intelligence_scan"], leaseMs: 30000 });
      assert.equal(claimed.reason, "claimed"); assert.equal(attempts - n, 2);
      assert.equal(claimed.job.params.dialogId, "new-dialog"); assert.equal(claimed.job.params.plannedAgain, true);
      assert.ok(new Date(claimed.job.leaseUntil).getTime() > Date.now() + 25000);
    });
    await check("expired-owner cooperative release remains legal and clears causal read lease", async () => {
      const s = await seed();
      await lease.acquireJobFanObservationReadLease({ ...s.input, purpose: "fan_data_point_refresh", requestId: "release-proof" });
      assert.equal(await db.fanObservationReadLease.count({ where: { jobId: s.job.id } }), 1);
      await db.jobInstance.update({ where: { id: s.job.id }, data: { leaseUntil: new Date(0) } });
      const result = await lease.releaseJob({ ...s.input, reason: "context lost" });
      assert.equal(result.status, "SCHEDULED"); assert.equal(result.attempts, 0);
      assert.equal(await db.fanObservationReadLease.count({ where: { jobId: s.job.id } }), 0);
    });
    const completed = await seed("catchup_notifications_scan");
    const generation = "i3-complete-proof";
    await db.jobInstance.update({ where: { id: completed.job.id }, data: { params: {
      ...completed.job.params, types: ["tips"], collectionContractVersion: 1,
      collectionType: "NOTIFICATIONS", collectionGeneration: generation,
      collectionRequestedAt: new Date().toISOString(), collectionMode: "catchup",
    } } });
    const completion = { ...completed.input, result: { schemaVersion: 5, notificationMode: "catchup",
      scanRunId: generation, sourceExhausted: true, totalAcceptedEvents: 0,
      coverage: { tips: { status: "complete", rejected: 0 } } } };
    await check("actual completion rolls back DONE and sync when required intent publication fails", async () => {
      const before = await db.jobInstance.findUnique({ where: { id: completed.job.id } });
      await db.$executeRawUnsafe(`INSERT INTO "I3ProofFault" VALUES('publish')`);
      try { await assert.rejects(() => lease.completeJob(completion), /I3_PUBLISH_ROLLBACK/); }
      finally { await db.$executeRawUnsafe(`DELETE FROM "I3ProofFault" WHERE kind='publish'`); }
      assert.deepEqual(await db.jobInstance.findUnique({ where: { id: completed.job.id } }), before);
      assert.equal(await db.creatorNotificationSyncState.count({ where: { creatorId: completed.creator.id } }), 0);
      assert.equal(await db.domainWorkItem.count({ where: { workClass: effects.WORK_CLASS, objectId: completed.job.id } }), 0);
    });
    await check("actual completion commits DONE, sync and durable intent together", async () => {
      const result = await lease.completeJob(completion);
      assert.equal(result.job.status, "DONE");
      assert.equal((await db.jobInstance.findUnique({ where: { id: completed.job.id } })).status, "DONE");
      assert.equal(await db.creatorNotificationSyncState.count({ where: { creatorId: completed.creator.id } }), 1);
      assert.equal(await db.domainWorkItem.count({ where: { workClass: effects.WORK_CLASS, objectId: completed.job.id, isOutstanding: true } }), 1);
    });
    const s = await seed("catchup_notifications_scan");
    await check("durable intent cannot survive a rolled-back producer commit", async () => {
      await assert.rejects(() => db.$transaction(async tx => { await effects.publishNotificationConsequences({ db: tx, job: s.job }); throw new Error("producer rollback"); }), /producer rollback/);
      assert.equal(await db.domainWorkItem.count({ where: { workClass: effects.WORK_CLASS, objectId: s.job.id } }), 0);
    });
    await db.jobInstance.update({ where: { id: s.job.id }, data: { status: "DONE", completedAt: new Date(), leaseUntil: null } });
    await effects.publishNotificationConsequences({ db, job: s.job });
    const fan = await db.creatorFan.create({ data: { agencyId: s.agency.id, creatorId: s.creator.id, onlyFansUserId: "123", username: "proof-fan" } });
    const source = await db.trafficSource.create({ data: { agencyId: s.agency.id, creatorId: s.creator.id, accountId: s.creator.id, sourceType: "CAMPAIGN", externalId: "proof-source", name: "proof" } });
    await db.trafficSourceMember.create({ data: { agencyId: s.agency.id, creatorId: s.creator.id, sourceId: source.id, fanId: "123", needsValueRefresh: false } });
    await db.creatorSale.createMany({ data: Array.from({ length: 51 }, (_, i) => ({ id: `i3-sale-${String(i).padStart(4,"0")}`, agencyId: s.agency.id, creatorId: s.creator.id,
      fanRecordId: fan.id, fanOnlyFansUserIdAtEvent: "123", eventFingerprint: crypto.createHash("sha256").update(`i3-sale-fp-${i}`).digest("hex"), messageId: String(10000 + i), amountCents: 100, purchasedAt: new Date(), sourceJobId: s.job.id })) });
    await db.creatorSubscriptionEvent.create({ data: { agencyId: s.agency.id, creatorId: s.creator.id, fanRecordId: fan.id,
      eventFingerprint: crypto.createHash("sha256").update("i3-sub-fp").digest("hex"), eventType: "SUBSCRIBED_PAID",
      observedPriceCents: 500, currency: "USD", occurredAt: new Date(), sourceJobId: s.job.id } });
    const newerSync = await db.creatorNotificationSyncState.create({ data: { agencyId: s.agency.id,
      creatorId: s.creator.id, activeGeneration: "i3-newer-generation", activeRequestedAt: new Date(),
      status: "COMPLETE", headNotificationId: "i3-newer-head", fullBackfillVerifiedAt: new Date() } });
    async function claim() {
      const result = await work.claimDomainWorkBatch({ db, workClass: effects.WORK_CLASS, agencyId: s.agency.id, limit: 1, leaseMs: 120000 });
      assert.equal(result.items.length, 1); return { item: result.items[0], ownerToken: result.ownerToken };
    }
    let first;
    await check("page failure after projection rolls back both effects and durable cursor", async () => {
      first = await claim();
      const before = await db.domainWorkItem.findUnique({ where: { id: first.item.id } });
      await db.$executeRawUnsafe(`INSERT INTO "I3ProofFault" VALUES('cursor')`);
      try { await assert.rejects(() => effects.processNotificationConsequencePage({ db, ...first }), /I3_CURSOR_ROLLBACK/); }
      finally { await db.$executeRawUnsafe(`DELETE FROM "I3ProofFault" WHERE kind='cursor'`); }
      assert.deepEqual(await db.domainWorkItem.findUnique({ where: { id: first.item.id } }), before);
      assert.equal((await db.trafficSourceMember.findFirst({ where: { sourceId: source.id } })).needsValueRefresh, false);
    });
    await check("existing DomainWork claim finds durable notification intent; first quantum is exactly 50 rows", async () => {
      const result = await effects.processNotificationConsequencePage({ db, ...first });
      assert.equal(result.processed, 50); assert.equal(result.yielded, true);
      const stored = await db.domainWorkItem.findUnique({ where: { id: first.item.id } });
      assert.equal(stored.progressCursor.afterId, "i3-sale-0049");
      assert.equal((await db.trafficSourceMember.findFirst({ where: { sourceId: source.id } })).needsValueRefresh, true);
    });
    await check("stale pre-yield claim cannot project again", async () => {
      await assert.rejects(() => effects.processNotificationConsequencePage({ db, ...first }), /CLAIM_LOST/);
    });
    await check("module reload consumes saved cursor and completes without re-ingesting or rewinding sync", async () => {
      delete require.cache[require.resolve("../../src/services/notification-consequence-service")];
      const restarted = require("../../src/services/notification-consequence-service");
      const processed = [];
      for (let i = 0; i < 3; i++) processed.push(await restarted.processNotificationConsequencePage({ db, ...await claim() }));
      assert.deepEqual(processed.map(x => x.processed), [1,0,1]);
      assert.equal(await db.creatorSubscriptionLedger.count({ where: { creatorId: s.creator.id } }), 1);
      assert.equal(processed.at(-1).completed, true);
      const stored = await db.domainWorkItem.findUnique({ where: { id: first.item.id } });
      assert.equal(stored.state, "DONE"); assert.equal(stored.isOutstanding, false);
      assert.equal(await db.analyticsIngestBatch.count({ where: { sourceJobId: s.job.id } }), 0);
      assert.deepEqual(await db.creatorNotificationSyncState.findUnique({ where: { creatorId: s.creator.id } }), newerSync);
    });
    await check("re-published consequence intent does not duplicate subscription money", async () => {
      await effects.publishNotificationConsequences({ db, job: s.job });
      for (let i = 0; i < 4; i++) await effects.processNotificationConsequencePage({ db, ...await claim() });
      const ledger = await db.creatorSubscriptionLedger.findMany({ where: { creatorId: s.creator.id } });
      assert.equal(ledger.length, 1); assert.equal(ledger[0].amountCents, 500);
      assert.equal((await db.domainWorkItem.findUnique({ where: { id: first.item.id } })).isOutstanding, false);
    });
    const output = { ok: true, engine: "PGlite PostgreSQL WASM via Prisma TCP", prisma: "5.22.0", fullMigrationChain: true, nativeConcurrentPostgres: false, cases };
    if (process.env.PHASE5_PROOF_OUTPUT) fs.writeFileSync(process.env.PHASE5_PROOF_OUTPUT, JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output));
  } finally { await db.$disconnect(); await server.stop(); await engine.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
