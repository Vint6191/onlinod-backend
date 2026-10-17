"use strict";
// Independent boundary and lock-order checks. The lock model is NOT a native
// PostgreSQL concurrency result; it explores row/advisory lock traces collected
// while executing the real domain services against SQL.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const { runRootCommit } = require(root + "/src/services/db-commit-kernel");
const checks = [], failures = [], evidence = {};
async function check(name, fn) {
  try { await fn(); checks.push(name); console.log("PASS", name); }
  catch (error) { failures.push({ name, error: String(error.message) }); console.error("FAIL", name, error.message); }
}
function traceClient(db, trace) {
  const observe = (sql, args) => {
    if (/pg_(try_)?advisory_xact_lock/.test(sql) && args.some(x => String(x).startsWith("live-earnings:"))) trace.push("money");
    else if (/INSERT INTO "CreatorMoneyObservation"|UPDATE "CreatorMoneyObservation" SET "resolutionBlockedAt"/.test(sql)) trace.push("observation");
    else if (/INSERT INTO "CreatorMoneyResolutionRequest"|SELECT \* FROM "CreatorMoneyResolutionRequest".*FOR UPDATE/.test(sql)) trace.push("request");
  };
  return new Proxy(db, { get(target, prop) {
    if (prop !== "$transaction") return Reflect.get(target, prop);
    return (fn, options) => target.$transaction(tx => fn(new Proxy(tx, { get(inner, key) {
      const value = Reflect.get(inner, key);
      if (!["$executeRawUnsafe", "$queryRawUnsafe"].includes(key)) return value;
      return (sql, ...args) => { observe(sql, args); return value.call(inner, sql, ...args); };
    }})), options);
  }});
}
// Explore all schedules for exclusive transaction-duration locks. Lock re-entry
// is permitted; successful completion releases all of that transaction's locks.
function deadlockSchedule(flows) {
  const seen = new Set();
  function visit(at, owners, route) {
    const signature = JSON.stringify([at, owners]);
    if (seen.has(signature)) return null;
    seen.add(signature);
    if (at.every(x => x === -1)) return null;
    let movable = false;
    for (let t = 0; t < flows.length; t++) {
      if (at[t] < 0) continue;
      const lock = flows[t][at[t]], next = [...at], held = { ...owners };
      if (lock === undefined) {
        movable = true; next[t] = -1;
        for (const key of Object.keys(held)) if (held[key] === t) delete held[key];
      } else if (held[lock] === undefined || held[lock] === t) {
        movable = true; next[t]++; held[lock] = t;
      } else continue;
      const found = visit(next, held, [...route, { transaction: t, acquire: lock || "COMMIT" }]);
      if (found) return found;
    }
    return movable ? null : route;
  }
  return visit(flows.map(() => 0), {}, []);
}

(async () => {
  const f = await createScaleSqlRuntime();
  try {
    const { db } = f;
    require.cache[require.resolve(root + "/src/prisma")] = { exports: db };
    const money = require(root + "/src/services/live-earnings-projection-service");
    const fin = require(root + "/src/services/financial-transactions-service");
    const gen = require(root + "/src/services/earnings-generation-service");
    const resolver = require(root + "/src/services/money-resolution-service");
    const work = require(root + "/src/services/domain-work-authority-service");
    const s = await scope(db), now = new Date(), at = new Date(+now - 20000);
    const tx = fn => runRootCommit(db, ({ tx }) => fn(tx));
    const event = (id, type = "tip", overrides = {}) => ({
      eventType: "notification_source_observed",
      notificationObservation: { identityKey: "notification:" + id, category: "tips", occurredAt: at.toISOString(), amountCents: 1000 },
      moneyObservation: { version: 1, transactionId: id, transactionType: type, currency: "USD", status: "done", amountCents: 1000, netCents: 800, feeCents: 200, occurredAt: at.toISOString(), revisionAt: at.toISOString(), ...overrides },
    });
    const ingest = (events, client = db) => runRootCommit(client, ({ tx }) => money.ingestLive({ db: tx, ...s, events, capturedAt: at, now }));
    await tx(async t => {
      await gen.lock(t, s.creatorId);
      await t.creatorEarningsGeneration.create({ data: { id: "base", agencyId: s.agencyId, creatorId: s.creatorId, runId: "base", state: "ACTIVE", phase: "READY", fromAt: new Date(+at - 86400000), throughAt: at, snapshotAt: at, fullScan: true, publishedAt: at } });
      await t.creatorEarningsLedgerProof.create({ data: { agencyId: s.agencyId, creatorId: s.creatorId, generation: "base", activeGeneration: "base", fromAt: new Date(+at - 86400000), throughAt: at } });
    });
    await check("blank transaction type cannot poison delivery of a valid sibling payment", async () => {
      const result = await ingest([event("blank-type", "  "), event("valid-sibling", "tip")]);
      assert.equal(result.applied, 1); assert.equal(result.pending, 1);
      assert.equal(Number((await gen.activeEntry(db, s.creatorId, "valid-sibling")).netCents), 800);
      assert.equal(await gen.activeEntry(db, s.creatorId, "blank-type"), null);
    });
    await check("live and financial scan assign identical categories to normalized provider transaction types", async () => {
      const cases = [[" TIP ", "tips"], ["Subscriptions", "subscriptions"], ["subscription_renewal", "subscriptions"], ["subscribe_recurring", "subscriptions"], ["MESSAGE", "messages"], ["post", "posts"], ["stream", "streams"], ["unknown_event", "other"]];
      const discrepancies = [];
      for (const [i, [type, expected]] of cases.entries()) {
        const e = event("category-" + i, type); await ingest([e]);
        const row = fin.normalizeTransaction(e.moneyObservation, 0, 1);
        assert(!row.rejected);
        const scanCategory = row.factType === "TIP" ? "tips" : row.factType === "PAID_SUBSCRIPTION" ? "subscriptions" : ({ message: "messages", post: "posts", stream: "streams" }[row.transactionType] || "other");
        assert.equal(scanCategory, expected);
        const actual = (await gen.activeEntry(db, s.creatorId, e.moneyObservation.transactionId)).category;
        if (actual !== expected) discrepancies.push({ type, expected, actual });
      }
      evidence.categoryDiscrepancies = discrepancies;
      assert.deepEqual(discrepancies, []);
    });
    await check("duplicate pending delivery and cancelled resolution have no cyclic lock acquisition schedule", async () => {
      const pending = event("pending-lock", "tip", { netCents: null }); await ingest([pending]);
      const deliveryTrace = []; await ingest([pending], traceClient(db, deliveryTrace));
      const target = await db.creatorMoneyObservation.findFirst({ where: { creatorId: s.creatorId, transactionId: "pending-lock" } });
      // Isolate this oldest target so earlier boundary-check debt cannot change
      // the resolver branch whose real lock acquisition is being examined.
      await tx(async t => {
        await gen.lock(t, s.creatorId);
        await t.creatorMoneyObservation.updateMany({ where: { creatorId: s.creatorId, id: { not: target.id }, status: "PENDING" }, data: { resolutionBlockedAt: now, resolutionError: "FIXTURE_OTHER_TARGET" } });
        await t.jobInstance.create({ data: { id: "cancelled-resolution", agencyId: s.agencyId, creatorId: s.creatorId, jobKey: "financial_transactions_scan", scope: "creator", status: "CANCELLED" } });
        await t.creatorMoneyResolutionRequest.update({ where: { creatorId: s.creatorId }, data: { targetId: target.id, jobId: "cancelled-resolution", attempts: 1 } });
        await t.domainWorkItem.updateMany({ where: { creatorId: s.creatorId, workClass: "MONEY_RESOLUTION" }, data: { availableAt: new Date(0) } });
      });
      const claim = await work.claimDomainWorkBatch({ db, workClass: "MONEY_RESOLUTION", limit: 1 }); assert.equal(claim.items.length, 1);
      const resolutionTrace = [];
      const result = await resolver.processRequest({ db: traceClient(db, resolutionTrace), item: claim.items[0], ownerToken: claim.ownerToken });
      assert.equal(result.reason, "RESOLUTION_REVIEW_REQUIRED");
      const schedule = deadlockSchedule([deliveryTrace, resolutionTrace]);
      evidence.lockOrder = { deliveryTrace, resolutionTrace, model: "exclusive transaction-duration locks from executed SQL; not native PostgreSQL", deadlockSchedule: schedule };
      assert.equal(schedule, null, "Cyclic schedule: " + JSON.stringify(schedule));
    });
    await check("busy monetary owner yields resolution without creating a job or losing the request", async () => {
      const pending = event("busy-money", "tip", { netCents: null }); await ingest([pending]);
      await db.domainWorkItem.updateMany({ where: { creatorId: s.creatorId, workClass: "MONEY_RESOLUTION" }, data: { availableAt: new Date(0) } });
      const claim = await work.claimDomainWorkBatch({ db, workClass: "MONEY_RESOLUTION", limit: 1 }); assert.equal(claim.items.length, 1);
      const before = await db.jobInstance.count({ where: { creatorId: s.creatorId } });
      let client = db, release = null, held = null;
      if (f.native) {
        let acquired; const ready = new Promise(r => { acquired = r; }), wait = new Promise(r => { release = r; });
        held = tx(async t => { await gen.lock(t, s.creatorId); acquired(); await wait; }); await ready;
      } else {
        // The actual lock-contention result is injected only on single-connection
        // PGlite. Queue ownership, yield and SQL rollback remain real.
        client = new Proxy(db, { get(target, key) {
          if (key !== "$transaction") return Reflect.get(target, key);
          return (fn, opts) => target.$transaction(t => fn(new Proxy(t, { get(inner, prop) {
            if (prop !== "$queryRawUnsafe") return Reflect.get(inner, prop);
            return (sql, ...args) => /pg_try_advisory_xact_lock\(hashtextextended/.test(sql) ? Promise.resolve([{ owned: false }]) : inner.$queryRawUnsafe(sql, ...args);
          }})), opts);
        }});
      }
      let result;
      try { result = await resolver.processRequest({ db: client, item: claim.items[0], ownerToken: claim.ownerToken }); }
      finally { if (release) release(); if (held) await held; }
      assert.equal(result.reason, "MONEY_BUSY");
      assert.equal(await db.jobInstance.count({ where: { creatorId: s.creatorId } }), before);
      const item = await db.domainWorkItem.findUnique({ where: { id: claim.items[0].id } });
      assert.equal(item.state, "READY"); assert(item.isOutstanding);
      assert((await db.creatorMoneyResolutionRequest.findUnique({ where: { creatorId: s.creatorId } })).queued);
      evidence.busyOwner = f.native ? "held native PostgreSQL lock on an independent connection" : "injected busy result, actual SQL ownership/yield; native blocking untested";
      // Retire only this fixture's debt to isolate the multi-agency admission run.
      await tx(async t => { await gen.lock(t, s.creatorId); await t.creatorMoneyObservation.updateMany({ where: { creatorId: s.creatorId, status: "PENDING" }, data: { resolutionBlockedAt: now, resolutionError: "FIXTURE_DONE" } }); });
      await db.domainWorkItem.update({ where: { id: item.id }, data: { availableAt: new Date(0) } });
      const clear = await work.claimDomainWorkBatch({ db, workClass: "MONEY_RESOLUTION", limit: 1 });
      assert((await resolver.processRequest({ db, item: clear.items[0], ownerToken: clear.ownerToken })).idle);
    });
    await check("multi-agency debt coalesces and admits fairly while healthy creators produce no financial work", async () => {
      const fleet = [], controls = [];
      for (let agency = 0; agency < 8; agency++) {
        const base = await scope(db, { agencyId: "fair-agency-" + agency, creatorId: "fair-creator-" + agency + "-0", userId: "fair-user-" + agency });
        for (let model = 0; model < 4; model++) {
          const sc = { ...base, creatorId: "fair-creator-" + agency + "-" + model };
          await tx(async t => {
            if (model) {
              await t.$executeRawUnsafe("SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)");
              await t.creatorAccount.create({ data: { id: sc.creatorId, agencyId: sc.agencyId, displayName: "Fixture", remoteId: sc.creatorId, status: "READY" } });
            }
            await gen.lock(t, sc.creatorId);
            await t.creatorEarningsGeneration.create({ data: { id: "g-" + sc.creatorId, agencyId: sc.agencyId, creatorId: sc.creatorId, runId: "baseline", state: "ACTIVE", phase: "READY", fromAt: new Date(+at - 86400000), throughAt: at, snapshotAt: at, fullScan: true, publishedAt: at } });
            await t.creatorEarningsLedgerProof.create({ data: { agencyId: sc.agencyId, creatorId: sc.creatorId, generation: "baseline", activeGeneration: "g-" + sc.creatorId, fromAt: new Date(+at - 86400000), throughAt: at } });
            if (model < 3) await money.ingestLive({ db: t, ...sc, events: [event("fair-payment", "tip", { netCents: null })], capturedAt: at, now });
          });
          (model < 3 ? fleet : controls).push(sc);
        }
      }
      const ids = fleet.map(x => x.creatorId), healthyIds = controls.map(x => x.creatorId);
      const before = await db.domainWorkItem.findMany({ where: { creatorId: { in: ids }, workClass: "MONEY_RESOLUTION" }, orderBy: { id: "asc" }, select: { id: true, requestedRevision: true } });
      assert.equal(before.length, 24);
      for (const sc of fleet) await tx(t => money.ingestLive({ db: t, ...sc, events: [event("fair-payment", "tip", { netCents: null })], capturedAt: at, now }));
      assert.deepEqual(await db.domainWorkItem.findMany({ where: { creatorId: { in: ids }, workClass: "MONEY_RESOLUTION" }, orderBy: { id: "asc" }, select: { id: true, requestedRevision: true } }), before);
      await db.domainWorkItem.updateMany({ where: { id: { in: before.map(x => x.id) } }, data: { availableAt: new Date(0) } });
      const admitted = new Set(), batches = [];
      while (admitted.size < 24 && batches.length < 24) {
        const batch = await work.claimDomainWorkBatch({ db, workClass: "MONEY_RESOLUTION", limit: 8, perAgencyQuantum: 2, perPartitionQuantum: 1 });
        assert(batch.items.length > 0);
        const distribution = {};
        for (const item of batch.items) {
          assert(!admitted.has(item.creatorId)); admitted.add(item.creatorId);
          distribution[item.agencyId] = (distribution[item.agencyId] || 0) + 1;
          assert((await resolver.processRequest({ db, item, ownerToken: batch.ownerToken })).created);
        }
        assert(Object.values(distribution).every(n => n <= 2));
        batches.push(distribution);
      }
      assert.equal(admitted.size, 24);
      assert.equal(await db.jobInstance.count({ where: { creatorId: { in: ids }, jobKey: "financial_transactions_scan" } }), 24);
      assert.equal(await db.jobInstance.count({ where: { creatorId: { in: healthyIds }, jobKey: "financial_transactions_scan" } }), 0);
      evidence.fairness = { agencies: 8, unresolvedCreators: 24, healthyCreators: 8, sourceJobs: 24, replayAddedWork: 0, batches };
    });
    const result = { ok: failures.length === 0, engine: f.native ? "native PostgreSQL SQL; lock-order model" : "PGlite SQL + exhaustive lock-order model; native concurrency not executed", checks, failures, evidence };
    if (process.env.ONLINOD_ADVERSARIAL_REPORT) fs.writeFileSync(process.env.ONLINOD_ADVERSARIAL_REPORT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
