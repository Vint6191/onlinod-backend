"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";

test("A36 PostgreSQL: Analytics expiry fences progress and settlement while restart preserves the unfinished cycle", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const planner = require("./analytics-collection-planner");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const key = nonce("a36-analytics-lease");
  const demandKey = `${key}-demand`;
  let actor = null;
  try {
    actor = await createPhase3PostgresActorFixture(dbA, key);
    const [{ authorityNow }] = await dbA.$queryRawUnsafe('SELECT clock_timestamp() AS "authorityNow"');
    const past = new Date(authorityNow.getTime() - 1000);
    const originalTime = new Date(authorityNow.getTime() - 2 * 60 * 60 * 1000);
    const originalCycle = planner.sweepCycleKey(originalTime);
    await dbA.analyticsCollectionLease.create({ data: {
      key, ownerToken: "expired-owner", cycleKey: originalCycle, cycleNow: originalTime,
      cursorCreatorId: "completed-creator-500", leaseUntil: past,
    } });
    const stale = { db: dbA, leaseKey: key, ownerToken: "expired-owner", cycleKey: originalCycle, cursorCreatorId: "must-not-commit" };
    assert.equal(await planner.renewAnalyticsSweepLease(stale), false);
    assert.equal(await planner.completeAnalyticsSweepCycle(stale), false);
    const recovered = await planner.claimAnalyticsSweepCycle({ db: dbB, leaseKey: key, coordinationLockKey: key, ownerToken: "replacement" });
    assert.equal(recovered.reason, "previous_cycle_recovered");
    assert.equal(recovered.cursorCreatorId, "completed-creator-500");
    assert.equal(recovered.cycleKey, originalCycle);
    assert.equal(recovered.cycleNow.getTime(), originalTime.getTime());
    assert.equal(await planner.completeAnalyticsSweepCycle(stale), false);
    assert.equal(await planner.completeAnalyticsSweepCycle({ db: dbB, leaseKey: key, ...recovered }), true);

    const demandData = {
      key: demandKey, agencyId: actor.agencyId, rangeKey: "7d", coverageFrom: originalTime, coverageTo: authorityNow,
      reason: "INTERACTIVE_REFRESH", requestedByMemberId: actor.memberId, requestedAccessEpoch: actor.accessEpoch,
      requestedAt: authorityNow, requestRevision: 1, claimedRevision: 1, claimToken: "expired-demand", claimUntil: past,
    };
    // Prisma has no @relation here. Prove that the migration-owned lifecycle
    // trigger still rejects an orphan; fixing a fixture must never disable it.
    await assert.rejects(
      () => dbA.analyticsCollectionDemand.create({ data: { ...demandData, key: `${demandKey}-orphan`, agencyId: `${key}-missing-agency` } }),
      (error) => error?.code === "P2003" || error?.meta?.code === "23503",
      "an Analytics demand must not outlive its Agency identity",
    );
    const demand = await dbA.analyticsCollectionDemand.create({ data: demandData });
    const before = await dbA.analyticsCollectionDemand.findUnique({ where: { key: demandKey } });
    assert.equal(await planner.renewAnalyticsDemandLease({ db: dbA, ...demand }), false);
    for (const error of [null, Object.assign(new Error("bad range"), { code: "ANALYTICS_DEMAND_RANGE_INVALID" })]) {
      assert.deepEqual(await planner.settleAnalyticsDemand({ db: dbA, demand, error }), { settled: false, reason: "claim_lost" });
    }
    assert.deepEqual(await dbA.analyticsCollectionDemand.findUnique({ where: { key: demandKey } }), before);
    const [{ authorityNow: takeoverNow }] = await dbB.$queryRawUnsafe('SELECT clock_timestamp() AS "authorityNow"');
    const replacement = await dbB.analyticsCollectionDemand.update({ where: { key: demandKey }, data: {
      claimToken: "replacement-demand", claimUntil: new Date(takeoverNow.getTime() + planner.DEMAND_LEASE_MS),
    } });
    assert.equal((await planner.settleAnalyticsDemand({ db: dbA, demand })).settled, false);
    assert.equal((await planner.settleAnalyticsDemand({ db: dbB, demand: replacement })).completed, true);
    console.log("# A36_ANALYTICS_COORDINATOR_EXPIRY_CONTINUITY_PASS");
  } finally {
    try {
      try {
        await dbA.analyticsCollectionDemand.deleteMany({ where: { key: { in: [demandKey, `${demandKey}-orphan`] } } });
      } finally {
        try {
          await dbA.analyticsCollectionLease.deleteMany({ where: { key } });
        } finally {
          if (actor) await cleanupPhase3PostgresFixtureGraph(dbA, { agencyId: actor.agencyId, userIds: [actor.userId] });
        }
      }
    } finally {
      await Promise.allSettled([dbA.$disconnect(), dbB.$disconnect()]);
    }
  }
});
const {
  pinPhase3AuditSchema,
  withPhase3PostgresFixtureAuthority,
  createPhase3PostgresActorFixture,
  cleanupPhase3PostgresAgencyFixture,
  cleanupPhase3PostgresFixtureGraph,
} = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");
const { runPhase3InterleavedTransactions } = require("../../scripts/test-support/phase3-interleaved-transactions");
const { waitForPhase3PostgresBlock, waitUntilPhase3DatabaseTime } = require("../../scripts/test-support/phase3-postgres-lock-wait");
const {
  TOPOLOGY_ID: DOMAIN_WORK_CLAIM_TOPOLOGY_ID,
  activateTopology: activateDomainWorkClaimTopology,
} = require("../../scripts/database/phase3-domain-work-claim-online-rollout");
const release = require("./phase2-release-compatibility-authority-service");

test("A37-R5 PostgreSQL: member reservations reject stale shard revisions and preserve dispatch time", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const { reserveMemberScopeCreatorProbe, DOMAIN_WORK_GENERATION } = require("./domain-work-authority-service");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const observer = new PrismaClient();
  let actor;
  try {
    const prefix = nonce("a37-member-reservation");
    actor = await createPhase3PostgresActorFixture(dbA, prefix);
    const candidates = await dbA.$queryRawUnsafe(`
      SELECT DISTINCT ON ("phase3_domain_work_claim_shard"($1 || g::text))
             $1 || g::text AS "creatorId", "phase3_domain_work_claim_shard"($1 || g::text) AS shard
        FROM generate_series(1,2048) g
       ORDER BY "phase3_domain_work_claim_shard"($1 || g::text),g LIMIT 64`, `${prefix}-creator-`);
    assert.equal(candidates.length, 64);
    const member = await withPhase3PostgresFixtureAuthority(dbA, async (tx) => {
      await tx.creatorAccount.createMany({ data: candidates.map((row) => ({
        id: row.creatorId, agencyId: actor.agencyId, displayName: row.creatorId, status: "READY",
      })) });
      return tx.agencyMember.update({ where: { id: actor.memberId }, data: {
        role: "OPERATOR", roleKey: "chatter",
        assignedCreators: { mode: "scoped", creatorIds: candidates.map((row) => row.creatorId) },
      } });
    }, { maxWait: 10_000, timeout: 30_000 });
    const authority = { ...actor, accessEpoch: Number(member.accessEpoch) };
    const shards = await dbA.domainWorkMemberScopeShardState.findMany({
      where: { memberId: actor.memberId }, orderBy: { claimShard: "asc" },
    });
    assert.equal(shards.length, 64);
    const peerShards = shards.slice(0, 32);
    const peerCreators = new Set(candidates.filter((row) => peerShards.some((s) => s.claimShard === row.shard)).map((row) => row.creatorId));
    const lockKey = `${prefix}-snapshot`;
    let holderPid;
    let waiterPid;
    let result;
    let intercepted = false;
    await runPhase3InterleavedTransactions({
      dbA, dbB,
      firstA: async (tx) => {
        [{ pid: holderPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', lockKey);
      },
      firstB: async (tx) => { [{ pid: waiterPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'); },
      secondA: async (tx) => {
        await waitForPhase3PostgresBlock({ db: observer, holderPid, waiterPid });
        await tx.$executeRawUnsafe(`UPDATE "DomainWorkMemberScopeShardState"
          SET "revision"="revision"+1,"lastSelectedAt"=clock_timestamp()
          WHERE "id"=ANY($1::text[])`, peerShards.map((row) => row.id));
      },
      secondB: async (tx) => {
        const wrapped = new Proxy(tx, { get(target, key) {
          if (key === "$queryRawUnsafe") return async (sql, ...params) => {
            if (sql.includes("WITH observed_shards AS MATERIALIZED")) {
              intercepted = true;
              const parameter = `$${params.length + 1}`;
              sql = sql.replace("), selected_shards AS MATERIALIZED (", `), paused AS MATERIALIZED (
                SELECT pg_advisory_xact_lock(hashtext(${parameter}))::text AS held FROM observed_shards LIMIT 1
              ), selected_shards AS MATERIALIZED (`).replace("FROM observed_shards o JOIN", "FROM observed_shards o CROSS JOIN paused JOIN");
              params.push(lockKey);
            }
            return target.$queryRawUnsafe(sql, ...params);
          };
          const value = target[key];
          return typeof value === "function" ? value.bind(target) : value;
        } });
        const root = new Proxy(wrapped, { get(target, key) {
          return key === "$transaction" ? (work) => work(wrapped) : target[key];
        } });
        result = await reserveMemberScopeCreatorProbe({ db: root, authority,
          workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, generation: DOMAIN_WORK_GENERATION });
      },
    });
    assert.equal(intercepted, true);
    assert.equal(result.mode, "scoped");
    assert.equal(result.creatorIds.length, 32, "stale tranche must be replaced from the fixed ring");
    assert.equal(result.creatorIds.some((id) => peerCreators.has(id)), false, "peer-reserved revisions cannot keep their old sorted positions");
    const [{ future }] = await dbA.$queryRawUnsafe("SELECT clock_timestamp() + interval '1 hour' AS future");
    await dbA.domainWorkMemberScopeShardState.updateMany({ where: { memberId: actor.memberId }, data: { lastSelectedAt: future } });
    await reserveMemberScopeCreatorProbe({ db: dbA, authority,
      workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, generation: DOMAIN_WORK_GENERATION });
    const after = await dbA.domainWorkMemberScopeShardState.findMany({ where: { memberId: actor.memberId } });
    assert.equal(after.every((row) => row.lastSelectedAt.getTime() >= future.getTime()), true);
    console.log("# A37_MEMBER_RESERVATION_STALE_REVISION_AND_MONOTONIC_PASS");
  } finally {
    try { if (actor) await cleanupPhase3PostgresFixtureGraph(dbA, { agencyId: actor.agencyId, userIds: [actor.userId] }); }
    finally { await Promise.allSettled([dbA.$disconnect(), dbB.$disconnect(), observer.$disconnect()]); }
  }
});

test("A37-R5 PostgreSQL: fixture teardown erases owned authorization history and preserves another Agency", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const actors = [];
  try {
    for (const label of ["target", "peer"]) {
      const actor = await createPhase3PostgresActorFixture(db, nonce(`a37-history-${label}`));
      actors.push(actor);
      await withPhase3PostgresFixtureAuthority(db, (tx) => tx.agencyMember.update({
        where: { id: actor.memberId }, data: { accessEpoch: { increment: 1 } },
      }));
      assert.equal(await db.agencyMemberAccessEpochBoundary.count({ where: { agencyId: actor.agencyId } }), 1);
    }
    const [target, peer] = actors;
    const peerBefore = await db.agencyMemberAccessEpochBoundary.findMany({ where: { agencyId: peer.agencyId } });
    await cleanupPhase3PostgresFixtureGraph(db, { agencyId: target.agencyId, userIds: [target.userId] });
    assert.equal(await db.agencyMemberAccessEpochBoundary.count({ where: { agencyId: target.agencyId } }), 0);
    assert.equal(await db.agency.count({ where: { id: target.agencyId } }), 0);
    assert.equal(await db.user.count({ where: { id: target.userId } }), 0);
    assert.deepEqual(await db.agencyMemberAccessEpochBoundary.findMany({ where: { agencyId: peer.agencyId } }), peerBefore);
    console.log("# A37_FIXTURE_AUTHORIZATION_HISTORY_TENANT_ISOLATION_PASS");
  } finally {
    try {
      for (const actor of actors) {
        if (await db.agency.findUnique({ where: { id: actor.agencyId } })) {
          await cleanupPhase3PostgresFixtureGraph(db, { agencyId: actor.agencyId, userIds: [actor.userId] });
        }
      }
    } finally { await db.$disconnect(); }
  }
});

let setHiddenOnlineStatus;
let publishDomainWork;
let claimDomainWorkBatch;
let yieldDomainWorkClaim;
let WORK_CLASS;

if (enabled) {
  ({ setHiddenOnlineStatus } = require("./subscriber-directory-service"));
  ({ publishDomainWork, claimDomainWorkBatch, yieldDomainWorkClaim, WORK_CLASS } = require("./domain-work-authority-service"));
}

function nonce(prefix) {
  return `${prefix}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

test("A36 PostgreSQL: Analytics renew and settlement reject leases that expire during an observed row-lock wait", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const planner = require("./analytics-collection-planner");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const observer = new PrismaClient();
  const key = nonce("a36-analytics-lock-wait");
  const demandKey = `${key}-demand`;
  let actor = null;
  try {
    actor = await createPhase3PostgresActorFixture(dbA, key);
    const [{ authorityNow }] = await dbA.$queryRawUnsafe('SELECT clock_timestamp() AS "authorityNow"');
    const cycleKey = planner.sweepCycleKey(authorityNow);
    await dbA.analyticsCollectionLease.create({ data: {
      key, ownerToken: "waiting-owner", cycleKey, cycleNow: authorityNow, leaseUntil: authorityNow,
    } });
    await dbA.analyticsCollectionDemand.create({ data: {
      key: demandKey, agencyId: actor.agencyId, rangeKey: "7d", coverageFrom: authorityNow, coverageTo: authorityNow,
      reason: "INTERACTIVE_REFRESH", requestedByMemberId: actor.memberId, requestedAccessEpoch: actor.accessEpoch,
      requestedAt: authorityNow, claimedRevision: 1, claimToken: "waiting-owner", claimUntil: authorityNow,
    } });
    for (const operation of ["sweep-renew", "sweep-complete", "demand-renew", "demand-settle"]) {
      let holderPid;
      let waiterPid;
      let outcome;
      if (operation.startsWith("sweep-")) {
        await dbA.$executeRawUnsafe('UPDATE "AnalyticsCollectionLease" SET "leaseUntil" = clock_timestamp() + interval \'1 minute\' WHERE "key"=$1', key);
      } else {
        await dbA.$executeRawUnsafe('UPDATE "AnalyticsCollectionDemand" SET "claimUntil" = clock_timestamp() + interval \'1 minute\' WHERE "key"=$1', demandKey);
      }
      await runPhase3InterleavedTransactions({
        dbA, dbB,
        firstA: async (tx) => {
          [{ pid: holderPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
          if (operation.startsWith("sweep-")) {
            await tx.$queryRawUnsafe('SELECT "key" FROM "AnalyticsCollectionLease" WHERE "key"=$1 FOR UPDATE', key);
          } else {
            await tx.$queryRawUnsafe('SELECT "key" FROM "AnalyticsCollectionDemand" WHERE "key"=$1 FOR UPDATE', demandKey);
          }
        },
        firstB: async (tx) => { [{ pid: waiterPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'); },
        secondA: async (tx) => {
          await waitForPhase3PostgresBlock({ db: observer, holderPid, waiterPid });
          // Arm expiry only AFTER PostgreSQL proves the wait. Any clock sampled
          // before the blocked lock is older than this deadline. This does not
          // depend on two clients getting scheduled within an arbitrary interval.
          const rows = operation.startsWith("sweep-")
            ? await tx.$queryRawUnsafe('UPDATE "AnalyticsCollectionLease" SET "leaseUntil" = clock_timestamp() + interval \'100 milliseconds\' WHERE "key"=$1 RETURNING "leaseUntil" AS deadline', key)
            : await tx.$queryRawUnsafe('UPDATE "AnalyticsCollectionDemand" SET "claimUntil" = clock_timestamp() + interval \'100 milliseconds\' WHERE "key"=$1 RETURNING "claimUntil" AS deadline', demandKey);
          await waitUntilPhase3DatabaseTime(tx, rows[0].deadline);
        },
        secondB: async (tx) => {
          const claim = { db: tx, leaseKey: key, ownerToken: "waiting-owner", cycleKey, cursorCreatorId: "must-not-commit" };
          if (operation === "sweep-renew") outcome = await planner.renewAnalyticsSweepLease(claim);
          if (operation === "sweep-complete") outcome = await planner.completeAnalyticsSweepCycle(claim);
          if (operation === "demand-renew") outcome = await planner.renewAnalyticsDemandLease({ db: tx, key: demandKey, claimToken: "waiting-owner", claimedRevision: 1, cursorCreatorId: "must-not-commit" });
          if (operation === "demand-settle") outcome = (await planner.settleAnalyticsDemand({ db: tx, demand: { key: demandKey, claimToken: "waiting-owner", claimedRevision: 1 } })).settled;
        },
      });
      assert.equal(outcome, false, `${operation} must reject expiry after waiting`);
      const lease = await dbA.analyticsCollectionLease.findUnique({ where: { key } });
      const demand = await dbA.analyticsCollectionDemand.findUnique({ where: { key: demandKey } });
      assert.equal(lease.completedAt, null);
      assert.equal(lease.cursorCreatorId, null);
      assert.equal(demand.completedAt, null);
      assert.equal(demand.cursorCreatorId, null);
      assert.equal(demand.claimToken, "waiting-owner");
    }
    console.log("# A36_ANALYTICS_OBSERVED_LOCK_WAIT_EXPIRY_PASS");
  } finally {
    try {
      try {
        await dbA.analyticsCollectionDemand.deleteMany({ where: { key: demandKey } });
      } finally {
        try {
          await dbA.analyticsCollectionLease.deleteMany({ where: { key } });
        } finally {
          if (actor) await cleanupPhase3PostgresFixtureGraph(dbA, { agencyId: actor.agencyId, userIds: [actor.userId] });
        }
      }
    } finally {
      await Promise.allSettled([dbA.$disconnect(), dbB.$disconnect(), observer.$disconnect()]);
    }
  }
});

test("A36 PostgreSQL: scoped Home demand yields durable progress and a second client finishes without planning unrequested creators", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const planner = require("./analytics-collection-planner");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const prefix = nonce("a36-home-continuation");
  let actor = null;
  try {
    actor = await createPhase3PostgresActorFixture(dbA, prefix);
    const ids = [0, 1, 2].map((index) => `${prefix}-creator-${index}`);
    await withPhase3PostgresFixtureAuthority(dbA, async (tx) => {
      await tx.creatorAccount.createMany({ data: ids.map((id) => ({ id, agencyId: actor.agencyId, displayName: id, status: "READY" })) });
    });
    const queued = await planner.enqueueAgencyAnalyticsFreshnessDemand({
      db: dbA, agencyId: actor.agencyId, requestedByMemberId: actor.memberId, requestedAccessEpoch: actor.accessEpoch,
      creatorIds: ids.slice(0, 2), rangeKey: "today", includePrevious: false,
    });
    const firstClaim = await planner.claimNextAnalyticsDemand({ db: dbA, ownerToken: `${prefix}-worker-a` });
    assert.equal(firstClaim.key, queued.key);
    const first = await planner.processAnalyticsDemand({ db: dbA, demand: firstClaim, maxCreators: 1 });
    assert.equal(first.ok, true);
    assert.equal(first.creators, 1);
    assert.equal(first.created, 1);
    assert.equal(first.settled.yielded, true);
    const pending = await dbB.analyticsCollectionDemand.findUnique({ where: { key: queued.key } });
    assert.equal(pending.completedAt, null);
    assert.equal(pending.claimToken, null);
    assert.equal(pending.claimedRevision, 1);
    assert.equal(pending.cursorCreatorId, ids[0]);
    assert.ok(pending.nextAttemptAt);
    const secondClaim = await planner.claimNextAnalyticsDemand({ db: dbB, ownerToken: `${prefix}-worker-b` });
    assert.equal(secondClaim.key, queued.key);
    assert.equal(secondClaim.cursorCreatorId, ids[0]);
    const second = await planner.processAnalyticsDemand({ db: dbB, demand: secondClaim, maxCreators: 1 });
    assert.equal(second.ok, true);
    assert.equal(second.creators, 1);
    assert.equal(second.created, 1);
    assert.equal(second.settled.completed, true);
    const jobs = await dbA.jobInstance.findMany({ where: { agencyId: actor.agencyId, jobKey: "fetch_earnings" }, orderBy: { creatorId: "asc" }, select: { creatorId: true } });
    assert.deepEqual(jobs.map((row) => row.creatorId), ids.slice(0, 2));
    const done = await dbA.analyticsCollectionDemand.findUnique({ where: { key: queued.key } });
    assert.equal(done.completedRevision, 1);
    assert.equal(done.cursorCreatorId, ids[1]);
    assert.ok(done.completedAt);
    assert.equal((await planner.settleAnalyticsDemand({ db: dbA, demand: firstClaim, yieldContinuation: true })).settled, false);
    console.log("# A36_HOME_DEMAND_DURABLE_CONTINUATION_PASS");
  } finally {
    try {
      if (actor) {
        try {
          await dbA.analyticsCollectionDemand.deleteMany({ where: { agencyId: actor.agencyId } });
        } finally {
          await cleanupPhase3PostgresFixtureGraph(dbA, { agencyId: actor.agencyId, userIds: [actor.userId] });
        }
      }
    } finally {
      await Promise.allSettled([dbA.$disconnect(), dbB.$disconnect()]);
    }
  }
});

test("A37-R3 PostgreSQL: Home planning expiry rolls back real jobs and cursor then safely retries", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const planner = require("./analytics-collection-planner");
  const { planAnalyticsDemandCreator } = require("./analytics-demand-planning-service");
  const db = new PrismaClient();
  let actor;
  try {
    const prefix = nonce("a37-home-commit");
    actor = await createPhase3PostgresActorFixture(db, prefix);
    const creator = await withPhase3PostgresFixtureAuthority(db, (tx) => tx.creatorAccount.create({ data: {
      id: `${prefix}-creator`, agencyId: actor.agencyId, displayName: prefix, status: "READY",
    } }));
    await planner.enqueueAgencyAnalyticsFreshnessDemand({ db, agencyId: actor.agencyId,
      requestedByMemberId: actor.memberId, requestedAccessEpoch: actor.accessEpoch,
      creatorIds: [creator.id], rangeKey: "today", includePrevious: false });
    const demand = await planner.claimNextAnalyticsDemand({ db, ownerToken: prefix });
    assert.equal(demand.agencyId, actor.agencyId);
    const member = await db.agencyMember.findUnique({ where: { id: actor.memberId } });
    const args = { demand, member, creator, startDay: demand.coverageFrom, endDay: demand.coverageTo, now: new Date(), coverageRows: [] };
    let inserted = 0;
    const faultDb = new Proxy(db, { get(target, key) {
      if (key !== "$transaction") return target[key];
      return (work, options) => target.$transaction((tx) => work(new Proxy(tx, { get(transaction, property) {
        if (property !== "jobInstance") return transaction[property];
        return new Proxy(transaction.jobInstance, { get(delegate, method) {
          if (method !== "createMany") return delegate[method];
          return async (input) => {
            const result = await delegate.createMany(input);
            inserted += Number(result.count);
            // Expire our own locked claim after a real insert. The final live
            // fence must roll this back, not merely reject at admission.
            await transaction.$executeRawUnsafe('UPDATE "AnalyticsCollectionDemand" SET "claimUntil"=clock_timestamp()-interval \'1 second\' WHERE "key"=$1', demand.key);
            return result;
          };
        } });
      } })), options);
    } });
    await assert.rejects(() => planAnalyticsDemandCreator({ ...args, db: faultDb }), { code: "ANALYTICS_DEMAND_PLANNING_CLAIM_LOST" });
    assert.ok(inserted > 0);
    assert.equal(await db.jobInstance.count({ where: { creatorId: creator.id } }), 0);
    assert.equal((await db.analyticsCollectionDemand.findUnique({ where: { key: demand.key } })).cursorCreatorId, null);
    await assert.rejects(() => planAnalyticsDemandCreator({ ...args, db, member: { ...member, accessEpoch: member.accessEpoch + 1 } }), { code: "MANAGEMENT_ACCESS_STALE" });
    const result = await planAnalyticsDemandCreator({ ...args, db });
    assert.ok(result.created > 0);
    assert.equal((await db.analyticsCollectionDemand.findUnique({ where: { key: demand.key } })).cursorCreatorId, creator.id);
    assert.equal(await db.jobInstance.count({ where: { creatorId: creator.id } }), result.created);
    console.log("# A37_HOME_ATOMIC_PLANNING_EXPIRY_ROLLBACK_PASS");
  } finally {
    try {
      if (actor) {
        await db.analyticsCollectionDemand.deleteMany({ where: { agencyId: actor.agencyId } });
        await cleanupPhase3PostgresFixtureGraph(db, { agencyId: actor.agencyId, userIds: [actor.userId] });
      }
    } finally { await db.$disconnect(); }
  }
});

test("A37-R4 PostgreSQL: Home waits for lifecycle access and demand authority then rejects changed eligibility", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const planner = require("./analytics-collection-planner");
  const { planAnalyticsDemandCreator } = require("./analytics-demand-planning-service");
  const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const observer = new PrismaClient();
  const cases = [
    ["agency", "Agency", "MANAGEMENT_AGENCY_RETIRED"],
    ["creator", "CreatorAccount", "MANAGEMENT_CREATOR_RETIRED"],
    ["user", "User", "MANAGEMENT_USER_DISABLED"],
    ["member", "AgencyMember", "MANAGEMENT_ACCESS_STALE"],
    ["demand", "AnalyticsCollectionDemand", "ANALYTICS_DEMAND_PLANNING_CLAIM_LOST"],
  ];
  try {
    for (const [kind, table, expectedCode] of cases) {
      const prefix = nonce(`a37-home-wait-${kind}`);
      const actor = await createPhase3PostgresActorFixture(dbA, prefix);
      const backupUser = `${prefix}-backup-user`;
      try {
        const creator = await withPhase3PostgresFixtureAuthority(dbA, async (tx) => {
          // Keep a live operational owner when the requesting user is disabled.
          await tx.user.create({ data: { id: backupUser, email: `${backupUser}@example.test`, passwordHash: "integration" } });
          await tx.agencyMember.create({ data: { id: `${prefix}-backup-member`, agencyId: actor.agencyId, userId: backupUser, role: "OWNER", roleKey: "owner" } });
          return tx.creatorAccount.create({ data: { id: `${prefix}-creator`, agencyId: actor.agencyId, displayName: prefix, status: "READY" } });
        });
        const queued = await planner.enqueueAgencyAnalyticsFreshnessDemand({ db: dbA, agencyId: actor.agencyId,
          requestedByMemberId: actor.memberId, requestedAccessEpoch: actor.accessEpoch,
          creatorIds: [creator.id], rangeKey: "today", includePrevious: false });
        const demand = await planner.claimNextAnalyticsDemand({ db: dbA, ownerToken: prefix });
        assert.equal(demand.key, queued.key);
        const member = await dbA.agencyMember.findUnique({ where: { id: actor.memberId } });
        const targetId = { agency: actor.agencyId, creator: creator.id, user: actor.userId, member: actor.memberId, demand: demand.key }[kind];
        const column = kind === "demand" ? "key" : "id";
        let holderPid;
        let waiterPid;
        let outcome;
        await runPhase3InterleavedTransactions({
          dbA, dbB,
          firstA: async (tx) => {
            [{ pid: holderPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
            await release.assertTeamControlPlaneWriteAdmission(tx);
            await release.authorizeCreatorAccountWrite(tx);
            if (kind === "agency") await lockAgencyLifecycleBarrier({ db: tx, agencyId: actor.agencyId, mode: "exclusive" });
            else await tx.$queryRawUnsafe(`SELECT "${column}" FROM "${table}" WHERE "${column}"=$1 FOR UPDATE`, targetId);
          },
          firstB: async (tx) => { [{ pid: waiterPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'); },
          secondA: async (tx) => {
            await waitForPhase3PostgresBlock({ db: observer, holderPid, waiterPid });
            const mutation = kind === "member" ? '"accessEpoch"="accessEpoch"+1'
              : kind === "demand" ? '"claimUntil"=clock_timestamp()-interval \'1 second\''
                : kind === "user" ? '"disabledAt"=clock_timestamp()' : '"deletedAt"=clock_timestamp()';
            await tx.$executeRawUnsafe(`UPDATE "${table}" SET ${mutation} WHERE "${column}"=$1`, targetId);
          },
          secondB: async (tx) => {
            // The interleave helper owns this real PostgreSQL transaction. No
            // jobs may be created, so no publication can escape its commit.
            const root = new Proxy(tx, { get(target, key) {
              if (key === "$transaction") return (work) => work(tx);
              const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
            } });
            try {
              await planAnalyticsDemandCreator({ db: root, demand, member, creator,
                startDay: demand.coverageFrom, endDay: demand.coverageTo, now: new Date(), coverageRows: [] });
              outcome = "unexpected-success";
            } catch (error) { outcome = error?.code; }
          },
        });
        assert.equal(outcome, expectedCode, kind);
        assert.equal(await dbA.jobInstance.count({ where: { creatorId: creator.id } }), 0, kind);
        assert.equal((await dbA.analyticsCollectionDemand.findUnique({ where: { key: demand.key } })).cursorCreatorId, null, kind);
      } finally {
        try { await dbA.analyticsCollectionDemand.deleteMany({ where: { agencyId: actor.agencyId } }); }
        finally { await cleanupPhase3PostgresFixtureGraph(dbA, { agencyId: actor.agencyId, userIds: [actor.userId, backupUser] }); }
      }
    }
    console.log("# A37_HOME_OBSERVED_LIFECYCLE_ACCESS_AND_LEASE_WAITS_PASS");
  } finally { await Promise.allSettled([dbA.$disconnect(), dbB.$disconnect(), observer.$disconnect()]); }
});

test("A37 PostgreSQL: recurring Analytics planning rolls back partial jobs and rejects expired ownership", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const { planRecurringCreatorAnalytics } = require("./analytics-recurring-planning-service");
  const db = new PrismaClient();
  let scope = null;
  try {
    scope = await createAgencyCreator(db, "a37-planning", { status: "READY" });
    const claim = await claimDomainWorkBatch({ db, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, agencyId: scope.agencyId, creatorIds: [scope.creatorId], limit: 1, leaseMs: 60_000 });
    assert.equal(claim.items.length, 1);
    let inserts = 0;
    const faultDb = new Proxy(db, { get(target, key) {
      if (key !== "$transaction") return target[key];
      return (work, options) => target.$transaction((tx) => work(new Proxy(tx, { get(transaction, property) {
        if (property !== "jobInstance") return transaction[property];
        return new Proxy(transaction.jobInstance, { get(delegate, method) {
          if (method !== "createMany") return delegate[method];
          return async (args) => {
            const result = await delegate.createMany(args);
            inserts += Number(result.count);
            throw Object.assign(new Error("injected failure after actual job insert"), { code: "A37_INJECTED" });
          };
        } });
      } })), options);
    } });
    await assert.rejects(() => planRecurringCreatorAnalytics({ db: faultDb, item: claim.items[0], ownerToken: claim.ownerToken }), { code: "A37_INJECTED" });
    assert.ok(inserts > 0, "the rollback must follow a real database insert");
    assert.equal(await db.jobInstance.count({ where: { creatorId: scope.creatorId } }), 0);
    const success = await planRecurringCreatorAnalytics({ db, item: claim.items[0], ownerToken: claim.ownerToken });
    assert.ok(success.created > 0);
    const before = await db.jobInstance.count({ where: { creatorId: scope.creatorId } });
    await db.$executeRawUnsafe('UPDATE "DomainWorkItem" SET "leaseUntil"=clock_timestamp() - interval \'1 second\' WHERE "id"=$1', claim.items[0].id);
    await assert.rejects(() => planRecurringCreatorAnalytics({ db, item: claim.items[0], ownerToken: claim.ownerToken }), { code: "ANALYTICS_PLANNING_CLAIM_LOST" });
    assert.equal(await db.jobInstance.count({ where: { creatorId: scope.creatorId } }), before);
    console.log("# A37_ANALYTICS_ATOMIC_PLANNING_PASS");
  } finally {
    try { if (scope) await cleanupPhase3PostgresAgencyFixture(db, scope.agencyId); }
    finally { await db.$disconnect(); }
  }
});

test("A37 PostgreSQL: two replicas share one directory budget and rollback releases the reservation", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const { reserveDirectoryAdmission } = require("./analytics-recurring-planning-service");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const budgetKey = nonce("a37-budget");
  const state = { campaignDirectoryCampaignCount: 2_000_000 };
  try {
    await assert.rejects(() => dbA.$transaction(async (tx) => {
      assert.equal(await reserveDirectoryAdmission({ db: tx, state, budgetKey }), true);
      throw new Error("rollback reservation");
    }), /rollback reservation/);
    assert.equal((await dbA.$queryRawUnsafe('SELECT "id" FROM "AnalyticsPlanningBudget" WHERE "id"=$1', budgetKey)).length, 0);
    const outcomes = await Promise.allSettled([
      dbA.$transaction((tx) => reserveDirectoryAdmission({ db: tx, state, budgetKey })),
      dbB.$transaction((tx) => reserveDirectoryAdmission({ db: tx, state, budgetKey })),
    ]);
    for (const result of outcomes) if (result.status === "rejected") throw result.reason;
    const results = outcomes.map((result) => result.value);
    assert.equal(results.filter(Boolean).length, 1);
    const [row] = await dbA.$queryRawUnsafe('SELECT "reservedJobs","reservedCalls" FROM "AnalyticsPlanningBudget" WHERE "id"=$1', budgetKey);
    assert.equal(row.reservedJobs, 1);
    assert.equal(row.reservedCalls, 40001);
    console.log("# A37_ANALYTICS_DISTRIBUTED_ADMISSION_PASS");
  } finally {
    try { await dbA.$executeRawUnsafe('DELETE FROM "AnalyticsPlanningBudget" WHERE "id"=$1', budgetKey); }
    finally { await Promise.allSettled([dbA.$disconnect(), dbB.$disconnect()]); }
  }
});

test("A37 PostgreSQL: planning commit authority rejects expiry after an observed work-row wait", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const { lockDomainWorkClaimForCommit } = require("./domain-work-authority-service");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const observer = new PrismaClient();
  let scope = null;
  try {
    scope = await createAgencyCreator(dbA, "a37-commit-wait", { status: "READY" });
    const claim = await claimDomainWorkBatch({ db: dbA, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, agencyId: scope.agencyId, creatorIds: [scope.creatorId], limit: 1, leaseMs: 60_000 });
    assert.equal(claim.items.length, 1);
    let holderPid;
    let waiterPid;
    let result;
    await runPhase3InterleavedTransactions({
      dbA, dbB,
      firstA: async (tx) => {
        [{ pid: holderPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
        await tx.$queryRawUnsafe('SELECT "id" FROM "DomainWorkItem" WHERE "id"=$1 FOR UPDATE', claim.items[0].id);
      },
      firstB: async (tx) => { [{ pid: waiterPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'); },
      secondA: async (tx) => {
        await waitForPhase3PostgresBlock({ db: observer, holderPid, waiterPid });
        const [row] = await tx.$queryRawUnsafe('UPDATE "DomainWorkItem" SET "leaseUntil"=clock_timestamp() + interval \'100 milliseconds\' WHERE "id"=$1 RETURNING "leaseUntil" AS deadline', claim.items[0].id);
        await waitUntilPhase3DatabaseTime(tx, row.deadline);
      },
      secondB: async (tx) => { result = await lockDomainWorkClaimForCommit({ db: tx, item: claim.items[0], ownerToken: claim.ownerToken }); },
    });
    assert.equal(result.current, false);
    assert.equal(result.lost, true);
    assert.equal(await dbA.jobInstance.count({ where: { creatorId: scope.creatorId } }), 0);
    console.log("# A37_PLANNING_OBSERVED_WAIT_EXPIRY_PASS");
  } finally {
    try { if (scope) await cleanupPhase3PostgresAgencyFixture(dbA, scope.agencyId); }
    finally { await Promise.allSettled([dbA.$disconnect(), dbB.$disconnect(), observer.$disconnect()]); }
  }
});

async function withTeamGeneration(db, workFn) {
  return db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT set_config($1,$2,true) AS value`,
      release.TEAM_CONTROL_PLANE_DB_SETTING,
      release.TEAM_CONTROL_PLANE_GENERATION,
    );
    return workFn(tx);
  }, { maxWait: 30_000, timeout: 300_000 });
}

async function createAgencyCreator(db, prefix, { status = "DRAFT" } = {}) {
  const id = nonce(prefix);
  const agencyId = `${id}-agency`;
  const creatorId = `${id}-creator`;
  await withPhase3PostgresFixtureAuthority(db, async (tx) => {
    await tx.agency.create({ data: { id: agencyId, name: `A34 ${agencyId}` } });
    await tx.creatorAccount.create({ data: { id: creatorId, agencyId, displayName: `A34 ${creatorId}`, status } });
  });
  return { agencyId, creatorId };
}

async function seedHiddenSnapshot(db, scope, fanIds) {
  const runId = `${scope.creatorId}-hidden-run`;
  const now = new Date();
  await db.subscriberScanRun.create({
    data: {
      id: runId,
      agencyId: scope.agencyId,
      creatorId: scope.creatorId,
      status: "PUBLISHED",
      hasMore: false,
      fanProjectionStatus: "COMPLETE",
      publicationStatus: "COMPLETE",
      publicationGeneration: 1,
      publishedAt: now,
      completedAt: now,
    },
  });
  await db.subscriberScanItem.createMany({
    data: fanIds.map((fanId, index) => ({
      id: `${scope.creatorId}-hidden-item-${index}`,
      runId,
      agencyId: scope.agencyId,
      creatorId: scope.creatorId,
      fanId,
      dialogId: `${fanId}-dialog`,
      username: `a34_fan_${index}`,
      name: `A34 Fan ${index}`,
      lastSeenIsNull: true,
      contentHash: `${scope.creatorId}-hidden-hash-${index}`,
      metadata: {},
      observedAt: now,
    })),
  });
  await db.subscriberDirectoryState.create({
    data: {
      agencyId: scope.agencyId,
      creatorId: scope.creatorId,
      currentRunId: runId,
      status: "READY",
      publicationGeneration: 1,
      publishedGeneration: 1,
      publishedAt: now,
      totalCount: fanIds.length,
      hiddenCount: fanIds.length,
    },
  });
  return runId;
}

test("A34 PostgreSQL: Hidden status command, projection rollback and concurrent writers converge atomically", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const scope = await createAgencyCreator(dbA, "a34-hidden");
  const fan = `${scope.creatorId}-fan`;
  const rollbackFan = `${scope.creatorId}-rollback`;
  await seedHiddenSnapshot(dbA, scope, [fan, rollbackFan]);
  let rejectionTriggerInstalled = false;
  try {
    await setHiddenOnlineStatus({ db: dbA, ...scope, fanId: fan, status: "ignored" });
    let hidden = await dbA.hiddenOnlineUser.findUnique({ where: { creatorId_fanId: { creatorId: scope.creatorId, fanId: fan } } });
    let bump = await dbA.automationBumpFanState.findUnique({ where: { creatorId_fanId: { creatorId: scope.creatorId, fanId: fan } } });
    assert.equal(hidden?.status, "ignored");
    assert.equal(bump?.ignored, true);
    assert.equal(bump?.blocked, false);

    await dbA.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "a34_reject_hidden_projection"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."fanId" LIKE '%-rollback' THEN
          RAISE EXCEPTION 'A34 forced projection failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await dbA.$executeRawUnsafe('DROP TRIGGER IF EXISTS "trg_a34_reject_hidden_projection" ON "AutomationBumpFanState"');
    await dbA.$executeRawUnsafe(`CREATE TRIGGER "trg_a34_reject_hidden_projection"
      BEFORE INSERT OR UPDATE ON "AutomationBumpFanState"
      FOR EACH ROW EXECUTE FUNCTION "a34_reject_hidden_projection"()`);
    rejectionTriggerInstalled = true;
    await assert.rejects(
      () => setHiddenOnlineStatus({ db: dbA, ...scope, fanId: rollbackFan, status: "blocked" }),
      /A34 forced projection failure/,
    );
    assert.equal(await dbA.hiddenOnlineUser.count({ where: { creatorId: scope.creatorId, fanId: rollbackFan } }), 0);
    assert.equal(await dbA.automationBumpFanState.count({ where: { creatorId: scope.creatorId, fanId: rollbackFan } }), 0);

    await dbA.$executeRawUnsafe('DROP TRIGGER IF EXISTS "trg_a34_reject_hidden_projection" ON "AutomationBumpFanState"');
    await dbA.$executeRawUnsafe('DROP FUNCTION IF EXISTS "a34_reject_hidden_projection"()');
    rejectionTriggerInstalled = false;

    await Promise.all([
      setHiddenOnlineStatus({ db: dbA, ...scope, fanId: fan, status: "ignored" }),
      setHiddenOnlineStatus({ db: dbB, ...scope, fanId: fan, status: "blocked" }),
    ]);
    hidden = await dbA.hiddenOnlineUser.findUnique({ where: { creatorId_fanId: { creatorId: scope.creatorId, fanId: fan } } });
    bump = await dbA.automationBumpFanState.findUnique({ where: { creatorId_fanId: { creatorId: scope.creatorId, fanId: fan } } });
    assert.ok(["ignored", "blocked"].includes(hidden?.status));
    assert.equal(bump?.ignored, hidden.status === "ignored");
    assert.equal(bump?.blocked, hidden.status === "blocked");
    console.log("# A34_HIDDEN_STATUS_ATOMIC_AUTHORITY_PASS");
  } finally {
    if (rejectionTriggerInstalled) {
      await dbA.$executeRawUnsafe('DROP TRIGGER IF EXISTS "trg_a34_reject_hidden_projection" ON "AutomationBumpFanState"').catch(() => null);
      await dbA.$executeRawUnsafe('DROP FUNCTION IF EXISTS "a34_reject_hidden_projection"()').catch(() => null);
    }
    await cleanupPhase3PostgresAgencyFixture(dbA, scope.agencyId);
    await dbA.$disconnect();
    await dbB.$disconnect();
  }
});

test("A34 PostgreSQL: 4000 creators publish bounded fair work and two replicas claim disjoint batches", { skip: !enabled, timeout: 300_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const parallelDbs = Array.from({ length: 6 }, () => new PrismaClient());
  const prefix = nonce("a34-scale");
  const agencyIds = Array.from({ length: 4 }, (_, index) => `${prefix}-agency-${index}`);
  try {
    await withPhase3PostgresFixtureAuthority(dbA, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "Agency"("id","name","createdAt","updatedAt")
         SELECT $1 || '-agency-' || g::text, 'A34 scale ' || g::text, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           FROM generate_series(0,3) AS g`,
        prefix,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "CreatorAccount"("id","agencyId","displayName","status","createdAt","updatedAt")
         SELECT $1 || '-creator-' || lpad(g::text,4,'0'),
                $1 || '-agency-' || (g % 4)::text,
                'A34 scale creator ' || g::text,
                'READY'::"CreatorStatus",CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
           FROM generate_series(0,3999) AS g`,
        prefix,
      );
    }, { maxWait: 30_000, timeout: 240_000 });

    const total = await dbA.domainWorkItem.count({ where: { workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, creatorId: { startsWith: `${prefix}-creator-` }, isOutstanding: true } });
    assert.equal(total, 4000);
    const began = Date.now();
    const [claimA, claimB] = await Promise.all([
      claimDomainWorkBatch({ db: dbA, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, ownerToken: `${prefix}-replica-a`, limit: 100, perAgencyQuantum: 25, perPartitionQuantum: 1, leaseMs: 120_000 }),
      claimDomainWorkBatch({ db: dbB, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, ownerToken: `${prefix}-replica-b`, limit: 100, perAgencyQuantum: 25, perPartitionQuantum: 1, leaseMs: 120_000 }),
    ]);
    const idsA = new Set(claimA.items.map((item) => item.id));
    const idsB = new Set(claimB.items.map((item) => item.id));
    assert.equal(claimA.items.length, 100);
    assert.equal(claimB.items.length, 100);
    assert.equal([...idsA].filter((id) => idsB.has(id)).length, 0);
    assert.equal(new Set(claimA.items.map((item) => item.agencyId)).size, 4);
    assert.equal(new Set(claimB.items.map((item) => item.agencyId)).size, 4);
    assert.ok(Date.now() - began < 60_000);

    const parallelOwners = [dbA, dbB, ...parallelDbs];
    const parallelBegan = Date.now();
    const parallelClaims = await Promise.all(parallelOwners.map((db, index) => claimDomainWorkBatch({
      db,
      workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
      ownerToken: `${prefix}-parallel-${index}`,
      limit: 20,
      perAgencyQuantum: 5,
      perPartitionQuantum: 1,
      leaseMs: 120_000,
    })));
    const parallelIds = parallelClaims.flatMap((claim) => claim.items.map((item) => item.id));
    assert.equal(parallelClaims.every((claim) => claim.items.length === 20), true);
    assert.equal(parallelClaims.every((claim) => new Set(claim.items.map((item) => item.agencyId)).size === 4), true);
    assert.equal(new Set(parallelIds).size, 160);
    assert.equal(parallelIds.some((id) => idsA.has(id) || idsB.has(id)), false);
    assert.ok(Date.now() - parallelBegan < 60_000);
    const attempts = await dbA.domainWorkItem.groupBy({
      by: ["attempts"],
      where: { workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, creatorId: { startsWith: `${prefix}-creator-` }, attempts: { gt: 0 } },
      _count: { _all: true },
    });
    assert.deepEqual(attempts.map((row) => ({ attempts: row.attempts, count: row._count._all })), [{ attempts: 1, count: 360 }]);
    console.log("# A34_4000_CREATOR_TWO_REPLICA_BOUNDED_PASS");
    console.log("# A36_4000_CREATOR_EIGHT_REPLICA_PARALLEL_PASS");
  } finally {
    for (const agencyId of agencyIds) await cleanupPhase3PostgresAgencyFixture(dbA, agencyId);
    await dbA.$disconnect();
    await dbB.$disconnect();
    await Promise.all(parallelDbs.map((db) => db.$disconnect()));
  }
});

test("A36 PostgreSQL: scoped member claims 1000 of 2000 creators through fixed shards without enumerating scope", { skip: !enabled, timeout: 300_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const prefix = nonce("a36-member-scope");
  const agencyId = `${prefix}-agency`;
  const userId = `${prefix}-user`;
  const memberId = `${prefix}-member`;
  const allowedCreatorIds = Array.from({ length: 1000 }, (_, index) => `${prefix}-creator-${String(index).padStart(4, "0")}`);
  try {
    await withTeamGeneration(dbA, (tx) => tx.agency.create({ data: { id: agencyId, name: `A36 member scope ${agencyId}` } }));
    await dbA.user.create({ data: { id: userId, email: `${userId}@example.test`, passwordHash: "integration" } });
    await withPhase3PostgresFixtureAuthority(dbA, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO "CreatorAccount"("id","agencyId","displayName","status","createdAt","updatedAt")
       SELECT $1 || '-creator-' || lpad(g::text,4,'0'),$2,
              'A36 member creator ' || g::text,'READY'::"CreatorStatus",CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
         FROM generate_series(0,1999) AS g`,
      prefix,agencyId,
    ), { maxWait: 30_000, timeout: 240_000 });
    await withTeamGeneration(dbA, (tx) => tx.agencyMember.create({
      data: {
        id: memberId, agencyId, userId, role: "OPERATOR", roleKey: "chatter",
        assignedCreators: { mode: "scoped", creatorIds: allowedCreatorIds },
      },
    }));

    let member = await dbA.agencyMember.findUnique({ where: { id: memberId } });
    assert.equal(await dbA.agencyMemberCreatorAccessCurrent.count({ where: { memberId } }), 1000);
    const scopeShards = await dbA.domainWorkMemberScopeShardState.findMany({
      where: { memberId }, select: { claimShard: true }, orderBy: { claimShard: "asc" },
    });
    assert.ok(scopeShards.length > 1 && scopeShards.length <= 128);

    const memberScope = {
      agencyId, memberId, userId, accessEpoch: Number(member.accessEpoch),
    };
    const [claimA, claimB] = await Promise.all([
      claimDomainWorkBatch({
        db: dbA, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
        agencyId, memberScope, ownerToken: `${prefix}-scoped-a`, limit: 25,
        perAgencyQuantum: 25, perPartitionQuantum: 1, leaseMs: 120_000,
      }),
      claimDomainWorkBatch({
        db: dbB, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
        agencyId, memberScope, ownerToken: `${prefix}-scoped-b`, limit: 25,
        perAgencyQuantum: 25, perPartitionQuantum: 1, leaseMs: 120_000,
      }),
    ]);
    const claimed = [...claimA.items, ...claimB.items];
    const claimStatus = (claim) => JSON.stringify({ count: claim.items.length, skipped: claim.skipped, reason: claim.reason, topologyState: claim.topologyState });
    assert.equal(claimA.items.length, 25, `first scoped claim: ${claimStatus(claimA)}`);
    assert.equal(claimB.items.length, 25, `second scoped claim: ${claimStatus(claimB)}`);
    assert.equal(new Set(claimed.map((row) => row.id)).size, 50);
    assert.equal(claimed.every((row) => allowedCreatorIds.includes(String(row.creatorId))), true);

    const selectedShard = Number(scopeShards[0].claimShard);
    const plan = await dbA.$transaction(async (tx) => {
      await pinPhase3AuditSchema(tx);
      await tx.$executeRawUnsafe('ANALYZE "AgencyMemberCreatorAccessCurrent"');
      await tx.$executeRawUnsafe('ANALYZE "DomainWorkItem"');
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      const accessPlan = await tx.$queryRawUnsafe(
        `EXPLAIN (COSTS OFF, FORMAT JSON)
         SELECT x."creatorId"
           FROM "AgencyMemberCreatorAccessCurrent" x
          WHERE x."memberId"=$1 AND x."accessEpoch"=$2 AND x."claimShard"=$3
            AND x."creatorId">$4
          ORDER BY x."creatorId"
          LIMIT 16`, memberId,Number(member.accessEpoch),selectedShard,"",
      );
      const workPlan = await tx.$queryRawUnsafe(
        `EXPLAIN (COSTS OFF, FORMAT JSON)
         SELECT d."id"
           FROM "DomainWorkItem" d
          WHERE d."agencyId"=$1 AND d."workClass"=$2 AND d."activeGeneration"=$3
            AND d."creatorId"=$4 AND d."isOutstanding"=TRUE
            AND d."state" IN ('READY','CLAIMED')
            AND "phase3_domain_work_claimable_at"(
                  d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"
                ) <= $5
          ORDER BY "phase3_domain_work_claimable_at"(
                     d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"
                   ),d."id"
          LIMIT 16`,
        agencyId,WORK_CLASS.CREATOR_RECURRING_PLANNING,
        "phase2_domain_work_v3_actual55",allowedCreatorIds[0],new Date(),
      );
      return `${JSON.stringify(accessPlan)}\n${JSON.stringify(workPlan)}`;
    }, { maxWait: 10_000, timeout: 30_000 });
    assert.match(plan, /AgencyMemberCreatorAccessCurrent_claim_idx/);
    assert.match(plan, /DomainWorkItem_claimable_creator_a36_idx/);

    await withTeamGeneration(dbA, (tx) => tx.agencyMember.update({
      where: { id: memberId },
      data: { assignedCreators: { mode: "scoped", creatorIds: allowedCreatorIds.slice(1) } },
    }));
    member = await dbA.agencyMember.findUnique({ where: { id: memberId } });
    assert.equal(Number(member.accessEpoch), memberScope.accessEpoch + 1,
      "DB boundary must advance accessEpoch even when a raw writer omits the bump");
    assert.equal(await dbA.agencyMemberCreatorAccessCurrent.count({ where: { memberId } }), 999);
    const stale = await claimDomainWorkBatch({
      db: dbA, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
      agencyId, memberScope, ownerToken: `${prefix}-stale-scope`, limit: 1,
      perAgencyQuantum: 1, perPartitionQuantum: 1,
    });
    assert.equal(stale.skipped, true);
    assert.equal(stale.reason, "domain_work_member_scope_stale");
    console.log("# A36_SCOPED_1000_OF_2000_FIXED_SHARD_ACCESS_PASS");
  } finally {
    try {
      // User DELETE is itself Team-generation fenced, even after Agency delete.
      await cleanupPhase3PostgresFixtureGraph(dbA, { agencyId, userIds: [userId] });
    } finally {
      await Promise.all([dbA.$disconnect(), dbB.$disconnect()]);
    }
  }
});

test("A36 PostgreSQL: dependency changes publish one durable wake and drain blocked work in indexed batches", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "a36-dependency-wake");
  const dependencyKind = "A36_SCALE_PROBE";
  const dependencyKey = `${scope.agencyId}-dependency`;
  const objectPrefix = `${scope.agencyId}-blocked-`;
  try {
    await db.$queryRawUnsafe(
      `SELECT "phase2_publish_domain_work"(
         $1,'DEPENDENCY_WAKE','DependencyProbe',$2 || lpad(g::text,4,'0'),$3,
         NULL,NULL,$4,$3,0,CURRENT_TIMESTAMP
       )
         FROM generate_series(1,250) AS g`,
      scope.agencyId,objectPrefix,dependencyKey,dependencyKind,
    );
    await db.$executeRawUnsafe(
      `UPDATE "DomainWorkItem"
          SET "state"='BLOCKED',"isOutstanding"=TRUE,
              "dependencyKind"=$2,"dependencyKey"=$3,"dependencyRevision"=0,
              "ownerToken"=NULL,"leaseUntil"=CURRENT_TIMESTAMP,
              "errorClass"='DEPENDENCY',"lastError"='A36 scale probe',"updatedAt"=CURRENT_TIMESTAMP
        WHERE "agencyId"=$1 AND "workClass"='DEPENDENCY_WAKE'
          AND "objectType"='DependencyProbe' AND "objectId" LIKE $4`,
      scope.agencyId,dependencyKind,dependencyKey,`${objectPrefix}%`,
    );
    assert.equal(await db.domainWorkItem.count({
      where: {
        agencyId: scope.agencyId,
        workClass: "DEPENDENCY_WAKE",
        objectType: "DependencyProbe",
        state: "BLOCKED",
      },
    }), 250);

    await db.phase2WorkBroadClaimPartitionState.deleteMany({
      where: {
        agencyId: scope.agencyId,
        workClass: "DEPENDENCY_WAKE",
        partitionKey: dependencyKey,
      },
    });
    await db.$queryRawUnsafe(
      `SELECT "phase3_reconcile_domain_work_claim_partition"($1,$2,$3,$4,CURRENT_TIMESTAMP) AS reconciled`,
      scope.agencyId,"DEPENDENCY_WAKE","phase2_domain_work_v3_actual55",dependencyKey,
    );
    const repairedWitness = await db.phase2WorkBroadClaimPartitionState.findUnique({
      where: {
        agencyId_workClass_partitionKey: {
          agencyId: scope.agencyId,
          workClass: "DEPENDENCY_WAKE",
          partitionKey: dependencyKey,
        },
      },
    });
    assert.equal(repairedWitness?.outstandingCount, 1,
      "missing locator repair must use one bounded positive witness, not COUNT the partition");
    assert.equal(repairedWitness?.nextClaimableAt, null);

    const bumped = await db.$queryRawUnsafe(
      `SELECT "phase2_bump_dependency"($1,$2,$3) AS revision`,
      scope.agencyId,dependencyKind,dependencyKey,
    );
    assert.equal(BigInt(bumped?.[0]?.revision || 0), 1n);
    assert.equal(await db.domainWorkItem.count({
      where: {
        agencyId: scope.agencyId,
        workClass: "DEPENDENCY_WAKE",
        objectType: "DependencyProbe",
        state: "BLOCKED",
      },
    }), 250, "producer bump must not synchronously rewrite the blocked population");
    assert.equal(await db.domainWorkItem.count({
      where: {
        agencyId: scope.agencyId,
        workClass: "DEPENDENCY_WAKE",
        objectType: "DomainDependency",
        dependencyKind,
        dependencyKey,
        isOutstanding: true,
      },
    }), 1);

    const planRows = await db.$transaction(async (tx) => {
      await pinPhase3AuditSchema(tx);
      await tx.$executeRawUnsafe('ANALYZE "DomainWorkItem"');
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return tx.$queryRawUnsafe(
        `EXPLAIN (COSTS OFF, FORMAT JSON)
         SELECT d."id"
           FROM "DomainWorkItem" d
          WHERE d."agencyId"=$1 AND d."state"='BLOCKED' AND d."isOutstanding"=TRUE
            AND d."dependencyKind"=$2 AND d."dependencyKey"=$3
            AND d."dependencyRevision" < 1
          ORDER BY d."dependencyRevision",d."id"
          LIMIT 100`,
        scope.agencyId,dependencyKind,dependencyKey,
      );
    }, { maxWait: 10_000, timeout: 30_000 });
    assert.match(JSON.stringify(planRows), /DomainWorkItem_blocked_dependency_partial_idx/);

    const batches = [];
    for (let index = 0; index < 3; index += 1) {
      const rows = await db.$queryRawUnsafe(
        `SELECT "woken","remaining"
           FROM "phase3_wake_domain_dependency_batch"($1,$2,$3,$4,100)`,
        scope.agencyId,dependencyKind,dependencyKey,1n,
      );
      batches.push({ woken: Number(rows?.[0]?.woken || 0), remaining: rows?.[0]?.remaining === true });
    }
    assert.deepEqual(batches, [
      { woken: 100, remaining: true },
      { woken: 100, remaining: true },
      { woken: 50, remaining: false },
    ]);
    assert.equal(await db.domainWorkItem.count({
      where: {
        agencyId: scope.agencyId,
        workClass: "DEPENDENCY_WAKE",
        objectType: "DependencyProbe",
        state: "BLOCKED",
      },
    }), 0);
    console.log("# A36_DEPENDENCY_WAKE_BOUNDED_FANOUT_PASS");
  } finally {
    try {
      await cleanupPhase3PostgresAgencyFixture(db, scope.agencyId);
    } finally {
      await db.$disconnect();
    }
  }
});

test("A36 PostgreSQL: 1000 agencies publish 4000 creators and two replicas claim tenant-fair disjoint batches", { skip: !enabled, timeout: 360_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const prefix = nonce("a36-agency-scale");
  const agencyIds = Array.from({ length: 1000 }, (_, index) => `${prefix}-agency-${String(index).padStart(4, "0")}`);
  const rolloutWakeObjectId = `${prefix}-rollout-wake-probe`;
  const rolloutDependencyKind = "A36_ROLLOUT_WAKE_PROBE";
  const rolloutDependencyKey = `${prefix}-dependency`;
  try {
    await withPhase3PostgresFixtureAuthority(dbA, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "Agency"("id","name","createdAt","updatedAt")
         SELECT $1 || '-agency-' || lpad(g::text,4,'0'),
                'A36 agency scale ' || g::text,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
           FROM generate_series(0,999) AS g`,
        prefix,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "CreatorAccount"("id","agencyId","displayName","status","createdAt","updatedAt")
         SELECT $1 || '-creator-' || lpad(g::text,4,'0'),
                $1 || '-agency-' || lpad((g / 4)::text,4,'0'),
                'A36 agency-scale creator ' || g::text,
                'READY'::"CreatorStatus",CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
           FROM generate_series(0,3999) AS g`,
        prefix,
      );
    }, { maxWait: 30_000, timeout: 300_000 });

    const total = await dbA.domainWorkItem.count({
      where: {
        workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
        creatorId: { startsWith: `${prefix}-creator-` },
        isOutstanding: true,
      },
    });
    assert.equal(total, 4000);
    assert.equal(await dbA.domainWorkClaimAgencyState.count({
      where: { workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, agencyId: { startsWith: `${prefix}-agency-` } },
    }), 1000);

    // Rehearse the populated online rollout rather than proving only a fresh
    // schema.  Existing A*C locators are erased, broad readers fail closed,
    // and the durable keyset activator must rebuild 4000 partitions across
    // multiple commits.  A live Creator write is injected after the cursor has
    // passed its Agency; the already-installed producer, not a second sweep,
    // must create its complete hierarchy.
    await withPhase3PostgresFixtureAuthority(dbA, async (tx) => {
      await tx.domainWorkClaimAgencyState.deleteMany({
        where: { workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, agencyId: { startsWith: `${prefix}-agency-` } },
      });
      await tx.domainWorkClaimShardState.deleteMany({
        where: { workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, agencyId: { startsWith: `${prefix}-agency-` } },
      });
      await tx.phase2WorkBroadClaimPartitionState.updateMany({
        where: { workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, agencyId: { startsWith: `${prefix}-agency-` } },
        data: { claimShard: 0, nextClaimableAt: null },
      });
      await tx.domainWorkClaimTopologyState.update({
        where: { id: DOMAIN_WORK_CLAIM_TOPOLOGY_ID },
        data: {
          activationState: "BUILDING",
          cursorAgencyId: null,
          cursorWorkClass: null,
          cursorPartitionKey: null,
          cursorActiveGeneration: null,
          cursorWorkId: null,
          backfilledPartitions: 0n,
          partitionsBackfilledAt: null,
          cursorMemberId: null,
          backfilledMembers: 0n,
          membersBackfilledAt: null,
          activatedAt: null,
          lastError: null,
        },
      });
      await tx.phase2ReleaseCompatibilityAuthority.update({
        where: { scope: "DOMAIN_WORK_EXECUTOR" },
        data: {
          // This rehearsal rebuilds topology after current activation. v6 is a
          // one-way release floor; actual v4 expansion is covered by the runner's
          // rolling schema. Rebuilding must not reopen an old writer here.
          requiredGeneration: release.DOMAIN_WORK_EXECUTOR_GENERATION,
          activationState: "ACTIVE",
          activationConfirmedAt: new Date(),
        },
      });
      await tx.$queryRawUnsafe(
        `SELECT "phase2_publish_domain_work"(
           $1,'CUSTOM_REMINDER','A36RolloutWakeProbe',$2,$3,
           $3,NULL,$4,$5,0,CURRENT_TIMESTAMP
         )`,
        agencyIds[0],rolloutWakeObjectId,`${prefix}-creator-0000`,rolloutDependencyKind,rolloutDependencyKey,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "DomainWorkItem"
            SET "state"='BLOCKED',"isOutstanding"=TRUE,
                "dependencyKind"=$3,"dependencyKey"=$4,"dependencyRevision"=0,
                "ownerToken"=NULL,"leaseUntil"=CURRENT_TIMESTAMP,
                "errorClass"='DEPENDENCY',"lastError"='A36 rollout bridge probe',
                "updatedAt"=CURRENT_TIMESTAMP
          WHERE "agencyId"=$1 AND "workClass"='CUSTOM_REMINDER'
            AND "objectType"='A36RolloutWakeProbe' AND "objectId"=$2`,
        agencyIds[0],rolloutWakeObjectId,rolloutDependencyKind,rolloutDependencyKey,
      );
      await tx.$queryRawUnsafe(
        `SELECT "phase2_bump_dependency"($1,$2,$3) AS revision`,
        agencyIds[0],rolloutDependencyKind,rolloutDependencyKey,
      );
    }, { maxWait: 30_000, timeout: 300_000 });

    assert.equal(await dbA.domainWorkItem.count({
      where: {
        agencyId: agencyIds[0],
        workClass: WORK_CLASS.CUSTOM_REMINDER,
        objectType: "A36RolloutWakeProbe",
        objectId: rolloutWakeObjectId,
        state: "BLOCKED",
      },
    }), 1, "new bounded dependency protocol must be pending while the general topology is BUILDING");

    const fencedDuringBuild = await claimDomainWorkBatch({
      db: dbA,
      workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
      ownerToken: `${prefix}-building-reader`,
      limit: 1,
      perAgencyQuantum: 1,
      perPartitionQuantum: 1,
    });
    assert.equal(fencedDuringBuild.skipped, true);
    assert.equal(fencedDuringBuild.reason, "domain_work_claim_topology_building");

    const liveCreatorId = `${prefix}-live-after-cursor`;
    let injectedLiveWrite = false;
    const activation = await activateDomainWorkClaimTopology(dbA, {
      batchSize: 37,
      pauseMs: 0,
      onBatch: async (_batch, progress) => {
        if (injectedLiveWrite || progress.batches !== 1) return;
        injectedLiveWrite = true;
        await withPhase3PostgresFixtureAuthority(dbA, (tx) => tx.creatorAccount.create({
          data: {
            id: liveCreatorId,
            agencyId: agencyIds[0],
            displayName: `A36 live-after-cursor ${liveCreatorId}`,
            status: "READY",
          },
        }));
      },
    });
    assert.equal(injectedLiveWrite, true);
    assert.equal(activation.alreadyActive, false);
    assert.ok(activation.batches > 1);
    assert.ok(activation.processed >= 4000);
    assert.ok(activation.dependencyWakeSweeps > activation.batches,
      "rollout must pump dependency wake before, between and after bounded topology batches");
    assert.ok(activation.dependencyRowsWoken >= 1);
    const rolloutWakeTarget = await dbA.domainWorkItem.findFirst({
      where: {
        agencyId: agencyIds[0],
        workClass: WORK_CLASS.CUSTOM_REMINDER,
        objectType: "A36RolloutWakeProbe",
        objectId: rolloutWakeObjectId,
      },
      select: { state: true, isOutstanding: true },
    });
    assert.equal(rolloutWakeTarget?.state, "READY");
    assert.equal(rolloutWakeTarget?.isOutstanding, true);
    const activatedState = await dbA.domainWorkClaimTopologyState.findUnique({
      where: { id: DOMAIN_WORK_CLAIM_TOPOLOGY_ID },
    });
    assert.equal(activatedState?.activationState, "ACTIVE");
    const executorAuthority = await dbA.phase2ReleaseCompatibilityAuthority.findUnique({
      where: { scope: "DOMAIN_WORK_EXECUTOR" },
    });
    assert.equal(executorAuthority?.requiredGeneration, release.DOMAIN_WORK_EXECUTOR_GENERATION);
    await assert.rejects(
      () => dbA.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT set_config('onlinod.phase2_domain_executor_generation',$1,true) AS value`,
          "phase2_domain_executor_v4_actual56_postcut",
        );
        await tx.$executeRawUnsafe(
          `UPDATE "DomainWorkItem"
              SET "state"='CLAIMED',"ownerToken"='a36-stale-replica',
                  "claimFence"="claimFence"+1,"claimedRevision"="requestedRevision",
                  "leaseUntil"=CURRENT_TIMESTAMP + INTERVAL '2 minutes'
            WHERE "agencyId"=$1 AND "workClass"=$2 AND "objectId"=$3`,
          agencyIds[0],WORK_CLASS.CREATOR_RECURRING_PLANNING,liveCreatorId,
        );
      }),
      /PHASE2_INCOMPATIBLE_DOMAIN_EXECUTOR/,
    );
    const livePartition = await dbA.phase2WorkBroadClaimPartitionState.findUnique({
      where: {
        agencyId_workClass_partitionKey: {
          agencyId: agencyIds[0],
          workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
          partitionKey: liveCreatorId,
        },
      },
    });
    assert.ok(livePartition?.nextClaimableAt);
    assert.equal(await dbA.domainWorkClaimShardState.count({
      where: {
        agencyId: agencyIds[0],
        workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
        claimShard: livePartition.claimShard,
      },
    }), 1);
    assert.equal(await dbA.domainWorkClaimAgencyState.count({
      where: { workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, agencyId: { startsWith: `${prefix}-agency-` } },
    }), 1000);
    console.log("# A36_POPULATED_RESUMABLE_ACTIVATION_LIVE_WRITE_PASS");
    console.log("# A36_EXECUTOR_GENERATION_CUTOVER_PASS");

    const installedIndexes = await dbA.$queryRawUnsafe(`
      SELECT idx.relname AS name,i.indisvalid AS valid,i.indisready AS ready
        FROM pg_class idx
        JOIN pg_index i ON i.indexrelid=idx.oid
        JOIN pg_class tbl ON tbl.oid=i.indrelid
        JOIN pg_namespace ns ON ns.oid=tbl.relnamespace
       WHERE ns.nspname=current_schema()
         AND idx.relname IN (
           'DomainWorkClaimAgencyState_dispatch_idx',
           'DomainWorkClaimShardState_dispatch_idx',
           'Phase2WorkBroadClaimPartitionState_shard_due_idx',
           'DomainWorkItem_claimable_global_a36_idx',
           'DomainWorkItem_claimable_partition_a36_idx',
           'DomainWorkItem_claimable_agency_shard_a36_idx',
           'DomainWorkItem_claimable_creator_a36_idx',
           'DomainWorkItem_current_activation_a36_idx',
           'AgencyMember_current_activation_a36_idx'
         )
       ORDER BY idx.relname`);
    assert.equal(installedIndexes.length, 9);
    assert.equal(installedIndexes.every((row) => row.valid === true && row.ready === true), true);

    const stagingTables = await dbA.$queryRawUnsafe(`
      SELECT c.relname AS name,c.relpersistence AS persistence
        FROM pg_class c
        JOIN pg_namespace ns ON ns.oid=c.relnamespace
       WHERE ns.nspname=current_schema()
         AND c.relname IN ('DomainWorkClaimLocatorMutationBatch','DomainWorkClaimLocatorMutationIntent')
       ORDER BY c.relname`);
    assert.equal(stagingTables.length, 2);
    assert.equal(stagingTables.every((row) => row.persistence === "u"), true);
    const deferredTriggers = await dbA.$queryRawUnsafe(`
      SELECT t.tgdeferrable AS deferrable,t.tginitdeferred AS initially_deferred
        FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace ns ON ns.oid=c.relnamespace
       WHERE ns.nspname=current_schema()
         AND c.relname='DomainWorkClaimLocatorMutationBatch'
         AND t.tgname='trg_phase3_domain_work_claim_locator_mutation_flush'
         AND NOT t.tgisinternal`);
    assert.deepEqual(deferredTriggers, [{ deferrable: true, initially_deferred: true }]);

    const planEvidence = await dbA.$transaction(async (tx) => {
      await pinPhase3AuditSchema(tx);
      await tx.$executeRawUnsafe('ANALYZE "DomainWorkClaimAgencyState"');
      await tx.$executeRawUnsafe('ANALYZE "DomainWorkItem"');
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      const now = new Date();
      const agencyPlan = await tx.$queryRawUnsafe(
        `EXPLAIN (COSTS OFF, FORMAT JSON)
         SELECT a."id"
           FROM "DomainWorkClaimAgencyState" a
          WHERE a."workClass"=$1 AND a."activeGeneration"=$2 AND a."nextDispatchAt" <= $3
          ORDER BY a."nextDispatchAt",a."revision",a."agencyId"
          LIMIT 1`,
        WORK_CLASS.CREATOR_RECURRING_PLANNING,"phase2_domain_work_v3_actual55",now,
      );
      const physicalPlan = await tx.$queryRawUnsafe(
        `EXPLAIN (COSTS OFF, FORMAT JSON)
         SELECT d."id"
           FROM "DomainWorkItem" d
          WHERE d."workClass"=$1 AND d."activeGeneration"=$2 AND d."isOutstanding"=TRUE
            AND d."state" IN ('READY','CLAIMED')
            AND "phase3_domain_work_claimable_at"(d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil") <= $3
          ORDER BY "phase3_domain_work_claimable_at"(d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"),
                   d."agencyId",d."partitionKey",d."id"
          LIMIT 1`,
        WORK_CLASS.CREATOR_RECURRING_PLANNING,"phase2_domain_work_v3_actual55",now,
      );
      return `${JSON.stringify(agencyPlan)}\n${JSON.stringify(physicalPlan)}`;
    }, { maxWait: 10_000, timeout: 30_000 });
    assert.match(planEvidence, /DomainWorkClaimAgencyState_dispatch_idx/);
    assert.match(planEvidence, /DomainWorkItem_claimable_global_a36_idx/);

    const began = Date.now();
    const servedAgencies = new Set();
    const claimedIds = new Set();
    for (let wave = 0; wave < 3; wave += 1) {
      const outcomes = await Promise.allSettled([
        claimDomainWorkBatch({
          db: dbA, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
          ownerToken: `${prefix}-replica-a-${wave}`, limit: 50, perAgencyQuantum: 1,
          perPartitionQuantum: 1, leaseMs: 120_000,
        }),
        claimDomainWorkBatch({
          db: dbB, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
          ownerToken: `${prefix}-replica-b-${wave}`, limit: 50, perAgencyQuantum: 1,
          perPartitionQuantum: 1, leaseMs: 120_000,
        }),
      ]);
      for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
      const [claimA, claimB] = outcomes.map((outcome) => outcome.value);
      const waveItems = [...claimA.items, ...claimB.items];
      assert.equal(claimA.items.length, 50);
      assert.equal(claimB.items.length, 50);
      assert.equal(new Set(claimA.items.map((item) => item.agencyId)).size, 50);
      assert.equal(new Set(claimB.items.map((item) => item.agencyId)).size, 50);
      assert.equal(new Set(waveItems.map((item) => item.agencyId)).size, 100,
        `wave ${wave}: both replicas must rotate through unserved Agencies`);
      for (const item of waveItems) {
        assert.equal(claimedIds.has(item.id), false, "replicas must never claim the same work");
        assert.equal(servedAgencies.has(item.agencyId), false, "an unserved Agency must precede a repeat reservation");
        claimedIds.add(item.id);
        servedAgencies.add(item.agencyId);
      }
    }
    assert.equal(servedAgencies.size, 300);
    assert.ok(Date.now() - began < 60_000);

    const attempts = await dbA.domainWorkItem.groupBy({
      by: ["attempts"],
      where: {
        workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
        creatorId: { startsWith: `${prefix}-creator-` },
        attempts: { gt: 0 },
      },
      _count: { _all: true },
    });
    assert.deepEqual(attempts.map((row) => ({ attempts: row.attempts, count: row._count._all })), [{ attempts: 1, count: 300 }]);
    console.log("# A36_1000_AGENCY_4000_CREATOR_TWO_REPLICA_PASS");
  } finally {
    await withPhase3PostgresFixtureAuthority(dbA, async (tx) => {
      await tx.domainWorkItem.deleteMany({ where: { agencyId: { in: agencyIds } } });
      await tx.creatorAccount.deleteMany({ where: { agencyId: { in: agencyIds } } });
      await tx.agency.deleteMany({ where: { id: { in: agencyIds } } });
    }, { maxWait: 30_000, timeout: 300_000 }).catch(async () => {
      for (const id of agencyIds) await cleanupPhase3PostgresAgencyFixture(dbA, id);
    });
    await dbA.$disconnect();
    await dbB.$disconnect();
  }
});

test("A36 PostgreSQL: opposite-order multi-write transactions defer exact partition-shard-Agency reconciliation without deadlock", { skip: !enabled, timeout: 60_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const prefix = nonce("a36-deferred-lower");
  const agencyId = `${prefix}-agency`;
  try {
    await withPhase3PostgresFixtureAuthority(dbA, (tx) => tx.agency.create({
      data: { id: agencyId, name: `A36 deferred locator ${agencyId}` },
    }));

    const candidates = await dbA.$queryRawUnsafe(
      `WITH candidates AS (
         SELECT $1 || '-partition-' || g::text AS "partitionKey",
                "phase3_domain_work_claim_shard"($1 || '-partition-' || g::text) AS "claimShard"
           FROM generate_series(1,4096) AS g
       ), ranked AS (
         SELECT c.*,row_number() OVER (PARTITION BY c."claimShard" ORDER BY c."partitionKey") AS ordinal
           FROM candidates c
       )
       SELECT "partitionKey","claimShard"
         FROM ranked
        WHERE ordinal <= 2
        ORDER BY "claimShard",ordinal
        LIMIT 4`,
      prefix,
    );
    const byShard = new Map();
    for (const row of candidates || []) {
      const shard = Number(row.claimShard);
      const keys = byShard.get(shard) || [];
      keys.push(String(row.partitionKey));
      byShard.set(shard, keys);
    }
    const shardPairs = Array.from(byShard.entries()).filter(([, keys]) => keys.length >= 2).slice(0, 2);
    assert.equal(shardPairs.length, 2);
    const [[shardOneId, shardOne], [shardTwoId, shardTwo]] = shardPairs;

    const publish = (tx, objectId, partitionKey) => publishDomainWork({
      db: tx,
      agencyId,
      workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
      objectType: "A36DeferredLocatorProbe",
      objectId,
      partitionKey,
    });
    await runPhase3InterleavedTransactions({
      dbA, dbB,
      firstA: (tx) => publish(tx, `${prefix}-a-one`, shardOne[0]),
      secondA: (tx) => publish(tx, `${prefix}-a-two`, shardTwo[0]),
      firstB: (tx) => publish(tx, `${prefix}-b-two`, shardTwo[1]),
      secondB: (tx) => publish(tx, `${prefix}-b-one`, shardOne[1]),
    });
    assert.equal(await dbA.domainWorkItem.count({
      where: { agencyId, objectType: "A36DeferredLocatorProbe" },
    }), 4);
    assert.equal(await dbA.domainWorkClaimLocatorMutationIntent.count({ where: { agencyId } }), 0);
    assert.equal(await dbA.domainWorkClaimLocatorMutationBatch.count(), 0);
    assert.equal(await dbA.domainWorkClaimAgencyState.count({
      where: { agencyId, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING },
    }), 1);

    await withPhase3PostgresFixtureAuthority(dbA, (tx) => tx.domainWorkItem.updateMany({
      where: {
        agencyId,
        workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
        partitionKey: { in: shardOne },
      },
      data: { state: "BLOCKED", isOutstanding: true, ownerToken: null, leaseUntil: null, nextAttemptAt: null },
    }));
    const blockedPartitions = await dbA.phase2WorkBroadClaimPartitionState.findMany({
      where: {
        agencyId,
        workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
        partitionKey: { in: shardOne },
      },
    });
    assert.equal(blockedPartitions.length, 2);
    assert.equal(blockedPartitions.every((row) => row.nextClaimableAt == null), true);
    assert.equal(await dbA.domainWorkClaimShardState.count({
      where: { agencyId, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, claimShard: shardOneId },
    }), 0);
    assert.equal(await dbA.domainWorkClaimShardState.count({
      where: { agencyId, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, claimShard: shardTwoId },
    }), 1);

    await withPhase3PostgresFixtureAuthority(dbA, (tx) => tx.domainWorkItem.updateMany({
      where: {
        agencyId,
        workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
        partitionKey: { in: shardTwo },
      },
      data: { state: "BLOCKED", isOutstanding: true, ownerToken: null, leaseUntil: null, nextAttemptAt: null },
    }));
    assert.equal(await dbA.domainWorkClaimAgencyState.count({
      where: { agencyId, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING },
    }), 0);

    const futureDue = new Date(Date.now() + 120_000);
    await withPhase3PostgresFixtureAuthority(dbA, (tx) => tx.domainWorkItem.updateMany({
      where: {
        agencyId,
        workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
        partitionKey: shardOne[0],
      },
      data: { state: "READY", isOutstanding: true, availableAt: futureDue, nextAttemptAt: futureDue },
    }));
    const rebuiltPartition = await dbA.phase2WorkBroadClaimPartitionState.findFirst({
      where: { agencyId, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, partitionKey: shardOne[0] },
    });
    const rebuiltShard = await dbA.domainWorkClaimShardState.findFirst({
      where: { agencyId, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, claimShard: shardOneId },
    });
    const rebuiltAgency = await dbA.domainWorkClaimAgencyState.findFirst({
      where: { agencyId, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING },
    });
    assert.ok(rebuiltPartition?.nextClaimableAt?.getTime() >= futureDue.getTime() - 1);
    assert.ok(rebuiltShard?.nextDispatchAt?.getTime() >= futureDue.getTime() - 1);
    assert.ok(rebuiltAgency?.nextDispatchAt?.getTime() >= futureDue.getTime() - 1);
    console.log("# A36_DEFERRED_LOCATOR_MULTI_WRITE_DEADLOCK_CLOSURE_PASS");
  } finally {
    try {
      await cleanupPhase3PostgresAgencyFixture(dbA, agencyId);
    } finally {
      await Promise.all([dbA.$disconnect(), dbB.$disconnect()]);
    }
  }
});

test("A36 PostgreSQL: opposite-order transactions sharing the exact same partitions cannot retain the retired row-trigger inversion", { skip: !enabled, timeout: 60_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const prefix = nonce("a36-exact-partition-order");
  const agencyId = `${prefix}-agency`;
  try {
    await withPhase3PostgresFixtureAuthority(dbA, (tx) => tx.agency.create({
      data: { id: agencyId, name: `A36 exact partition order ${agencyId}` },
    }));
    const candidates = await dbA.$queryRawUnsafe(
      `SELECT $1 || '-partition-' || g::text AS "partitionKey",
              "phase3_domain_work_claim_shard"($1 || '-partition-' || g::text) AS "claimShard"
         FROM generate_series(1,256) AS g
        ORDER BY g`,
      prefix,
    );
    const first = candidates?.[0];
    const second = (candidates || []).find((row) => Number(row.claimShard) !== Number(first?.claimShard));
    assert.ok(first?.partitionKey && second?.partitionKey);
    const p1 = String(first.partitionKey);
    const p2 = String(second.partitionKey);
    const publish = (tx, objectId, partitionKey) => publishDomainWork({
      db: tx,
      agencyId,
      workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
      objectType: "A36ExactPartitionOrderProbe",
      objectId,
      partitionKey,
    });
    for (let wave = 0; wave < 6; wave += 1) {
      await runPhase3InterleavedTransactions({
        dbA, dbB,
        firstA: (tx) => publish(tx, `${prefix}-${wave}-a-p1`, p1),
        secondA: (tx) => publish(tx, `${prefix}-${wave}-a-p2`, p2),
        firstB: (tx) => publish(tx, `${prefix}-${wave}-b-p2`, p2),
        secondB: (tx) => publish(tx, `${prefix}-${wave}-b-p1`, p1),
      });
    }
    assert.equal(await dbA.domainWorkItem.count({
      where: { agencyId, objectType: "A36ExactPartitionOrderProbe" },
    }), 24);
    assert.equal(await dbA.phase2WorkBroadClaimPartitionState.count({
      where: {
        agencyId,
        workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
        partitionKey: { in: [p1, p2] },
      },
    }), 2);
    const retired = await dbA.$queryRawUnsafe(
      `SELECT 1 AS present
         FROM pg_trigger t
         JOIN pg_class c ON c.oid=t.tgrelid
         JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND c.relname='DomainWorkItem'
          AND t.tgname='trg_phase2_domain_work_current_partition' AND NOT t.tgisinternal`,
    );
    assert.equal(retired.length, 0);
    console.log("# A36_EXACT_PARTITION_OPPOSITE_ORDER_NO_ROW_TRIGGER_DEADLOCK_PASS");
  } finally {
    try {
      await cleanupPhase3PostgresAgencyFixture(dbA, agencyId);
    } finally {
      await Promise.all([dbA.$disconnect(), dbB.$disconnect()]);
    }
  }
});

test("A37-R4 PostgreSQL: absent child work and Agency cascade cannot recreate orphan locators", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "a37-locator-lifecycle");
  const klass = nonce("A37_EMPTY_LOCATOR");
  const generation = require("./domain-work-authority-service").DOMAIN_WORK_GENERATION;
  const reconcile = async () => {
    for (const [sql, args] of [
      ['SELECT "phase3_reconcile_domain_work_claim_partition"($1,$2,$3,$4,CURRENT_TIMESTAMP) AS ok', [scope.agencyId, klass, generation, scope.creatorId]],
      ['SELECT "phase3_reconcile_domain_work_claim_shard"($1,$2,$3,$4,CURRENT_TIMESTAMP) AS ok', [scope.agencyId, klass, generation, 0]],
      ['SELECT "phase3_reconcile_domain_work_claim_agency"($1,$2,$3,CURRENT_TIMESTAMP) AS ok', [scope.agencyId, klass, generation]],
    ]) assert.equal((await db.$queryRawUnsafe(sql, ...args))[0].ok, true);
    for (const name of ["phase2WorkBroadClaimPartitionState", "domainWorkClaimShardState", "domainWorkClaimAgencyState"]) {
      assert.equal(await db[name].count({ where: { agencyId: scope.agencyId, workClass: klass } }), 0);
    }
  };
  try {
    // An empty live tenant and a physically deleted tenant are both converged.
    await reconcile();
    const locatorCases = [
      // Satisfy every non-FK invariant before testing missing parent identity.
      ["phase2WorkBroadClaimPartitionState", { partitionKey: scope.creatorId, outstandingCount: 1 }],
      ["domainWorkClaimShardState", { claimShard: 0, nextDispatchAt: new Date() }],
      ["domainWorkClaimAgencyState", { nextDispatchAt: new Date() }],
    ];
    const data = { agencyId: scope.agencyId, workClass: klass, activeGeneration: generation };
    for (const [name, fields] of locatorCases) {
      // Positive control: identical payload must be valid while parent is live.
      const row = await db[name].create({ data: { ...data, ...fields, id: `${klass}-${name}` } });
      assert.equal(row.agencyId, scope.agencyId);
      await db[name].delete({ where: { id: row.id } });
    }
    await cleanupPhase3PostgresAgencyFixture(db, scope.agencyId);
    assert.equal(await db.agency.count({ where: { id: scope.agencyId } }), 0);
    await reconcile();
    // A successful no-op is not permission to weaken FK enforcement.
    for (const [name, fields] of locatorCases) {
      await assert.rejects(() => db[name].create({ data: { ...data, ...fields, id: `${klass}-${name}` } }),
        (error) => error?.code === "P2003" || error?.meta?.code === "23503");
    }
    console.log("# A37_LOCATOR_LIFECYCLE_EMPTY_AND_DELETED_PARENT_PASS");
  } finally {
    try { if (await db.agency.findUnique({ where: { id: scope.agencyId } })) await cleanupPhase3PostgresAgencyFixture(db, scope.agencyId); }
    finally { await db.$disconnect(); }
  }
});

test("A37-R4 PostgreSQL: production Agency hard-delete worker commits its final deferred locator flush", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const { claimPhase3PostgresAgencyDestructiveFixture } = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");
  const { processAgencyHardDeleteWorkItem } = require("./phase2-destructive-delete-authority-service");
  const db = new PrismaClient();
  const agencyId = nonce("a37-production-agency-delete");
  try {
    await withPhase3PostgresFixtureAuthority(db, async (tx) => {
      await tx.agency.create({ data: { id: agencyId, name: agencyId } });
      await tx.agency.update({ where: { id: agencyId }, data: { deletedAt: new Date() } });
    });
    const claim = await claimPhase3PostgresAgencyDestructiveFixture(db, agencyId);
    const item = await db.domainWorkItem.findUnique({ where: { id: claim.workId } });
    assert.ok(item);
    let outcome;
    for (let step = 0; step < 20; step += 1) {
      outcome = await processAgencyHardDeleteWorkItem({ db, item, ownerToken: claim.ownerToken, batchSize: 1000 });
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      if (outcome.complete) break;
    }
    assert.equal(outcome?.identityDeleted, true, JSON.stringify(outcome));
    assert.equal(await db.agency.count({ where: { id: agencyId } }), 0);
    assert.equal(await db.domainWorkItem.count({ where: { agencyId } }), 0);
    for (const name of ["phase2WorkBroadClaimPartitionState", "domainWorkClaimShardState", "domainWorkClaimAgencyState"]) {
      assert.equal(await db[name].count({ where: { agencyId } }), 0);
    }
    const intents = await db.$queryRawUnsafe('SELECT 1 FROM "DomainWorkClaimLocatorMutationIntent" WHERE "agencyId"=$1 LIMIT 1', agencyId);
    assert.equal(intents.length, 0);
    console.log("# A37_PRODUCTION_AGENCY_DELETE_LOCATOR_FLUSH_PASS");
  } finally {
    try { if (await db.agency.findUnique({ where: { id: agencyId } })) await cleanupPhase3PostgresAgencyFixture(db, agencyId); }
    finally { await db.$disconnect(); }
  }
});

test("A37-R4 PostgreSQL: deleting the last child concurrently with publication recreates every locator level", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const observer = new PrismaClient();
  const scopes = [];
  try {
    const candidates = await dbA.$queryRawUnsafe(`SELECT g::text AS key,
      "phase3_domain_work_claim_shard"(g::text) AS shard FROM generate_series(1,1024) g ORDER BY g`);
    const first = candidates[0];
    const sameShard = candidates.find((row) => row.key !== first.key && row.shard === first.shard);
    const otherShard = candidates.find((row) => row.shard !== first.shard);
    assert.ok(sameShard && otherShard);
    for (const level of ["partition", "shard", "agency"]) {
      const scope = await createAgencyCreator(dbA, `a37-recreate-${level}`);
      scopes.push(scope);
      const klass = nonce("A37_RECREATE");
      const second = level === "partition" ? first : level === "shard" ? sameShard : otherShard;
      const old = await publishDomainWork({ db: dbA, agencyId: scope.agencyId, workClass: klass,
        objectType: "RecreateProbe", objectId: `${klass}-old`, partitionKey: first.key });
      let holderPid;
      let waiterPid;
      await runPhase3InterleavedTransactions({
        dbA, dbB,
        firstA: async (tx) => {
          [{ pid: holderPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
          await tx.domainWorkItem.delete({ where: { id: old.id } });
          await tx.$executeRawUnsafe('SET CONSTRAINTS "trg_phase3_domain_work_claim_locator_mutation_flush" IMMEDIATE');
        },
        firstB: async (tx) => {
          [{ pid: waiterPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
          await publishDomainWork({ db: tx, agencyId: scope.agencyId, workClass: klass,
            objectType: "RecreateProbe", objectId: `${klass}-new`, partitionKey: second.key });
        },
        secondA: async () => { await waitForPhase3PostgresBlock({ db: observer, holderPid, waiterPid }); },
        secondB: (tx) => tx.$executeRawUnsafe('SET CONSTRAINTS "trg_phase3_domain_work_claim_locator_mutation_flush" IMMEDIATE'),
      });
      assert.equal(await dbA.domainWorkItem.count({ where: { agencyId: scope.agencyId, workClass: klass } }), 1);
      const partition = await dbA.phase2WorkBroadClaimPartitionState.findFirst({ where: { agencyId: scope.agencyId, workClass: klass, partitionKey: second.key } });
      const shard = await dbA.domainWorkClaimShardState.findFirst({ where: { agencyId: scope.agencyId, workClass: klass, claimShard: second.shard } });
      const agency = await dbA.domainWorkClaimAgencyState.findFirst({ where: { agencyId: scope.agencyId, workClass: klass } });
      const [{ checkedAt }] = await dbA.$queryRawUnsafe('SELECT clock_timestamp() AS "checkedAt"');
      for (const at of [partition?.nextClaimableAt, shard?.nextDispatchAt, agency?.nextDispatchAt]) {
        assert.ok(at instanceof Date && at <= checkedAt, `${level}: the private survivor must be runnable after delete commits`);
      }
    }
    console.log("# A37_LOCATOR_LAST_DELETE_CONCURRENT_PUBLICATION_PASS");
  } finally {
    try { for (const scope of scopes) await cleanupPhase3PostgresAgencyFixture(dbA, scope.agencyId); }
    finally { await Promise.allSettled([dbA.$disconnect(), dbB.$disconnect(), observer.$disconnect()]); }
  }
});

test("A37-R3 PostgreSQL: concurrent locator creation preserves earlier private work at every hierarchy level", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const observer = new PrismaClient();
  const scopes = [];
  try {
    const candidates = await dbA.$queryRawUnsafe(`SELECT g::text AS key,
      "phase3_domain_work_claim_shard"(g::text) AS shard FROM generate_series(1,1024) g ORDER BY g`);
    const first = candidates[0];
    const sameShard = candidates.find((row) => row.key !== first.key && row.shard === first.shard);
    const otherShard = candidates.find((row) => row.shard !== first.shard);
    assert.ok(sameShard && otherShard);
    for (const level of ["partition", "shard", "agency"]) {
      const scope = await createAgencyCreator(dbA, `a37-publication-${level}`);
      scopes.push(scope);
      const klass = nonce("A37_PUBLICATION");
      const second = level === "partition" ? first : level === "shard" ? sameShard : otherShard;
      const [{ authorityNow }] = await dbA.$queryRawUnsafe('SELECT clock_timestamp() AS "authorityNow"');
      const future = new Date(authorityNow.getTime() + 3_600_000);
      let holderPid;
      let waiterPid;
      const publish = (tx, objectId, partitionKey, availableAt) => publishDomainWork({
        db: tx, agencyId: scope.agencyId, workClass: klass,
        objectType: "LocatorPublicationProbe", objectId, partitionKey, availableAt,
      });
      await runPhase3InterleavedTransactions({
        dbA, dbB,
        firstA: async (tx) => {
          [{ pid: holderPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
          await publish(tx, `${klass}-future`, first.key, future);
          // Execute the real deferred writer and retain its locks until the peer
          // has actually waited. There are no production timing hooks here.
          await tx.$executeRawUnsafe('SET CONSTRAINTS "trg_phase3_domain_work_claim_locator_mutation_flush" IMMEDIATE');
        },
        firstB: async (tx) => {
          [{ pid: waiterPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
          await publish(tx, `${klass}-earlier`, second.key, authorityNow);
        },
        secondA: async () => { await waitForPhase3PostgresBlock({ db: observer, holderPid, waiterPid }); },
        secondB: (tx) => tx.$executeRawUnsafe('SET CONSTRAINTS "trg_phase3_domain_work_claim_locator_mutation_flush" IMMEDIATE'),
      });
      const partition = await dbA.phase2WorkBroadClaimPartitionState.findFirst({ where: {
        agencyId: scope.agencyId, workClass: klass, partitionKey: second.key,
      } });
      const shard = await dbA.domainWorkClaimShardState.findFirst({ where: {
        agencyId: scope.agencyId, workClass: klass, claimShard: second.shard,
      } });
      const agency = await dbA.domainWorkClaimAgencyState.findFirst({ where: { agencyId: scope.agencyId, workClass: klass } });
      const [{ checkedAt }] = await dbA.$queryRawUnsafe('SELECT clock_timestamp() AS "checkedAt"');
      for (const at of [partition?.nextClaimableAt, shard?.nextDispatchAt, agency?.nextDispatchAt]) {
        assert.ok(at instanceof Date && at <= checkedAt && at < future, `${level}: earlier work must remain dispatchable`);
      }
      assert.equal(await dbA.domainWorkItem.count({ where: { agencyId: scope.agencyId, workClass: klass } }), 2);
    }
    console.log("# A37_LOCATOR_CONCURRENT_PUBLICATION_EARLIER_WAKE_PASS");
  } finally {
    try { for (const scope of scopes) await cleanupPhase3PostgresAgencyFixture(dbA, scope.agencyId); }
    finally { await Promise.allSettled([dbA.$disconnect(), dbB.$disconnect(), observer.$disconnect()]); }
  }
});

test("A36 PostgreSQL: destructive internal authority requires the exact live claim and preserves child composition", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "a36-destructive-exact-claim");
  const creatorOwner = `${scope.creatorId}-creator-owner`;
  const agencyOwner = `${scope.agencyId}-agency-owner`;

  const creatorAuthorized = async ({ workId = "", ownerToken = "" } = {}) => db.$transaction(async (tx) => {
    await pinPhase3AuditSchema(tx);
    await tx.$queryRawUnsafe(`
      SELECT set_config('onlinod.phase2_destructive_creator_id',$1,true) AS "creatorId",
             set_config('onlinod.phase2_destructive_agency_id',$2,true) AS "agencyId",
             set_config('onlinod.phase2_destructive_creator_work_id',$3,true) AS "workId",
             set_config('onlinod.phase2_destructive_creator_owner_token',$4,true) AS "ownerToken"
    `, scope.creatorId, scope.agencyId, workId, ownerToken);
    const rows = await tx.$queryRawUnsafe(
      `SELECT "phase2_internal_creator_destructive_authorized"($1,$2) AS authorized`,
      scope.agencyId, scope.creatorId,
    );
    return rows?.[0]?.authorized === true;
  });
  const agencyAuthorized = async ({ workId = "", ownerToken = "" } = {}) => db.$transaction(async (tx) => {
    await pinPhase3AuditSchema(tx);
    await tx.$queryRawUnsafe(`
      SELECT set_config('onlinod.phase2_destructive_agency_id',$1,true) AS "agencyId",
             set_config('onlinod.phase2_destructive_agency_work_id',$2,true) AS "workId",
             set_config('onlinod.phase2_destructive_agency_owner_token',$3,true) AS "ownerToken"
    `, scope.agencyId, workId, ownerToken);
    const rows = await tx.$queryRawUnsafe(
      `SELECT "phase2_internal_agency_destructive_authorized"($1) AS authorized`,
      scope.agencyId,
    );
    return rows?.[0]?.authorized === true;
  });

  try {
    const creatorWork = await publishDomainWork({
      db,
      agencyId: scope.agencyId,
      workClass: WORK_CLASS.DESTRUCTIVE_CREATOR_CLEANUP,
      objectType: "Phase2CreatorDestructiveCleanup",
      objectId: scope.creatorId,
      partitionKey: scope.creatorId,
      creatorId: null,
    });
    const creatorClaim = await claimDomainWorkBatch({
      db,
      workClass: WORK_CLASS.DESTRUCTIVE_CREATOR_CLEANUP,
      agencyId: scope.agencyId,
      objectType: "Phase2CreatorDestructiveCleanup",
      objectIds: [scope.creatorId],
      ownerToken: creatorOwner,
      limit: 1,
      leaseMs: 120_000,
    });
    assert.equal(creatorClaim.items.length, 1);
    assert.equal(creatorClaim.items[0].id, creatorWork.id);

    const agencyWork = await publishDomainWork({
      db,
      agencyId: scope.agencyId,
      workClass: WORK_CLASS.DESTRUCTIVE_AGENCY_CLEANUP,
      objectType: "Phase2AgencyDestructiveCleanup",
      objectId: scope.agencyId,
      partitionKey: scope.agencyId,
      creatorId: null,
    });
    const agencyClaim = await claimDomainWorkBatch({
      db,
      workClass: WORK_CLASS.DESTRUCTIVE_AGENCY_CLEANUP,
      agencyId: scope.agencyId,
      objectType: "Phase2AgencyDestructiveCleanup",
      objectIds: [scope.agencyId],
      ownerToken: agencyOwner,
      limit: 1,
      leaseMs: 120_000,
    });
    assert.equal(agencyClaim.items.length, 1);
    assert.equal(agencyClaim.items[0].id, agencyWork.id);

    assert.equal(await creatorAuthorized(), false, "Agency/Creator markers alone must not authorize cleanup");
    assert.equal(await creatorAuthorized({ workId: creatorWork.id, ownerToken: `${creatorOwner}-wrong` }), false);
    assert.equal(await creatorAuthorized({ workId: creatorWork.id, ownerToken: creatorOwner }), true);
    assert.equal(await agencyAuthorized(), false, "Agency marker alone must not authorize cleanup");
    assert.equal(await agencyAuthorized({ workId: agencyWork.id, ownerToken: `${agencyOwner}-wrong` }), false);
    assert.equal(await agencyAuthorized({ workId: agencyWork.id, ownerToken: agencyOwner }), true);

    await db.$transaction(async (tx) => {
      await pinPhase3AuditSchema(tx);
      await tx.$queryRawUnsafe(`
        SELECT set_config('onlinod.phase2_destructive_creator_id',$1,true),
               set_config('onlinod.phase2_destructive_agency_id',$2,true),
               set_config('onlinod.phase2_destructive_creator_work_id',$3,true),
               set_config('onlinod.phase2_destructive_creator_owner_token',$4,true)
      `, scope.creatorId, scope.agencyId, creatorWork.id, creatorOwner);
      await tx.$executeRawUnsafe(
        `SELECT "phase2_assert_creator_destructive_insert_allowed"($1,$2,'A36ExactCreatorChildProbe')`,
        scope.agencyId, scope.creatorId,
      );
    });

    await db.$transaction(async (tx) => {
      await pinPhase3AuditSchema(tx);
      await release.authorizeDomainWorkExecutor(tx);
      await tx.domainWorkItem.update({
        where: { id: creatorWork.id },
        data: { leaseUntil: new Date(Date.now() - 1000) },
      });
    });
    assert.equal(await creatorAuthorized({ workId: creatorWork.id, ownerToken: creatorOwner }), false);
    await db.$transaction(async (tx) => {
      await pinPhase3AuditSchema(tx);
      await release.authorizeDomainWorkExecutor(tx);
      await tx.domainWorkItem.update({
        where: { id: agencyWork.id },
        data: { leaseUntil: new Date(Date.now() - 1000) },
      });
    });
    assert.equal(await agencyAuthorized({ workId: agencyWork.id, ownerToken: agencyOwner }), false);
    console.log("# A36_DESTRUCTIVE_EXACT_CLAIM_AUTHORITY_PASS");
  } finally {
    try {
      await cleanupPhase3PostgresAgencyFixture(db, scope.agencyId);
    } finally {
      await db.$disconnect();
    }
  }
});

test("A34 PostgreSQL: expired recurring claim is fenced, restart takes over and creator lifecycle revokes/reopens work", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const scope = await createAgencyCreator(dbA, "a34-restart", { status: "READY" });
  try {
    const first = await claimDomainWorkBatch({
      db: dbA,
      workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
      agencyId: scope.agencyId,
      creatorIds: [scope.creatorId],
      ownerToken: `${scope.creatorId}-old-replica`,
      limit: 1,
      leaseMs: 60_000,
    });
    assert.equal(first.items.length, 1);
    await dbA.domainWorkItem.update({ where: { id: first.items[0].id }, data: { leaseUntil: new Date(Date.now() - 1000) } });

    const takeover = await claimDomainWorkBatch({
      db: dbB,
      workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
      agencyId: scope.agencyId,
      creatorIds: [scope.creatorId],
      ownerToken: `${scope.creatorId}-new-replica`,
      limit: 1,
      leaseMs: 60_000,
    });
    assert.equal(takeover.items.length, 1);
    const stale = await yieldDomainWorkClaim({ db: dbA, item: first.items[0], ownerToken: first.ownerToken, availableAt: new Date() });
    assert.equal(stale.lost, true);
    const current = await yieldDomainWorkClaim({ db: dbB, item: takeover.items[0], ownerToken: takeover.ownerToken, availableAt: new Date(Date.now() + 60_000) });
    assert.equal(current.yielded, true);

    await withPhase3PostgresFixtureAuthority(dbA, (tx) => tx.creatorAccount.update({ where: { id: scope.creatorId }, data: { status: "DRAFT" } }));
    let work = await dbA.domainWorkItem.findFirst({ where: { workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, creatorId: scope.creatorId } });
    assert.equal(work?.isOutstanding, false);
    assert.equal(work?.state, "DONE");
    await withPhase3PostgresFixtureAuthority(dbA, (tx) => tx.creatorAccount.update({ where: { id: scope.creatorId }, data: { status: "READY" } }));
    work = await dbA.domainWorkItem.findFirst({ where: { workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, creatorId: scope.creatorId } });
    assert.equal(work?.isOutstanding, true);
    assert.equal(work?.state, "READY");
    await withPhase3PostgresFixtureAuthority(dbA, async (tx) => {
      await tx.creatorAccount.delete({ where: { id: scope.creatorId } });
    });
    assert.equal(await dbA.creatorAccount.count({ where: { id: scope.creatorId } }), 0);
    assert.equal(await dbA.domainWorkItem.count({
      where: {
        agencyId: scope.agencyId,
        workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
        objectType: "CreatorAccount",
        objectId: scope.creatorId,
      },
    }), 0);
    console.log("# A35_CREATOR_RECURRING_PHYSICAL_DELETE_PASS");
    console.log("# A34_RECURRING_PLANNING_RESTART_LIFECYCLE_PASS");
  } finally {
    await cleanupPhase3PostgresAgencyFixture(dbA, scope.agencyId);
    await dbA.$disconnect();
    await dbB.$disconnect();
  }
});

test("A37-R2 PostgreSQL: stale sorted Agency and shard candidates cannot survive a concurrent reservation", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const observer = new PrismaClient();
  const scopes = [];
  try {
    for (const level of ["agency", "shard"]) {
      const scope = await createAgencyCreator(dbA, `a37-cas-${level}`);
      const peer = await createAgencyCreator(dbA, `a37-cas-${level}-peer`);
      scopes.push(scope, peer);
      const klass = nonce("A37_FAIR_DISPATCH");
      const partitions = await dbA.$queryRawUnsafe(
        `SELECT DISTINCT ON ("phase3_domain_work_claim_shard"(g::text))
                g::text AS key,"phase3_domain_work_claim_shard"(g::text) AS shard
           FROM generate_series(1,128) g
          ORDER BY "phase3_domain_work_claim_shard"(g::text),g LIMIT 2`);
      assert.equal(partitions.length, 2);
      for (const [index, row] of partitions.entries()) {
        await publishDomainWork({ db: dbA, agencyId: scope.agencyId, workClass: klass,
          objectType: "FairProbe", objectId: `${klass}-${index}`, partitionKey: row.key });
      }
      await publishDomainWork({ db: dbA, agencyId: peer.agencyId, workClass: klass,
        objectType: "FairProbe", objectId: `${klass}-peer`, partitionKey: "peer" });
      const table = level === "agency" ? "DomainWorkClaimAgencyState" : "DomainWorkClaimShardState";
      const initial = level === "agency"
        ? await dbA.domainWorkClaimAgencyState.findFirst({ where: { workClass: klass }, orderBy: [{ nextDispatchAt: "asc" }, { revision: "asc" }, { agencyId: "asc" }] })
        : await dbA.domainWorkClaimShardState.findFirst({ where: { workClass: klass, agencyId: scope.agencyId }, orderBy: [{ nextDispatchAt: "asc" }, { revision: "asc" }, { claimShard: "asc" }] });
      assert.ok(initial);
      const lockKey = `${klass}-snapshot-barrier`;
      let holderPid;
      let waiterPid;
      let admissionClock;
      let result;
      let intercepted = false;
      await runPhase3InterleavedTransactions({
        dbA, dbB,
        firstA: async (tx) => {
          [{ pid: holderPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
          await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', lockKey);
        },
        firstB: async (tx) => { [{ pid: waiterPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'); },
        secondA: async (tx) => {
          await waitForPhase3PostgresBlock({ db: observer, holderPid, waiterPid });
          // Reproduce a peer publishing its pre-sampled clock. The new row is
          // still due for the waiting SELECT, but no longer owns its old place.
          await tx.$executeRawUnsafe(`UPDATE "${table}" SET "revision"="revision"+1,
            "nextDispatchAt"=$2,"lastSelectedAt"=$2 WHERE "id"=$1`, initial.id, admissionClock);
        },
        secondB: async (tx) => {
          const wrapped = new Proxy(tx, { get(target, key) {
            if (key === "$queryRawUnsafe") return async (sql, ...params) => {
              if (!intercepted && sql.includes("WITH observed AS MATERIALIZED") && sql.includes(`UPDATE "${table}"`)) {
                intercepted = true;
                admissionClock = params[1];
                // Test-only barrier inside the production query, after the
                // materialized snapshot and before locking the candidate.
                const parameter = `$${params.length + 1}`;
                sql = sql.replace("), candidate AS MATERIALIZED (", `), paused AS MATERIALIZED (
                  SELECT pg_advisory_xact_lock(hashtext(${parameter})) FROM observed LIMIT 1
                ), candidate AS MATERIALIZED (`).replace("FROM observed o JOIN", "FROM observed o CROSS JOIN paused JOIN");
                params.push(lockKey);
              }
              return target.$queryRawUnsafe(sql, ...params);
            };
            const value = target[key];
            return typeof value === "function" ? value.bind(target) : value;
          } });
          // Reuse the helper's real transaction for this single-query race.
          // No production callback/hook is introduced by the proof.
          const root = new Proxy(wrapped, { get(target, key) {
            return key === "$transaction" ? (work) => work(wrapped) : target[key];
          } });
          result = await claimDomainWorkBatch({ db: root, workClass: klass,
            ...(level === "shard" ? { agencyId: scope.agencyId } : {}),
            ownerToken: `${klass}-waiter`, limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1 });
        },
      });
      assert.equal(intercepted, true);
      assert.equal(result.items.length, 1);
      if (level === "agency") assert.notEqual(result.items[0].agencyId, initial.agencyId);
      else {
        const [chosen] = await dbA.$queryRawUnsafe('SELECT "phase3_domain_work_claim_shard"($1) AS shard', result.items[0].partitionKey);
        assert.notEqual(chosen.shard, initial.claimShard);
      }
    }
    console.log("# A37_DISPATCH_STALE_SNAPSHOT_CAS_PASS");
  } finally {
    try { for (const scope of scopes) await cleanupPhase3PostgresAgencyFixture(dbA, scope.agencyId); }
    finally { await Promise.allSettled([dbA.$disconnect(), dbB.$disconnect(), observer.$disconnect()]); }
  }
});

test("A37-R2 PostgreSQL: reconciliation cannot rewind partition shard or Agency dispatch watermarks", { skip: !enabled, timeout: 60_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  let scope;
  try {
    scope = await createAgencyCreator(db, "a37-watermark", { status: "READY" });
    const klass = WORK_CLASS.CREATOR_RECURRING_PLANNING;
    const partition = await db.phase2WorkBroadClaimPartitionState.findUnique({ where: { agencyId_workClass_partitionKey: {
      agencyId: scope.agencyId, workClass: klass, partitionKey: scope.creatorId,
    } } });
    assert.ok(partition);
    const [clock] = await db.$queryRawUnsafe('SELECT clock_timestamp() AS now');
    const selected = new Date(clock.now.getTime() + 1000);
    const generation = partition.activeGeneration;
    for (const touched of [selected, clock.now, null]) {
      await db.$queryRawUnsafe('SELECT "phase3_reconcile_domain_work_claim_partition"($1,$2,$3,$4,$5::timestamptz)', scope.agencyId, klass, generation, scope.creatorId, touched);
      await db.$queryRawUnsafe('SELECT "phase3_reconcile_domain_work_claim_shard"($1,$2,$3,$4,$5::timestamptz)', scope.agencyId, klass, generation, partition.claimShard, touched);
      await db.$queryRawUnsafe('SELECT "phase3_reconcile_domain_work_claim_agency"($1,$2,$3,$4::timestamptz)', scope.agencyId, klass, generation, touched);
      const p = await db.phase2WorkBroadClaimPartitionState.findUnique({ where: { id: partition.id } });
      const s = await db.domainWorkClaimShardState.findFirst({ where: { agencyId: scope.agencyId, workClass: klass, claimShard: partition.claimShard } });
      const a = await db.domainWorkClaimAgencyState.findFirst({ where: { agencyId: scope.agencyId, workClass: klass } });
      for (const [dispatch, watermark] of [[p.nextClaimableAt, p.lastClaimedAt], [s.nextDispatchAt, s.lastSelectedAt], [a.nextDispatchAt, a.lastSelectedAt]]) {
        assert.equal(dispatch.getTime(), selected.getTime());
        assert.equal(watermark.getTime(), selected.getTime());
      }
    }
    console.log("# A37_DISPATCH_MONOTONIC_RECONCILIATION_PASS");
  } finally {
    try { if (scope) await cleanupPhase3PostgresAgencyFixture(db, scope.agencyId); }
    finally { await db.$disconnect(); }
  }
});

test("A37-R2 PostgreSQL: all six claim settlements reject expiry after an observed work-row wait", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const authority = require("./domain-work-authority-service");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const observer = new PrismaClient();
  let scope;
  try {
    scope = await createAgencyCreator(dbA, "a37-settlement-wait", { status: "READY" });
    const claim = await claimDomainWorkBatch({ db: dbA, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
      agencyId: scope.agencyId, creatorIds: [scope.creatorId], limit: 1, leaseMs: 60_000 });
    assert.equal(claim.items.length, 1);
    const item = claim.items[0];
    for (const [name, field] of [["heartbeatDomainWorkClaim", "renewed"], ["ackDomainWorkClaim", "acknowledged"],
      ["blockDomainWorkClaim", "blocked"], ["failDomainWorkClaim", "failed"],
      ["saveDomainWorkProgress", "saved"], ["yieldDomainWorkClaim", "yielded"]]) {
      await dbA.$executeRawUnsafe('UPDATE "DomainWorkItem" SET "leaseUntil"=clock_timestamp() + interval \'1 minute\' WHERE "id"=$1', item.id);
      let holderPid;
      let waiterPid;
      let outcome;
      await runPhase3InterleavedTransactions({
        dbA, dbB,
        firstA: async (tx) => {
          [{ pid: holderPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
          await tx.$queryRawUnsafe('SELECT "id" FROM "DomainWorkItem" WHERE "id"=$1 FOR UPDATE', item.id);
        },
        firstB: async (tx) => { [{ pid: waiterPid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'); },
        secondA: async (tx) => {
          await waitForPhase3PostgresBlock({ db: observer, holderPid, waiterPid });
          const [row] = await tx.$queryRawUnsafe('UPDATE "DomainWorkItem" SET "leaseUntil"=clock_timestamp() + interval \'100 milliseconds\' WHERE "id"=$1 RETURNING "leaseUntil" AS deadline', item.id);
          await waitUntilPhase3DatabaseTime(tx, row.deadline);
        },
        secondB: async (tx) => {
          outcome = await authority[name]({ db: tx, item, ownerToken: claim.ownerToken,
            dependencyKind: "A37_WAIT", dependencyKey: item.id, progressCursor: { forbidden: true } });
        },
      });
      assert.equal(outcome[field], false, name);
      assert.equal(outcome.lost, true, name);
      const current = await dbA.domainWorkItem.findUnique({ where: { id: item.id } });
      assert.equal(current.state, "CLAIMED", name);
      assert.equal(current.ownerToken, claim.ownerToken, name);
      assert.equal(current.completedRevision, item.completedRevision, name);
      assert.equal(current.progressCursor, null, name);
      assert.equal(current.nextAttemptAt, null, name);
    }
    console.log("# A37_ALL_SETTLEMENTS_OBSERVED_WAIT_EXPIRY_PASS");
  } finally {
    try { if (scope) await cleanupPhase3PostgresAgencyFixture(dbA, scope.agencyId); }
    finally { await Promise.allSettled([dbA.$disconnect(), dbB.$disconnect(), observer.$disconnect()]); }
  }
});

test("Phase3 closure PostgreSQL: revision-local failure budget survives restart and exact repair cannot overwrite new work", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const work = require("./domain-work-authority-service");
  const { resumeDomainWorkAfterRepair } = require("./domain-work-repair-service");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  let scope;
  try {
    scope = await createAgencyCreator(dbA, "phase3-failure-policy");
    const identity = { ...scope, workClass: work.WORK_CLASS.RETENTION, objectType: "FailurePolicyProof", objectId: "one", partitionKey: scope.creatorId };
    const published = await work.publishDomainWork({ db: dbA, ...identity });
    await dbA.domainWorkItem.update({ where: { id: published.id }, data: { attempts: 9000 } });
    for (let failure = 1; failure <= 8; failure += 1) {
      const db = failure % 2 ? dbA : dbB;
      const claim = await work.claimDomainWorkBatch({ db, agencyId: scope.agencyId, workClass: identity.workClass, objectIds: ["one"], limit: 1 });
      assert.equal(claim.items.length, 1);
      const failed = await work.failDomainWorkClaim({ db, item: claim.items[0], error: Object.assign(new Error("network unavailable"), { code: "ECONNRESET" }) });
      assert.equal(failed.consecutiveFailures, failure);
      assert.equal(failed.state, failure === 8 ? "RECONCILE_REQUIRED" : "READY");
      if (failure < 8) await db.$executeRawUnsafe('UPDATE "DomainWorkItem" SET "availableAt"=clock_timestamp(),"nextAttemptAt"=NULL WHERE "id"=$1', published.id);
    }
    assert.equal((await work.claimDomainWorkBatch({ db: dbB, agencyId: scope.agencyId, workClass: identity.workClass, limit: 1 })).items.length, 0);
    const row = await dbB.domainWorkItem.findUnique({ where: { id: published.id } });
    assert.equal(row.isOutstanding, true);
    assert.equal(row.terminalCause, "RETRY_EXHAUSTED:ECONNRESET");
    await work.publishDomainWork({ db: dbB, ...identity, objectId: "healthy-neighbor" });
    const neighbor = (await work.claimDomainWorkBatch({ db: dbB, agencyId: scope.agencyId, workClass: identity.workClass, limit: 1 })).items[0];
    assert.equal(neighbor.objectId, "healthy-neighbor", "quarantined work must not obstruct a healthy identity in the same family/partition");
    assert.equal((await work.ackDomainWorkClaim({ db: dbB, item: neighbor })).acknowledged, true);
    const repair = { db: dbB, agencyId: scope.agencyId, workId: published.id, expectedRevision: "1", reason: "verified repair" };
    assert.equal((await resumeDomainWorkAfterRepair({ ...repair, agencyId: "other-agency" })).resumed, false);
    assert.equal((await resumeDomainWorkAfterRepair({ ...repair, expectedRevision: "2" })).resumed, false);
    assert.equal((await resumeDomainWorkAfterRepair(repair)).requestedRevision, "2");
    assert.equal((await resumeDomainWorkAfterRepair(repair)).resumed, false);
    const current = (await work.claimDomainWorkBatch({ db: dbA, agencyId: scope.agencyId, workClass: identity.workClass, limit: 1 })).items[0];
    assert.equal(current.consecutiveFailures, 0);
    await work.publishDomainWork({ db: dbB, ...identity });
    assert.equal((await work.failDomainWorkClaim({ db: dbA, item: current, error: new TypeError("old poison") })).superseded, true);
    const after = await dbB.domainWorkItem.findUnique({ where: { id: published.id } });
    assert.equal(after.requestedRevision, 3n);
    assert.equal(after.state, "READY");
    assert.equal(after.consecutiveFailures, 0);
    assert.equal(after.lastRepair.reason, "verified repair");
  } finally {
    try { if (scope) await cleanupPhase3PostgresAgencyFixture(dbA, scope.agencyId); }
    finally { await Promise.allSettled([dbA.$disconnect(), dbB.$disconnect()]); }
  }
});

test("Phase3 closure PostgreSQL: v5 acquisition and release downgrade are fenced while existing ownership drains", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const work = require("./domain-work-authority-service");
  const { DOMAIN_WORK_EXECUTOR_GENERATION } = require("./phase2-release-compatibility-authority-service");
  const db = new PrismaClient();
  let scope;
  try {
    scope = await createAgencyCreator(db, "phase3-executor-v6");
    const row = await work.publishDomainWork({ db, ...scope, workClass: work.WORK_CLASS.RETENTION,
      objectType: "ReleaseProof", objectId: "one", partitionKey: scope.creatorId });
    const rejected = (error) => error?.meta?.code === "55000" || /INCOMPATIBLE_DOMAIN_EXECUTOR|DOWNGRADE_FORBIDDEN/.test(String(error?.message));
    await assert.rejects(() => db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe("SELECT set_config('onlinod.phase2_domain_executor_generation','phase3_domain_executor_v5_a36_claim_topology',true)");
      await tx.$executeRawUnsafe(`UPDATE "DomainWorkItem" SET "state"='CLAIMED',"ownerToken"='old-worker',"claimFence"="claimFence"+1,
        "claimedRevision"="requestedRevision","leaseUntil"=clock_timestamp()+interval '1 minute' WHERE "id"=$1`, row.id);
    }), rejected);
    await assert.rejects(() => db.$executeRawUnsafe(`UPDATE "Phase2ReleaseCompatibilityAuthority"
      SET "requiredGeneration"='phase3_domain_executor_v5_a36_claim_topology' WHERE "scope"='DOMAIN_WORK_EXECUTOR'`), rejected);
    const claim = await work.claimDomainWorkBatch({ db, agencyId: scope.agencyId, workClass: work.WORK_CLASS.RETENTION, limit: 1 });
    assert.equal(claim.items[0].claimExecutionGeneration, DOMAIN_WORK_EXECUTOR_GENERATION);
    // Represent an already-held pre-cutover claim, without reopening acquisition.
    await db.domainWorkItem.update({ where: { id: row.id }, data: { claimExecutionGeneration: "phase3_domain_executor_v5_a36_claim_topology" } });
    assert.equal((await work.legacyExecutorDrainStatus({ db, workClass: work.WORK_CLASS.RETENTION })).ready, false);
    // Old settlement shape remains legal. It has no right to acquire again.
    await db.$executeRawUnsafe(`UPDATE "DomainWorkItem" SET "state"='DONE',"isOutstanding"=FALSE,"completedRevision"="claimedRevision",
      "ownerToken"=NULL,"leaseUntil"=clock_timestamp() WHERE "id"=$1 AND "ownerToken"=$2 AND "claimFence"=$3`, row.id, claim.ownerToken, claim.items[0].claimFence);
    assert.equal((await work.legacyExecutorDrainStatus({ db, workClass: work.WORK_CLASS.RETENTION })).ready, true);
  } finally {
    try { if (scope) await cleanupPhase3PostgresAgencyFixture(db, scope.agencyId); }
    finally { await db.$disconnect(); }
  }
});

test("Phase3 closure PostgreSQL: cohort cursor is bounded tenant-scoped restartable and follows current hidden eligibility", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const { readSubscriberConsumerPage } = require("./fan-consumer-cursor-service");
  const { projectFanObservationBatch } = require("./fan-data-authority-service");
  const { readFanCurrentMap, validateBumpCurrentRelationship } = require("./fan-current-consumer-service");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  let scope;
  let other;
  try {
    scope = await createAgencyCreator(dbA, "phase3-cohort-current");
    other = await createAgencyCreator(dbA, "phase3-cohort-other");
    await seedHiddenSnapshot(dbA, scope, ["8001", "8002", "8003"]);
    await seedHiddenSnapshot(dbA, other, ["8001"]);
    const runId = `${scope.creatorId}-hidden-run`;
    const read = (db, publication = runId) => db.$transaction((tx) => readSubscriberConsumerPage({ db: tx, ...scope, runId: publication, consumerKey: "bumps:hidden_online", limit: 2 }));
    const first = await read(dbA);
    const cursorBefore = await dbA.fanConsumerCursor.findUnique({ where: { creatorId_consumerKey: { creatorId: scope.creatorId, consumerKey: "bumps:hidden_online" } } });
    await assert.rejects(() => dbA.$transaction(async (tx) => {
      await readSubscriberConsumerPage({ db: tx, ...scope, runId, consumerKey: "bumps:hidden_online", limit: 2 });
      throw new Error("planner failed after cursor advance");
    }), /planner failed after cursor advance/);
    assert.deepEqual(await dbA.fanConsumerCursor.findUnique({ where: { creatorId_consumerKey: { creatorId: scope.creatorId, consumerKey: "bumps:hidden_online" } } }), cursorBefore);
    const nextRunId = `${runId}-replacement`;
    await dbA.subscriberScanRun.create({ data: { ...scope, id: nextRunId, status: "PUBLISHED", hasMore: false,
      fanProjectionStatus: "COMPLETE", publicationStatus: "COMPLETE", publicationGeneration: 2,
      publishedAt: new Date(), completedAt: new Date() } });
    await dbA.subscriberScanItem.createMany({ data: ["8001", "8002", "8003"].map((fanId) => ({
      ...scope, runId: nextRunId, fanId, contentHash: `${nextRunId}-${fanId}`, metadata: {},
    })) });
    await dbA.subscriberDirectoryState.update({ where: { creatorId: scope.creatorId }, data: {
      currentRunId: nextRunId, previousRunId: runId, publicationGeneration: 2, publishedGeneration: 2,
    } });
    const second = await read(dbB, nextRunId);
    assert.equal(first.length, 2);
    assert.equal(second.length, 1);
    assert.equal(new Set([...first, ...second].map((row) => row.fanId)).size, 3);
    assert.equal(second[0].fanId, "8003", "a new publication cannot rewind a stable fan cursor");
    const observedAt = new Date();
    await dbA.$transaction((tx) => projectFanObservationBatch(tx, { ...scope,
      receivedAt: observedAt, causalObservedAt: observedAt, observedAtPolicy: "SERVER_GENERATION", allowedSources: ["USER_PROFILE"],
      items: [{ onlyFansUserId: "8001", relationship: { source: "USER_PROFILE", canReceiveChatMessage: true, lastSeenAt: observedAt.toISOString() } }],
    }));
    const current = (await readFanCurrentMap(dbB, { ...scope, fanIds: ["8001"] })).get("8001");
    assert.equal(validateBumpCurrentRelationship({ candidate: { fanId: "8001", metadata: { lastSeenIsNull: true } }, current, source: "hidden_online" }).code, "fan_not_hidden_current");
    assert.equal((await readFanCurrentMap(dbB, { ...other, fanIds: ["8001"] })).size, 0);
    assert.equal(await dbA.fanConsumerCursor.count({ where: { agencyId: other.agencyId } }), 0);
  } finally {
    try {
      if (scope) await cleanupPhase3PostgresAgencyFixture(dbA, scope.agencyId);
      if (other) await cleanupPhase3PostgresAgencyFixture(dbA, other.agencyId);
    } finally { await Promise.allSettled([dbA.$disconnect(), dbB.$disconnect()]); }
  }
});

test("Phase3 closure PostgreSQL: old fan consumer cannot mint a write permit and transaction-local proof cannot leak", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  let scope;
  try {
    scope = await createAgencyCreator(db, "phase3-fan-commit-release");
    const row = await db.automationDelivery.create({ data: {
      ...scope, originKind: "AUTOMATION", moduleKey: "bumps", actionType: "SEND_MESSAGE", status: "RUNNING",
    } });
    const rejectOld = (error) => error?.meta?.code === "55000" || String(error?.message).includes("PHASE3_INCOMPATIBLE_FAN_CONSUMER_COMMIT");
    const commit = (tx) => tx.automationDelivery.update({ where: { id: row.id }, data: { status: "COMMITTING", writeCommitRevision: { increment: 1 }, writeCommitAt: new Date() } });
    await assert.rejects(() => commit(db), rejectOld);
    assert.equal((await db.automationDelivery.findUnique({ where: { id: row.id } })).status, "RUNNING");
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase3_fan_consumer_generation','phase3_fan_consumer_v1_current_bounded',true)");
      await commit(tx);
    });
    // No proof in this transaction: even COMMITTING cannot remint a revision.
    await assert.rejects(() => commit(db), rejectOld);
    await db.automationDelivery.update({ where: { id: row.id }, data: { status: "RECONCILE_REQUIRED" } });
    await db.automationDelivery.update({ where: { id: row.id }, data: { status: "COMPLETED", finishedAt: new Date() } });
    assert.equal((await db.automationDelivery.findUnique({ where: { id: row.id } })).writeCommitRevision, 1);
    const [{ setting }] = await db.$queryRawUnsafe("SELECT current_setting('onlinod.phase3_fan_consumer_generation',true) AS setting");
    assert.notEqual(setting, "phase3_fan_consumer_v1_current_bounded");
  } finally {
    try { if (scope) await cleanupPhase3PostgresAgencyFixture(db, scope.agencyId); }
    finally { await db.$disconnect(); }
  }
});
