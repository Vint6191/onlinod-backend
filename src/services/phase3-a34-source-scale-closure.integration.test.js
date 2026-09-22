"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const {
  withPhase3PostgresFixtureAuthority,
  cleanupPhase3PostgresAgencyFixture,
} = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");

let setHiddenOnlineStatus;
let claimDomainWorkBatch;
let yieldDomainWorkClaim;
let WORK_CLASS;

if (enabled) {
  ({ setHiddenOnlineStatus } = require("./subscriber-directory-service"));
  ({ claimDomainWorkBatch, yieldDomainWorkClaim, WORK_CLASS } = require("./domain-work-authority-service"));
}

function nonce(prefix) {
  return `${prefix}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
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
    const attempts = await dbA.domainWorkItem.groupBy({
      by: ["attempts"],
      where: { workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING, creatorId: { startsWith: `${prefix}-creator-` }, attempts: { gt: 0 } },
      _count: { _all: true },
    });
    assert.deepEqual(attempts.map((row) => ({ attempts: row.attempts, count: row._count._all })), [{ attempts: 1, count: 200 }]);
    console.log("# A34_4000_CREATOR_TWO_REPLICA_BOUNDED_PASS");
  } finally {
    for (const agencyId of agencyIds) await cleanupPhase3PostgresAgencyFixture(dbA, agencyId);
    await dbA.$disconnect();
    await dbB.$disconnect();
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
    console.log("# A34_RECURRING_PLANNING_RESTART_LIFECYCLE_PASS");
  } finally {
    await cleanupPhase3PostgresAgencyFixture(dbA, scope.agencyId);
    await dbA.$disconnect();
    await dbB.$disconnect();
  }
});
