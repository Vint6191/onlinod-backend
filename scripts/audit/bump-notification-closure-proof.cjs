"use strict";
// Real Prisma/services and disposable SQL. Not a native PostgreSQL multi-session
// concurrency proof: the local PGlite socket serializes one physical connection.
const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs"), crypto = require("node:crypto");
const root = process.env.N2_PROOF_BACKEND ? path.resolve(process.env.N2_PROOF_BACKEND) : path.resolve(__dirname, "../..");
const load = file => require(path.join(root, file));
async function main() {
  const fixture = await load("scripts/test-support/admin-sql-runtime.cjs").createAdminSqlRuntime({ runtimePath: process.env.N2_PROOF_RUNTIME });
  const { db, queries } = fixture, cases = [], plans = {};
  const baseline = process.env.N2_PROOF_BASELINE === "1";
  const check = async (name, fn) => { await fn(); cases.push({ name, status: "PASS" }); console.log(JSON.stringify(cases.at(-1))); };
  let delayPermit = false, permitDelayed = false;
  const wrappedDb = new Proxy(db, { get(target, key) {
    if (key === "$transaction") return async (callback, options) => target.$transaction(async tx => callback(new Proxy(tx, { get(client, method) {
      if (method === "$executeRawUnsafe") return async (sql, ...args) => {
        if (delayPermit && sql.includes("set_config('onlinod.phase3_fan_consumer_generation'")) {
          permitDelayed = true; await client.$executeRawUnsafe("SELECT pg_sleep(1.2)");
        }
        return client.$executeRawUnsafe(sql, ...args);
      };
      const value = client[method]; return typeof value === "function" ? value.bind(client) : value;
    } })), options);
    const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
  } });
  require.cache[require.resolve(path.join(root, "src/prisma"))] = { exports: wrappedDb };
  try {
    await load("scripts/database/background-maintenance-indexes").ensureIndexes(db, { create: true });
    const clock = async () => (await db.$queryRawUnsafe('SELECT clock_timestamp() AS "now"'))[0].now;
    const seedNow = await clock();
    const s = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)", "phase2_team_control_plane_v2_durable_access");
      const user = await tx.user.create({ data: { email: "n2-proof@example.test", passwordHash: "fixture" } });
      const agency = await tx.agency.create({ data: { name: "N2 proof", trialEndsAt: new Date(+seedNow + 86400000) } });
      const member = await tx.agencyMember.create({ data: { agencyId: agency.id, userId: user.id, role: "OWNER", roleKey: "owner", assignedCreators: "all" } });
      const creator = await tx.creatorAccount.create({ data: { agencyId: agency.id, displayName: "Fixture", status: "READY" } });
      const device = await tx.workerDevice.create({ data: { agencyId: agency.id, userId: user.id } });
      return { agencyId: agency.id, creatorId: creator.id, userId: user.id, memberId: member.id, accessEpoch: member.accessEpoch, deviceId: device.id };
    });
    assert.equal(await db.creatorAccount.count(), 1, "fixture commit must be durable");
    await db.automationControlState.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, scopeKey: `creator:${s.creatorId}:module:bumps`, moduleKey: "bumps", enabled: true, settings: { enabled: true, onlineObservationTtlMs: 30000 } } });
    const fan = await db.creatorFan.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, onlyFansUserId: "123" } });
    const at = await clock();
    await db.creatorFanRelationshipCurrent.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, fanRecordId: fan.id, onlyFansUserId: "123",
      canReceiveChatMessage: true, canReceiveChatMessageAuthorityVersion: `${at.toISOString()}|0700|USER_PROFILE|n2`, observedAt: at, source: "USER_PROFILE" } });
    const actions = load("src/services/automation-action-delivery-service"), bumps = load("src/services/bump-service");
    const { runRootCommit } = load("src/services/db-commit-kernel");
    const token = "fixture-lease", tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    let sequence = 0;
    async function delivery({ age = 0, source = "online", state = true, leaseMs = 60000 } = {}) {
      const now = await clock();
      // Close prior fixture rows to free the creator's physical write-lane index.
      await db.automationDelivery.updateMany({ where: { creatorId: s.creatorId, status: { in: ["RUNNING", "COMMITTING"] } }, data: { status: "COMPLETED", finishedAt: now } });
      const d = await runRootCommit(db, async ({ tx }) => tx.automationDelivery.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, moduleKey: "bumps", actionType: "SEND_MESSAGE", targetId: "123", fanId: "123", dialogId: "123",
        idempotencyKey: `n2:${++sequence}`, originKind: "AUTOMATION", status: "RUNNING", notBefore: now,
        claimedByDeviceId: s.deviceId, claimedAt: now, claimUntil: new Date(+now + leaseMs), leaseTokenHash: tokenHash, leaseRevision: 1,
        leaseMemberId: s.memberId, leaseAccessEpoch: s.accessEpoch, payload: { source, template: { id: "template", text: "fixture", mediaFiles: [] } } } }), { profile: "JOB_CHUNK" });
      if (state) await db.automationBumpFanState.upsert({ where: { creatorId_fanId: { creatorId: s.creatorId, fanId: "123" } },
        create: { agencyId: s.agencyId, creatorId: s.creatorId, fanId: "123", lastOnlineAt: new Date(+now - age), pendingDeliveryId: d.id },
        update: { lastOnlineAt: new Date(+now - age), pendingDeliveryId: d.id, pendingMessageId: null, cooldownUntil: null, blocked: false, ignored: false } });
      else await db.automationBumpFanState.deleteMany({ where: { creatorId: s.creatorId } });
      return d;
    }
    const input = d => ({ deliveryId: d.id, userId: s.userId, deviceId: s.deviceId, leaseToken: token, leaseRevision: d.leaseRevision });
    const row = d => db.automationDelivery.findUnique({ where: { id: d.id } });
    await check("online signal expiring during prepare validation cannot cross COMMITTING", async () => {
      const d = await delivery({ age: 29000 }); delayPermit = true; permitDelayed = false;
      try {
        if (baseline) assert.equal((await actions.prepareWriteActionDelivery(input(d))).status, "COMMITTING");
        else await assert.rejects(actions.prepareWriteActionDelivery(input(d)), { code: "stale_candidate" });
      } finally { delayPermit = false; }
      assert.equal(permitDelayed, true, "expiry must happen after the initial validation");
      const stored = await row(d); assert.equal(stored.status, baseline ? "COMMITTING" : "SKIPPED");
      if (!baseline) {
        assert.equal(stored.writeCommitAt, null); assert.equal(stored.writeCommitRevision, 0); assert.equal(stored.leaseTokenHash, null);
        assert.equal((await db.automationBumpFanState.findUnique({ where: { creatorId_fanId: { creatorId: s.creatorId, fanId: "123" } } })).pendingDeliveryId, null);
      }
    });
    if (baseline) return;
    await check("fresh online permit and duplicate request mint exactly one revision", async () => {
      const d = await delivery(); const first = await actions.prepareWriteActionDelivery(input(d));
      assert.equal(first.status, "COMMITTING"); assert.equal(first.writeCommitRevision, 1);
      const second = await actions.prepareWriteActionDelivery(input(d)); assert.equal(second.duplicate, true); assert.equal(second.writeCommitRevision, 1);
    });
    await check("initially stale, missing and future online evidence terminalize without permits", async () => {
      for (const spec of [{ age: 40000 }, { state: false }, { age: -60000 }]) {
        const d = await delivery(spec); await assert.rejects(actions.prepareWriteActionDelivery(input(d)), { code: "stale_candidate" });
        assert.equal((await row(d)).status, "SKIPPED"); assert.equal((await row(d)).writeCommitAt, null);
      }
    });
    await check("manual sends retain their own policy without an online trigger", async () => {
      const d = await delivery({ source: "manual", state: false }); assert.equal((await actions.prepareWriteActionDelivery(input(d))).status, "COMMITTING");
    });
    await check("wrong token and expired lease cannot terminalize or commit another attempt", async () => {
      const d = await delivery(); await assert.rejects(actions.prepareWriteActionDelivery({ ...input(d), leaseToken: "other" }), { code: "DELIVERY_LEASE_STALE" });
      await db.automationDelivery.update({ where: { id: d.id }, data: { claimUntil: new Date(0) } });
      await assert.rejects(actions.prepareWriteActionDelivery(input(d)), { code: "DELIVERY_LEASE_EXPIRED" }); assert.equal((await row(d)).status, "RUNNING");
    });
    await check("terminal fan cleanup failure rolls the SQL denial back atomically", async () => {
      await db.$executeRawUnsafe(`CREATE FUNCTION n2_cleanup_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."pendingDeliveryId" IS NULL AND OLD."pendingDeliveryId" IS NOT NULL THEN RAISE EXCEPTION 'N2_CLEANUP_ROLLBACK'; END IF; RETURN NEW; END $$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER n2_cleanup_fault BEFORE UPDATE ON "AutomationBumpFanState" FOR EACH ROW EXECUTE FUNCTION n2_cleanup_fault()`);
      const d = await delivery({ age: 29000 }); delayPermit = true;
      try { await assert.rejects(actions.prepareWriteActionDelivery(input(d)), /N2_CLEANUP_ROLLBACK/); }
      finally { delayPermit = false; await db.$executeRawUnsafe('DROP TRIGGER n2_cleanup_fault ON "AutomationBumpFanState"'); }
      assert.equal((await row(d)).status, "RUNNING"); assert.equal((await row(d)).writeCommitAt, null);
    });
    await check("delayed and duplicate observations cannot move the trigger clock backwards", async () => {
      const now = await clock();
      for (const observedAt of [now, new Date(+now - 10000), now]) await bumps.recordOnlineObservations({ db, agencyId: s.agencyId, creatorId: s.creatorId, fanIds: ["123"], observedAt });
      const state = await db.automationBumpFanState.findUnique({ where: { creatorId_fanId: { creatorId: s.creatorId, fanId: "123" } } }); assert.equal(+state.lastOnlineAt, +now);
    });
    const work = load("src/services/domain-work-authority-service");
    const recovery = load("src/services/notification-identity-recovery-service");
    const occurred = await clock();
    await db.creatorTip.create({data:{agencyId:s.agencyId,creatorId:s.creatorId,eventFingerprint:"b".repeat(64),amountCents:100,tippedAt:occurred,createdAt:occurred}});
    await check("orphan notification receipts complete through the live durable consumer", async () => {
      const job = await db.jobInstance.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, jobKey: "catchup_notifications_scan", scope: "creator", status: "DONE", params: { notificationMode: "catchup" } } });
      const tip = await db.creatorTip.findFirst();
      const receipts = load("src/services/notification-fact-receipt-service");
      await runRootCommit(db, ({ tx }) => receipts.capture({ db: tx, job, groups: [{ kind: "CreatorTip", ids: [tip.id] }] }), { profile: "JOB_CHUNK" });
      const claim = await work.claimDomainWorkBatch({ db, workClass: receipts.WORK_CLASS, limit: 1 }); assert.equal(claim.items.length, 1);
      assert.equal((await receipts.processPage({ db, item: claim.items[0], ownerToken: claim.ownerToken })).completed, true);
      assert.equal(await db.notificationFactReceipt.count({ where: { jobId: job.id } }), 0); assert.equal(await db.creatorTip.count(), 1);
    });
    await check("online postflight verifies the new partial predicate and refuses a wrong index", async () => {
      const indexes = load("scripts/database/background-maintenance-indexes");
      assert.equal((await indexes.ensureIndexes(db, { create: true })).contracts, 4);
      await db.$executeRawUnsafe('DROP INDEX "DomainWorkItem_notification_identity_recovery_idx"');
      await db.$executeRawUnsafe('CREATE INDEX "DomainWorkItem_notification_identity_recovery_idx" ON "DomainWorkItem"("id")');
      await assert.rejects(indexes.ensureIndexes(db), /MAINTENANCE_INDEX_INVALID/);
      await db.$executeRawUnsafe('DROP INDEX "DomainWorkItem_notification_identity_recovery_idx"');
      await assert.rejects(indexes.ensureIndexes(db), /MAINTENANCE_INDEX_REQUIRED/);
      await indexes.ensureIndexes(db, { create: true });
    });
    await check("recovery admits four exact identities per pass without replaying an already resumed row", async () => {
      const ids = [];
      for (let i = 0; i < 5; i++) {
        const job = await db.jobInstance.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, jobKey: "catchup_notifications_scan", scope: "creator", status: "DONE" } });
        await runRootCommit(db, async ({ tx }) => {
          const item = await work.publishDomainWork({ db: tx, agencyId: s.agencyId, creatorId: s.creatorId, workClass: "NOTIFICATION_FACT_RECEIPTS", objectType: "JobInstance", objectId: job.id, parentObjectId: s.creatorId, partitionKey: s.creatorId });
          ids.push(item.id);
          await tx.domainWorkItem.update({ where: { id: item.id }, data: { state: "RECONCILE_REQUIRED", terminalCause: "RETRY_EXHAUSTED:BAD_TRAFFIC_DIRTY_INPUT", consecutiveFailures: 8 } });
        }, { profile: "JOB_CHUNK" });
      }
      assert.equal((await recovery.recoverNotificationIdentityWork({ db })).resumed, 4);
      assert.equal((await recovery.recoverNotificationIdentityWork({ db })).resumed, 1);
      assert.equal((await recovery.recoverNotificationIdentityWork({ db })).selected, 0);
      const rows = await db.domainWorkItem.findMany({ where: { id: { in: ids } } });
      assert.ok(rows.every(r => r.state === "READY" && r.requestedRevision === 2n && r.lastRepair.kind === recovery.KIND));
    });
    await check("recovery uses its partial index behind 10000 completed work records", async () => {
      // Fixture loading is not the operation under measurement. Keep each seed
      // root bounded instead of extending production JOB_CHUNK deadlines.
      for (let start = 0; start < 10000; start += 500) {
        await runRootCommit(db, async ({ tx }) => {
          await tx.domainWorkItem.createMany({ data: Array.from({ length: 500 }, (_, i) => ({ id: `noise:${start + i}`, agencyId: s.agencyId, creatorId: s.creatorId, workClass: "NOTIFICATION_FACT_RECEIPTS", objectType: "FixtureNoise", objectId: String(start + i), partitionKey: s.creatorId, state: "DONE", isOutstanding: false })) });
        }, { profile: "JOB_CHUNK" });
      }
      assert.equal(await db.domainWorkItem.count({ where: { objectType: "FixtureNoise", agencyId: s.agencyId, creatorId: s.creatorId } }), 10000);
      await db.$executeRawUnsafe('ANALYZE "DomainWorkItem"');
      plans.recovery = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT "id","agencyId","creatorId" FROM "DomainWorkItem" WHERE ${recovery.PREDICATE} ORDER BY "id" LIMIT 4`);
      assert.match(JSON.stringify(plans.recovery), /DomainWorkItem_notification_identity_recovery_idx/); assert.doesNotMatch(JSON.stringify(plans.recovery), /Seq Scan/);
    });
  } finally {
    const report = { cases, plans, baseline, migrations: fixture.migrations.length, runtime: process.version, limitations: ["PGlite with one serialized SQL connection; native PostgreSQL/Windows/live provider/production scale not verified"] };
    if (process.env.N2_PROOF_OUTPUT) fs.writeFileSync(process.env.N2_PROOF_OUTPUT, JSON.stringify(report, null, 2) + "\n");
    await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
