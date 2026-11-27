"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_done, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out: " + label)), 6000);
    })]);
  } finally { clearTimeout(timer); }
}
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));

// Instrument timing only, immediately after the real database grants a lock.
// The production root, isolation, admission, permissions and SQL are unchanged.
function gateDatabase(db, predicate) {
  const reached = deferred(), release = deferred();
  let held = false;
  const client = new Proxy(db, { get(target, key) {
    if (key === "$transaction") return (callback, options) => target.$transaction(tx => callback(new Proxy(tx, { get(t, k) {
      if (["$queryRawUnsafe", "$executeRawUnsafe"].includes(k)) return async (sql, ...args) => {
        const result = await t[k](sql, ...args);
        if (!held && predicate(sql, args)) { held = true; reached.resolve(); await release.promise; }
        return result;
      };
      const value = t[k]; return typeof value === "function" ? value.bind(t) : value;
    } })), options);
    const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
  } });
  return { db: client, reached, release };
}
async function waitForGate(gate, result) {
  try {
    await bounded(Promise.race([gate.reached.promise, result.then(value => {
      throw new Error("Owner ended before the lock gate: " + (value.error?.message || "completed"));
    })]), "first owner lock gate");
  } catch (error) { gate.release.resolve(); await result; throw error; }
}
async function waitForAutomation(db, scope) {
  for (let turn = 0; turn < 100; turn++) {
    const rows = await db.$queryRawUnsafe(`SELECT count(*)::integer AS n FROM pg_locks
      WHERE locktype='advisory' AND NOT granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND objid::bigint=(hashtext($1)::bigint & 4294967295)`, JSON.stringify([scope.agencyId, scope.creatorId]));
    if (rows[0].n) return;
    await delay(10);
  }
  assert.fail("The second owner did not wait at the shared automation prefix");
}

exports.runAnalyticsRefreshOverlapCases = async function runAnalyticsRefreshOverlapCases({ h, check }) {
  const { db } = h;
  const work = h.load("./src/services/domain-work-authority-service");
  const recurring = h.load("./src/services/analytics-recurring-planning-service");
  const orchestrator = h.load("./src/services/creator-analytics-sync-orchestrator");
  const operation = h.load("./src/services/operational-command-service");
  const management = h.load("./src/services/management-command-service");
  const runCommand = (client, scope, payload) => management.executeManagementCommand({ db: client,
    agencyId: scope.agencyId, userId: scope.userId, actorMember: scope.member, deviceId: scope.deviceId,
    input: { commandId: randomUUID(), action: "operation.control", targetId: scope.creatorId, payload } });
  const command = async (scope, family) => {
    const payload = { family, operation: family === "subscriber" ? "start" : "refresh",
      input: family === "subscriber" ? { force: true, manual: true } : { rangeKey: "7d" } };
    payload.expectedRevision = await operation.snapshot(db, scope.agencyId, scope.creatorId, payload);
    return payload;
  };
  for (const first of ["recurring", "refresh"]) await check(`real durable recurring and refresh serialize with ${first} first`, async () => {
    const s = await h.scope("compound_" + first);
    await h.write(tx => work.publishDomainWork({ db: tx, agencyId: s.agencyId, creatorId: s.creatorId,
      workClass: "CREATOR_RECURRING_PLANNING", objectType: "CreatorAccount", objectId: s.creatorId, partitionKey: s.creatorId }));
    const claimed = await work.claimDomainWorkBatch({ db, agencyId: s.agencyId, creatorIds: [s.creatorId],
      objectIds: [s.creatorId], workClass: "CREATOR_RECURRING_PLANNING", limit: 1, leaseMs: 60000 });
    assert.equal(claimed.items.length, 1);
    const gate = gateDatabase(db, (_sql, args) => args[0] === "onlinod:automation-creator-commit:v1"
      && args[1] === JSON.stringify([s.agencyId, s.creatorId]));
    const runRecurring = client => recurring.planRecurringCreatorAnalytics({ db: client, item: claimed.items[0], ownerToken: claimed.ownerToken });
    const runRefresh = client => orchestrator.refreshCreatorAnalytics({ db: client, agencyId: s.agencyId,
      creatorId: s.creatorId, requestedByUserId: s.userId, rangeKey: "7d" });
    const a = settle((first === "recurring" ? runRecurring : runRefresh)(gate.db));
    await waitForGate(gate, a);
    const b = settle((first === "recurring" ? runRefresh : runRecurring)(db));
    let observationError;
    try { await waitForAutomation(db, s); } catch (error) { observationError = error; } finally { gate.release.resolve(); }
    const results = await bounded(Promise.all([a, b]), "compound recurring/refresh settlement");
    if (observationError) throw observationError;
    for (const result of results) assert.equal(result.ok, true, result.error?.message);
    const jobs = await db.jobInstance.findMany({ where: { creatorId: s.creatorId,
      jobKey: { in: ["financial_transactions_scan", "subscriber_directory_scan"] },
      status: { in: ["SCHEDULED", "CLAIMED", "PUBLISHING", "PAUSED"] } }, select: { jobKey: true } });
    assert.equal(jobs.filter(job => job.jobKey === "financial_transactions_scan").length, 1);
    assert.equal(jobs.filter(job => job.jobKey === "subscriber_directory_scan").length, 1);
  });
  await check("management refresh and Subscriber START settle without a raw database conflict or duplicate run", async () => {
    const s = await h.scope("refresh_subscriber_overlap");
    const refresh = await command(s, "analytics_refresh"), subscriber = await command(s, "subscriber");
    const gate = gateDatabase(db, (sql, args) => /SELECT "id" FROM "CreatorAccount".*FOR (?:(?:NO KEY )?UPDATE|SHARE)/.test(sql)
      && args[0] === s.creatorId);
    const a = settle(runCommand(gate.db, s, refresh));
    await waitForGate(gate, a);
    const b = settle(runCommand(db, s, subscriber));
    let observationError;
    try { await waitForAutomation(db, s); } catch (error) { observationError = error; } finally { gate.release.resolve(); }
    const [refreshed, started] = await bounded(Promise.all([a, b]), "refresh/subscriber settlement");
    if (observationError) throw observationError;
    assert.equal(refreshed.ok, true, refreshed.error?.message);
    if (!started.ok) {
      assert.equal(started.error.code, "OPERATION_VERSION_CONFLICT", started.error.message);
      assert.equal(started.error.status, 409);
    }
    assert.equal(await db.subscriberScanRun.count({ where: { creatorId: s.creatorId } }), 1);
    assert.equal(await db.jobInstance.count({ where: { creatorId: s.creatorId, jobKey: "financial_transactions_scan" } }), 1);
  });
  await check("refresh retains compatibility with an existing SFS Creator SHARE owner", async () => {
    const s = await h.scope("financial_shared_creator"), payload = await command(s, "analytics_refresh");
    const gate = gateDatabase(db, (sql, args) => /FROM "CreatorAccount".*FOR SHARE/.test(sql) && args[0] === s.creatorId);
    const otherOwner = settle(h.load("./src/services/db-commit-kernel").runRootCommit(gate.db, ({ tx }) =>
      h.load("./src/services/sfs-mutation-authority-service").lockSfsScope(tx, { agencyId: s.agencyId, creatorId: s.creatorId })));
    await waitForGate(gate, otherOwner);
    let commandError;
    try {
      const result = await bounded(runCommand(db, s, payload), "refresh against compatible Creator SHARE");
      assert.equal(result.ok, true);
    } catch (error) { commandError = error; } finally { gate.release.resolve(); }
    const other = await bounded(otherOwner, "SFS scope settlement");
    if (commandError) throw commandError;
    assert.equal(other.ok, true, other.error?.message);
  });
};
