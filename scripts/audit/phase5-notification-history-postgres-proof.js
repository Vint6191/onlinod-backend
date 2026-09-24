"use strict";
const { runDbTransaction } = require("../../src/services/db-transaction-service");
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
  console.log("[I5 proof] starting disposable SQL engine");
  const engine = await PGlite.create();
  const server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0 });
  await server.start();
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const db = new PrismaClient({ datasources: { db: { url } }, log: [{emit:"event",level:"query"}] });
  const queries=[]; db.$on("query",event=>queries.push(event.query));
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
    console.log("[I5 proof] full migration chain applied");
    await engine.exec("DISCARD ALL");
    await engine.exec("SET TIME ZONE 'UTC'");
    await engine.exec(`UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE'`);
    await engine.exec(`UPDATE "Phase2ReleaseCompatibilityAuthority" SET "requiredGeneration"='phase3_domain_executor_v6_failure_policy',"activationState"='ACTIVE' WHERE "scope"='DOMAIN_WORK_EXECUTOR'`);
    const work = require("../../src/services/domain-work-authority-service");
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const history = require("../../src/services/notification-history-repair-service");
    const consequences = require("../../src/services/notification-consequence-service");
    const { ensureNotificationIndexes, INDEXES } = require("../database/phase5-notification-history-indexes-online-preflight");
    let seq = 0;
    async function seed() {
      const name = "i5-" + (++seq);
      return db.$transaction(async tx => {
        await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)", "phase2_team_control_plane_v2_durable_access");
        const user = await tx.user.create({ data: { email: name + "@example.test", passwordHash: "proof" } });
        const agency = await tx.agency.create({ data: { name, trialEndsAt: new Date(Date.now() + 86400000) } });
        await tx.agencyMember.create({ data: { agencyId: agency.id, userId: user.id, role: "OWNER", roleKey: "owner", assignedCreators: "all" } });
        const creator = await tx.creatorAccount.create({ data: { agencyId: agency.id, displayName: name, status: "READY" } });
        const job = await tx.jobInstance.create({ data: { agencyId: agency.id, creatorId: creator.id, jobKey: "catchup_notifications_scan", scope: "creator", status: "DONE", completedAt: new Date(), params: { notificationMode: "catchup" } } });
        return { agency, creator, job, user };
      });
    }
    const s = await seed(), other = await seed();
    console.log("[I7 proof] tenant seeds committed");
    const at = new Date(Date.now() - 86400000), cutoff = new Date();
    const source = await db.trafficSource.create({ data: { agencyId: s.agency.id, creatorId: s.creator.id, accountId: s.creator.id, sourceType: "CAMPAIGN", externalId: "i5-source", name: "proof" } });
    const lastRevenueAt = new Date(Date.now() - 1000), convertedAt = new Date(at.getTime() - 86400000);
    const member = await db.trafficSourceMember.create({ data: { agencyId: s.agency.id, creatorId: s.creator.id, sourceId: source.id, fanId: "123", lastRevenueAt, convertedAt, needsValueRefresh: false } });
    await db.creatorSale.createMany({ data: Array.from({ length: 51 }, (_, i) => ({ id: `i5-sale-${String(i).padStart(4,"0")}`, agencyId: s.agency.id, creatorId: s.creator.id,
      fanOnlyFansUserIdAtEvent: "123", eventFingerprint: crypto.createHash("sha256").update(`i5-sale-${i}`).digest("hex"), amountCents: 100, messageId: "proof", purchasedAt: at, createdAt: at, sourceJobId: s.job.id })) });
    console.log("[I7 proof] sale fixtures committed");
    await db.creatorTip.createMany({ data: [
      { id: "i5-tip-a", agencyId: s.agency.id, creatorId: s.creator.id, fanOnlyFansUserIdAtEvent: "123", eventFingerprint: crypto.createHash("sha256").update("tip-orphan").digest("hex"), amountCents: 100, tippedAt: at, createdAt: at },
      { id: "i5-tip-b", agencyId: s.agency.id, creatorId: s.creator.id, eventFingerprint: crypto.createHash("sha256").update("tip-no-identity").digest("hex"), amountCents: 100, tippedAt: at, createdAt: at },
    ] });
    for (const eventType of ["SUBSCRIBED_PAID", "EXPIRED", "AUTO_RENEW_ENABLED"]) await db.creatorSubscriptionEvent.create({ data: { id: "i5-sub-" + eventType, agencyId: s.agency.id, creatorId: s.creator.id,
      fanOnlyFansUserIdAtEvent: "123", eventFingerprint: crypto.createHash("sha256").update("i5-" + eventType).digest("hex"), eventType, observedPriceCents: 500, occurredAt: at, createdAt: at } });
    await db.creatorSubscriptionLedger.create({ data: { agencyId: s.agency.id, creatorId: s.creator.id, accountId: s.creator.id,
      fanId: "123", sourceId: source.id, source: "canonical_subscription_fact", eventType: "subscription_expired",
      eventHash: crypto.createHash("sha256").update("i5-EXPIRED").digest("hex"), amountCents: 500, occurredAt: at } });
    await db.creatorSale.create({ data: { id: "i5-future", agencyId: s.agency.id, creatorId: s.creator.id, fanOnlyFansUserIdAtEvent: "123", eventFingerprint: crypto.createHash("sha256").update("future").digest("hex"), amountCents: 100, messageId: "proof", purchasedAt: at, createdAt: new Date(cutoff.getTime() + 86400000) } });
    await db.creatorSale.create({ data: { agencyId: other.agency.id, creatorId: other.creator.id, fanOnlyFansUserIdAtEvent: "other", eventFingerprint: crypto.createHash("sha256").update("other").digest("hex"), amountCents: 100, messageId: "proof", purchasedAt: at, createdAt: at } });
    await db.jobInstance.delete({ where: { id: s.job.id } }); // Actual ON DELETE SET NULL provenance loss.
    const sync = await db.creatorNotificationSyncState.create({ data: { agencyId: s.agency.id, creatorId: s.creator.id, activeGeneration: "newer-live-generation", status: "COMPLETE", headNotificationId: "newer-head" } });
    await db.maintenanceLaneState.update({ where: { key: history.KEY }, data: { cursor: { afterId: "", upperId: other.creator.id, cutoffAt: cutoff.toISOString() }, completedAt: null, progress: { enumerated: 0, published: 0 } } });
    await engine.exec(`CREATE TABLE "I5ProofFault" (kind text PRIMARY KEY);
      CREATE FUNCTION i5_proof_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_TABLE_NAME='MaintenanceLaneState' THEN
          IF NEW."key"='phase5_notification_history_v1'
          AND EXISTS(SELECT 1 FROM "I5ProofFault" WHERE kind='enumeration') THEN RAISE EXCEPTION 'I5_ENUMERATION_ROLLBACK'; END IF;
        ELSE
        IF TG_TABLE_NAME='DomainWorkItem' AND NEW."workClass"='NOTIFICATION_HISTORY_REPAIR'
          AND NEW."progressCursor" IS DISTINCT FROM OLD."progressCursor"
          AND EXISTS(SELECT 1 FROM "I5ProofFault" WHERE kind='cursor') THEN RAISE EXCEPTION 'I5_CURSOR_ROLLBACK'; END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER i5_catalog_fault BEFORE UPDATE ON "MaintenanceLaneState" FOR EACH ROW EXECUTE FUNCTION i5_proof_fault();
      CREATE TRIGGER i5_cursor_fault BEFORE UPDATE ON "DomainWorkItem" FOR EACH ROW EXECUTE FUNCTION i5_proof_fault()`);
    await check("all six migrated indexes pass the actual online preflight structural verifier", async () => { await ensureNotificationIndexes(db); });
    await check("catalog cursor failure rolls back every published intent", async () => {
      const before = await db.maintenanceLaneState.findUnique({ where: { key: history.KEY } });
      await db.$executeRawUnsafe('INSERT INTO "I5ProofFault" VALUES(\'enumeration\')');
      try { await assert.rejects(history.enumerateHistoryCreators({ db }), /I5_ENUMERATION_ROLLBACK/); } finally { await db.$executeRawUnsafe('DELETE FROM "I5ProofFault"'); }
      assert.equal(await db.domainWorkItem.count({ where: { workClass: history.WORK_CLASS } }), 0);
      assert.deepEqual(await db.maintenanceLaneState.findUnique({ where: { key: history.KEY } }), before);
    });
    await check("catalog enumeration commits scoped work and cursor together; repeat does not republish", async () => {
      const result = await history.enumerateHistoryCreators({ db }); assert.equal(result.published, 2); assert.equal(result.complete, true);
      const before = await db.domainWorkItem.findMany({ where: { workClass: history.WORK_CLASS }, orderBy: { id: "asc" } });
      await history.enumerateHistoryCreators({ db });
      assert.deepEqual(await db.domainWorkItem.findMany({ where: { workClass: history.WORK_CLASS }, orderBy: { id: "asc" } }), before);
    });
    async function claim(agencyId = s.agency.id) {
      const result = await work.claimDomainWorkBatch({ db, agencyId, workClass: history.WORK_CLASS, limit: 1, leaseMs: 120000 });
      assert.equal(result.items.length, 1); return { item: result.items[0], ownerToken: result.ownerToken };
    }
    let first;
    await check("history effect and cursor rollback together after source Job was deleted", async () => {
      first = await claim(); const before = await db.domainWorkItem.findUnique({ where: { id: first.item.id } });
      await db.$executeRawUnsafe('INSERT INTO "I5ProofFault" VALUES(\'cursor\')');
      try { await assert.rejects(history.processHistoryPage({ db, ...first }), /I5_CURSOR_ROLLBACK/); } finally { await db.$executeRawUnsafe('DELETE FROM "I5ProofFault"'); }
      assert.deepEqual(await db.domainWorkItem.findUnique({ where: { id: first.item.id } }), before);
      assert.equal((await db.trafficSourceMember.findUnique({ where: { id: member.id } })).needsValueRefresh, false);
    });
    await check("first quantum is exactly fifty orphan facts; later revenue timestamp is preserved", async () => {
      const result = await history.processHistoryPage({ db, ...first }); assert.equal(result.processed, 50); assert.equal(result.yielded, true);
      const state = await db.domainWorkItem.findUnique({ where: { id: first.item.id } }); assert.equal(state.progressCursor.afterId, "i5-sale-0049");
      const current = await db.trafficSourceMember.findUnique({ where: { id: member.id } }); assert.equal(current.needsValueRefresh, true); assert.deepEqual(current.lastRevenueAt, lastRevenueAt);
    });
    await check("stale yielded claim cannot replay effects", async () => { await assert.rejects(history.processHistoryPage({ db, ...first }), /CLAIM_LOST/); });
    await check("reload resumes cursor, repairs prior expiry receipt, restores only paid subscription, records identity gaps and preserves collector frontier", async () => {
      delete require.cache[require.resolve("../../src/services/notification-history-repair-service")];
      const restarted = require("../../src/services/notification-history-repair-service"); const results = [];
      for (let i = 0; i < 3; i++) results.push(await restarted.processHistoryPage({ db, ...await claim() }));
      assert.deepEqual(results.map(r => r.processed), [1,2,3]); assert.ok(results.at(-1).completed);
      const ledger = await db.creatorSubscriptionLedger.findMany({ where: { creatorId: s.creator.id } });
      assert.equal(ledger.length, 1); assert.equal(ledger[0].eventType, "paid_subscribed"); assert.equal(ledger[0].fanId, "123");
      const report = (await db.domainWorkItem.findUnique({ where: { id: first.item.id } })).lastRepair;
      assert.equal(report.processed, 56); assert.equal(report.identityMissing, 1); assert.equal(report.coverage, "RETAINED_FACTS_WITH_IDENTITY_GAPS");
      assert.deepEqual(await db.creatorNotificationSyncState.findUnique({ where: { creatorId: s.creator.id } }), sync);
      assert.equal(await db.teamObservationState.count({ where: { creatorId: s.creator.id } }), 0);
      assert.equal(await db.automationDelivery.count({ where: { creatorId: s.creator.id } }), 0);
      assert.deepEqual((await db.trafficSourceMember.findUnique({ where: { id: member.id } })).convertedAt, convertedAt);
      assert.equal(await db.trafficDailyAggregate.count({ where: { sourceId: source.id } }), 0);
      assert.equal(await db.creatorSubscriptionLedger.count({ where: { creatorId: other.creator.id } }), 0);
    });
    await check("normal producer replay does not duplicate recovered paid ledger or aggregate", async () => {
      const rows = await db.creatorSubscriptionEvent.findMany({ where: { creatorId: s.creator.id } });
      await runDbTransaction(db, tx => consequences.projectFacts({ db: tx, job: { agencyId: s.agency.id, creatorId: s.creator.id, params: {} }, table: 2, rows, historical: true }));
      assert.equal(await db.creatorSubscriptionLedger.count({ where: { creatorId: s.creator.id } }), 1);
      assert.equal(await db.trafficDailyAggregate.count({ where: { sourceId: source.id } }), 0);
    });
    await check("foreign creator claim is rejected without modifying its scope", async () => {
      const c = await claim(other.agency.id);
      await assert.rejects(history.processHistoryPage({ db, item: { ...c.item, creatorId: s.creator.id }, ownerToken: c.ownerToken }), { code: "NOTIFICATION_HISTORY_SCOPE_INVALID" });
      await db.creatorAccount.update({ where: { id: other.creator.id }, data: { deletedAt: new Date() } });
      assert.equal((await history.processHistoryPage({ db, ...c })).retired, true);
    });
    await check("historical retention boundaries preserve organic policy without rebuilding retired aggregate", async () => {
      const traffic = require("../../src/services/traffic-service");
      const fact = { fanId: "no-source", eventType: "paid_subscribed", amountCents: 500, eventHash: "retention-old", occurredAt: new Date("2020-01-01") };
      const policy = { organicCutoff: new Date("2024-01-01"), aggregateCutoff: new Date("2023-01-01") };
      await runDbTransaction(db, async tx => {
        const a = await traffic.projectCanonicalSubscriptionCompatibility({ db: tx, job: { agencyId: s.agency.id, creatorId: s.creator.id }, fact, historyPolicy: policy }); assert.equal(a.retentionExcluded, true);
        const b = await traffic.projectCanonicalSubscriptionCompatibility({ db: tx, job: { agencyId: s.agency.id, creatorId: s.creator.id }, fact: { ...fact, fanId: "123", eventHash: "retention-attributed" }, historyPolicy: policy }); assert.equal(b.ignored, false);
      });
      assert.equal(await db.creatorSubscriptionLedger.count({ where: { eventHash: "retention-old" } }), 0);
      assert.equal(await db.trafficDailyAggregate.count({ where: { sourceId: source.id, day: new Date("2020-01-01") } }), 0);
    });
    await check("raw 40001 retries a history page with one cursor transition", async () => {
      const t = await seed();
      const published = await work.publishDomainWork({ db, agencyId: t.agency.id, creatorId: t.creator.id, workClass: history.WORK_CLASS, objectType: "CreatorAccount", objectId: t.creator.id });
      await db.domainWorkItem.update({ where: { id: published.id }, data: { progressCursor: { cutoffAt: cutoff.toISOString(), table: 0, processed: 0 } } });
      const c = await claim(t.agency.id); let attempts = 0;
      const proxy = { $transaction: (fn, opts) => db.$transaction(async tx => {
        const result = await fn(tx); if (++attempts === 1) await tx.$executeRawUnsafe("DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='I5_RETRY'; END $$"); return result;
      }, opts) };
      await history.processHistoryPage({ db: proxy, ...c }); assert.equal(attempts, 2);
      assert.equal((await db.domainWorkItem.findUnique({ where: { id: published.id } })).progressCursor.table, 1);
    });
    const plans = [];
    await check("indexed history and job pages examine one fifty-row quantum on sixty-thousand fact fixture", async () => {
      const scale = await seed(), scaleOther = await seed();
      for (const table of history.TABLES) {
        const timeColumn = table === "CreatorSale" ? '"purchasedAt"' : table === "CreatorTip" ? '"tippedAt"' : '"occurredAt"';
        const columns = table === "CreatorSubscriptionEvent" ? '"eventType","observedPriceCents"' : table === "CreatorSale" ? '"amountCents","messageId"' : '"amountCents"';
        const values = table === "CreatorSubscriptionEvent" ? "'SUBSCRIBED_PAID',100" : table === "CreatorSale" ? "100,'proof'" : '100';
        // Synthetic SELECT-plan fixture only: suppress unrelated per-row work
        // publication while loading it. Constraints and FK triggers remain on.
        // All behavioral proof cases above use the full production triggers.
        await db.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
        try {
          await db.$executeRawUnsafe(`INSERT INTO "${table}" ("id","agencyId","creatorId","eventFingerprint",${timeColumn},${columns},"sourceJobId","createdAt","updatedAt")
            SELECT $1||lpad(g::text,6,'0'),CASE WHEN g%20=0 THEN $2 ELSE $5 END,CASE WHEN g%20=0 THEN $3 ELSE $6 END,
              md5($1||g)||md5($1||g),'2025-01-01'::timestamp,${values},CASE WHEN g%20=0 THEN $4 ELSE $7 END,
              '2025-01-01'::timestamp,clock_timestamp() FROM generate_series(1,20000) g`,
            table + '-scale-', scale.agency.id, scale.creator.id, scale.job.id, scaleOther.agency.id, scaleOther.creator.id, scaleOther.job.id);
        } finally { await db.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER USER`); }
        await db.$executeRawUnsafe(`ANALYZE "${table}"`);
        for (const kind of ["history", "job"]) {
          const sql = kind === "history" ? history.pageSql(table) : `SELECT "id" FROM "${table}" WHERE "agencyId"=$1 AND "creatorId"=$2 AND "sourceJobId"=$3 AND "id">$4 ORDER BY "id" LIMIT $5`;
          const args = kind === "history" ? [scale.agency.id, scale.creator.id, new Date(), new Date("2025-01-01"), table + '-scale-010000', 50] : [scale.agency.id, scale.creator.id, scale.job.id, table + '-scale-010000', 50];
          const output = await db.$queryRawUnsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, ...args);
          const plan = output[0]['QUERY PLAN'][0]; const nodes = []; const visit = n => { nodes.push(n); for (const child of n.Plans || []) visit(child); }; visit(plan.Plan);
          const expected = `${table}_${kind === 'history' ? 'history_repair' : 'consequence_job'}_cursor_idx`;
          assert.ok(nodes.some(n => n['Index Name'] === expected), JSON.stringify(plan));
          assert.ok(!nodes.some(n => ['Seq Scan','Sort'].includes(n['Node Type'])), JSON.stringify(plan));
          assert.equal(plan.Plan['Actual Rows'], 50); assert.ok(nodes.every(n => (n['Rows Removed by Filter'] || 0) <= 1));
          plans.push({ table, kind, expectedIndex: expected, plan });
        }
      }
    });
    await check("catalog enumeration stays bounded at ten creators even with a larger remaining catalog", async () => {
      const scale = await seed();
      await db.creatorAccount.createMany({ data: Array.from({ length: 25 }, (_, i) => ({ id: 'zz-i5-' + String(i).padStart(3,'0'), agencyId: scale.agency.id, displayName: 'scale creator ' + i })) });
      await db.maintenanceLaneState.update({ where: { key: history.KEY }, data: { cursor: { afterId: 'zz-i5-', upperId: 'zz-i5-999', cutoffAt: new Date().toISOString() }, completedAt: null } });
      const result = await history.enumerateHistoryCreators({ db }); assert.equal(result.selected, 10); assert.equal(result.published, 10); assert.equal(result.complete, false);
    });
    await check("wrong same-name index is rejected before deployment", async () => {
      const [name, table] = INDEXES[0]; await db.$executeRawUnsafe(`DROP INDEX "${name}"`);
      await db.$executeRawUnsafe(`CREATE INDEX "${name}" ON "${table}"("id")`);
      await assert.rejects(ensureNotificationIndexes(db), /INDEX_DEFINITION_MISMATCH/);
    });
    const receipt = require("../../src/services/subscription-receipt-projection-service");
    const jobScope = {agencyId:s.agency.id,creatorId:s.creator.id};
    const baseFact = {fanId:"123",eventType:"paid_subscribed",amountCents:100,occurredAt:at};
    await check("I6 standalone full-mode root and durable caller share one receipt identity",async()=>{
      const fact={...baseFact,eventHash:"i6-shared"};
      const a=await receipt.projectCanonicalSubscriptionReceipt({db,job:jobScope,fact});
      const b=await runDbTransaction(db, tx=>receipt.projectCanonicalSubscriptionReceipt({db:tx,job:jobScope,fact}));
      assert.equal(a.duplicate,false);assert.equal(b.duplicate,true);assert.equal(a.ledgerId,b.ledgerId);
      assert.equal(await db.creatorSubscriptionLedger.count({where:{eventHash:fact.eventHash}}),1);
    });
    await check("I6 required member effect failure rolls back the standalone receipt",async()=>{
      await engine.exec(`CREATE FUNCTION i6_member_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF EXISTS(SELECT 1 FROM "I5ProofFault" WHERE kind='member') THEN RAISE EXCEPTION 'I6_MEMBER_ROLLBACK'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER i6_member_fault BEFORE UPDATE ON "TrafficSourceMember" FOR EACH ROW EXECUTE FUNCTION i6_member_fault()`);
      const before=await db.trafficSourceMember.findUnique({where:{id:member.id}});
      await db.$executeRawUnsafe('INSERT INTO "I5ProofFault" VALUES(\'member\')');
      try {await assert.rejects(receipt.projectCanonicalSubscriptionReceipt({db,job:jobScope,fact:{...baseFact,eventHash:"i6-rollback"}}),/I6_MEMBER_ROLLBACK/);}
      finally {await db.$executeRawUnsafe('DELETE FROM "I5ProofFault"');}
      assert.equal(await db.creatorSubscriptionLedger.count({where:{eventHash:"i6-rollback"}}),0);
      assert.deepEqual(await db.trafficSourceMember.findUnique({where:{id:member.id}}),before);
    });
    await check("I6 duplicate fingerprint cannot cross creator or fan identity",async()=>{
      const sibling=await db.creatorAccount.create({data:{agencyId:s.agency.id,displayName:"sibling"}});
      for(const [job,fact] of [[{agencyId:s.agency.id,creatorId:sibling.id},{...baseFact,eventHash:"i6-shared"}],[jobScope,{...baseFact,eventHash:"i6-shared",fanId:"456"}]]) {
        await assert.rejects(receipt.projectCanonicalSubscriptionReceipt({db,job,fact}),{code:"NOTIFICATION_FACT_SCOPE_MISMATCH"});
      }
      assert.equal(await db.creatorSubscriptionLedger.count({where:{eventHash:"i6-shared"}}),1);
    });
    await check("I6 standalone projection respects creator retirement",async()=>{
      await assert.rejects(receipt.projectCanonicalSubscriptionReceipt({db,job:{agencyId:other.agency.id,creatorId:other.creator.id},fact:{...baseFact,eventHash:"i6-retired"}}),{code:"NOTIFICATION_PROJECTION_SCOPE_RETIRED"});
      assert.equal(await db.creatorSubscriptionLedger.count({where:{eventHash:"i6-retired"}}),0);
    });
    await check("I6 raw conflict retries whole receipt root and commits money once",async()=>{
      let attempts=0; const proxy={$transaction:(fn,options)=>db.$transaction(async tx=>{
        const result=await fn(tx);if(++attempts===1)await tx.$executeRawUnsafe("DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='I6_RETRY'; END $$");return result;
      },options)};
      await receipt.projectCanonicalSubscriptionReceipt({db:proxy,job:jobScope,fact:{...baseFact,eventHash:"i6-retry"}});
      assert.equal(attempts,2);assert.equal(await db.creatorSubscriptionLedger.count({where:{eventHash:"i6-retry"}}),1);
    });
    await check("I6 actual Traffic reader and cost API ignore poisoned historical daily cache",async()=>{
      const traffic=require("../../src/services/traffic-service");
      const old=await db.trafficDailyAggregate.create({data:{agencyId:s.agency.id,creatorId:s.creator.id,sourceId:source.id,day:new Date("2026-01-01"),paidSubs:9999,grossCents:9999999,netCents:9999999,costCents:9999999}});
      const before=await traffic.getTrafficOverview({userId:s.user.id,creatorId:s.creator.id});
      assert.equal(before.totals.subscriptionRevenueCents,1200);assert.equal(before.totals.paidSubscriptions,4);
      const updated=await traffic.updateTrafficSourceCost({userId:s.user.id,creatorId:s.creator.id,sourceId:source.id,costCents:321,currency:"USD"});
      assert.equal(updated.source.costCents,321);assert.equal(updated.recompute.reason,"LEGACY_AGGREGATE_RETIRED");
      const after=await traffic.getTrafficOverview({userId:s.user.id,creatorId:s.creator.id});
      assert.equal(after.totals.subscriptionRevenueCents,1200);assert.equal(after.sources.find(x=>x.id===source.id).costCents,321);
      assert.deepEqual(await db.trafficDailyAggregate.findUnique({where:{id:old.id}}),old);
    });
    const hotCounts=[], hotSql=[];
    await check("I6 paid receipt SQL work is unchanged after twenty-thousand same-day receipts",async()=>{
      async function measure(eventHash) {
        await new Promise(resolve => setImmediate(resolve));
        const start=queries.length;await receipt.projectCanonicalSubscriptionReceipt({db,job:jobScope,fact:{...baseFact,eventHash}});
        await new Promise(resolve => setImmediate(resolve));
        const sql=queries.slice(start);hotSql.push(sql);assert.ok(!sql.some(q=>/TrafficDailyAggregate|SUM\(|COUNT\(/i.test(q)),sql.join("\n"));
        hotCounts.push(sql.length);
      }
      await measure("i6-before-growth");
      await db.$executeRawUnsafe(`INSERT INTO "CreatorSubscriptionLedger" ("id","agencyId","creatorId","accountId","fanId","sourceId","eventHash","eventType","amountCents","occurredAt","createdAt","updatedAt")
        SELECT 'i6-bulk-'||g,$1,$2,$2,'123',$3,'i6-bulk-'||g,'paid_subscribed',100,$4::timestamp,clock_timestamp(),clock_timestamp() FROM generate_series(1,20000) g`,s.agency.id,s.creator.id,source.id,at);
      await measure("i6-after-growth");
      if (process.env.PHASE5_PROOF_OUTPUT) fs.writeFileSync(process.env.PHASE5_PROOF_OUTPUT+".statements.json",JSON.stringify(hotSql,null,2));
      assert.equal(hotCounts[0],hotCounts[1]);
    });

    await check("I7 independent repair generation rechecks old subscriptions and reconstructs the post-V1 tail", async () => {
      const scope = await seed(); const before = new Date(Date.now()-86400000), after = new Date();
      const fp = crypto.createHash("sha256").update("i7-old-invalid-refund").digest("hex");
      await db.creatorSubscriptionEvent.create({ data: { agencyId: scope.agency.id, creatorId: scope.creator.id,
        fanOnlyFansUserIdAtEvent: "123", eventFingerprint: fp, eventType: "REFUNDED", observedPriceCents: 500, occurredAt: before, createdAt: before } });
      await db.creatorSubscriptionLedger.create({ data: { agencyId: scope.agency.id, creatorId: scope.creator.id,
        accountId: scope.creator.id, fanId: "123", eventHash: fp, eventType: "subscription_refunded", source: "canonical_subscription_fact", amountCents: 500, occurredAt: before } });
      await db.creatorSubscriptionEvent.create({ data: { agencyId: scope.agency.id, creatorId: scope.creator.id,
        fanOnlyFansUserIdAtEvent: "123", eventFingerprint: crypto.createHash("sha256").update("i7-new-paid").digest("hex"),
        eventType: "SUBSCRIBED_PAID", observedPriceCents: 700, occurredAt: after, createdAt: after } });
      await db.maintenanceLaneState.update({ where: { key: history.RECEIPT_KEY }, data: { completedAt: null,
        cursor: { afterId: "", upperId: scope.creator.id, cutoffAt: new Date(Date.now()+1000).toISOString(), tailFrom: new Date(before.getTime()+1000).toISOString() } } });
      // V1 completion survives intact: no revision/cursor reset of old work.
      const old = await db.domainWorkItem.findMany({ where: { workClass: history.WORK_CLASS } });
      for (let i=0;i<10;i++) if ((await history.enumerateHistoryCreators({ db, receiptRepair: true })).complete) break;
      assert.deepEqual(await db.domainWorkItem.findMany({ where: { workClass: history.WORK_CLASS } }), old);
      for (let i=0;i<3;i++) {
        const c = await work.claimDomainWorkBatch({ db, workClass: history.RECEIPT_WORK_CLASS, agencyId: scope.agency.id, limit: 1 });
        assert.equal(c.items.length, 1); await history.processHistoryPage({ db, item: c.items[0], ownerToken: c.ownerToken });
      }
      const ledger = await db.creatorSubscriptionLedger.findMany({ where: { creatorId: scope.creator.id } });
      assert.equal(ledger.length, 1); assert.equal(ledger[0].amountCents, 700);
      const done = await db.domainWorkItem.findFirst({ where: { creatorId: scope.creator.id, workClass: history.RECEIPT_WORK_CLASS } });
      assert.equal(done.state, "DONE"); assert.equal(done.lastRepair.generation, history.RECEIPT_KEY);
      assert.equal(await db.creatorNotificationSyncState.count({ where: { creatorId: scope.creator.id } }), 0);
    });
    const report = { ok: true, engine: "Prisma 5.22 / PGlite PostgreSQL WASM TCP", migrations: fs.readdirSync(path.join(root,"prisma/migrations")).filter(n=>fs.existsSync(path.join(root,"prisma/migrations",n,"migration.sql"))).length, cases: cases.length, results: cases, plans, receiptSqlStatementCounts: hotCounts, receiptSqlStatements: hotSql,
      limits: ["Single physical SQL client, not native contention or multi-replica load", "60000 interleaved two-agency facts validate SELECT plans only; USER triggers disabled solely while loading this synthetic fixture, FK and CHECK constraints retained; not ingestion throughput", "Unused daily aggregate writer retired; Traffic read-side grouping and attribution repair scale remain open", "Recovered retained canonical facts only; deleted facts and missing identities cannot be reconstructed"] };
    if (process.env.PHASE5_PROOF_OUTPUT) fs.writeFileSync(process.env.PHASE5_PROOF_OUTPUT, JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({ ok: true, cases: cases.length, plans: plans.length }));
  } finally { await db.$disconnect(); await server.stop(); await engine.close(); }
}
const watchdog = setTimeout(() => { console.error("I5_PROOF_DEADLINE_EXCEEDED"); process.exit(1); },180000);
main().then(() => clearTimeout(watchdog), error => { clearTimeout(watchdog); console.error(error); process.exitCode=1; });
