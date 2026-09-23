"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const {
  pinPhase3AuditSchema,
  withPhase3PostgresFixtureAuthority,
  cleanupPhase3PostgresAgencyFixture,
} = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");
const {
  TOPOLOGY_ID: DOMAIN_WORK_CLAIM_TOPOLOGY_ID,
  activateTopology: activateDomainWorkClaimTopology,
} = require("../../scripts/database/phase3-domain-work-claim-online-rollout");
const release = require("./phase2-release-compatibility-authority-service");

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
    ));
    await withTeamGeneration(dbA, (tx) => tx.agencyMember.create({
      data: {
        id: memberId, agencyId, userId, role: "CHATTER", roleKey: "chatter",
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
    assert.equal(claimA.items.length, 25);
    assert.equal(claimB.items.length, 25);
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
    await cleanupPhase3PostgresAgencyFixture(dbA, agencyId).catch(() => null);
    await dbA.user.deleteMany({ where: { id: userId } }).catch(() => null);
    await dbA.$disconnect();
    await dbB.$disconnect();
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
    await cleanupPhase3PostgresAgencyFixture(db, scope.agencyId).catch(() => null);
    await db.$disconnect();
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
          requiredGeneration: release.DOMAIN_WORK_PRE_A36_EXECUTOR_GENERATION,
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
    const [claimA, claimB] = await Promise.all([
      claimDomainWorkBatch({
        db: dbA, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
        ownerToken: `${prefix}-replica-a`, limit: 50, perAgencyQuantum: 1,
        perPartitionQuantum: 1, leaseMs: 120_000,
      }),
      claimDomainWorkBatch({
        db: dbB, workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
        ownerToken: `${prefix}-replica-b`, limit: 50, perAgencyQuantum: 1,
        perPartitionQuantum: 1, leaseMs: 120_000,
      }),
    ]);
    const idsA = new Set(claimA.items.map((item) => item.id));
    const idsB = new Set(claimB.items.map((item) => item.id));
    const agenciesA = new Set(claimA.items.map((item) => item.agencyId));
    const agenciesB = new Set(claimB.items.map((item) => item.agencyId));
    const allAgencies = new Set([...agenciesA, ...agenciesB]);
    assert.equal(claimA.items.length, 50);
    assert.equal(claimB.items.length, 50);
    assert.equal([...idsA].filter((id) => idsB.has(id)).length, 0);
    assert.equal(agenciesA.size, 50);
    assert.equal(agenciesB.size, 50);
    assert.equal(allAgencies.size, 100);
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
    assert.deepEqual(attempts.map((row) => ({ attempts: row.attempts, count: row._count._all })), [{ attempts: 1, count: 100 }]);
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

    let releaseFirstWrite;
    const firstWriteCommittedToTransaction = new Promise((resolve) => { releaseFirstWrite = resolve; });
    const publish = (tx, objectId, partitionKey) => publishDomainWork({
      db: tx,
      agencyId,
      workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
      objectType: "A36DeferredLocatorProbe",
      objectId,
      partitionKey,
      availableAt: new Date(),
    });

    const transactionA = dbA.$transaction(async (tx) => {
      await pinPhase3AuditSchema(tx);
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
      await publish(tx, `${prefix}-a-one`, shardOne[0]);
      releaseFirstWrite();
      await tx.$queryRawUnsafe("SELECT pg_sleep(0.5)");
      await publish(tx, `${prefix}-a-two`, shardTwo[0]);
    }, { maxWait: 10_000, timeout: 30_000 });

    await firstWriteCommittedToTransaction;
    const transactionB = dbB.$transaction(async (tx) => {
      await pinPhase3AuditSchema(tx);
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
      await publish(tx, `${prefix}-b-two`, shardTwo[1]);
      await publish(tx, `${prefix}-b-one`, shardOne[1]);
    }, { maxWait: 10_000, timeout: 30_000 });

    await Promise.all([transactionA, transactionB]);
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
    await cleanupPhase3PostgresAgencyFixture(dbA, agencyId);
    await dbA.$disconnect();
    await dbB.$disconnect();
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
    let releaseFirstWrite;
    const firstWriteVisible = new Promise((resolve) => { releaseFirstWrite = resolve; });
    const publish = (tx, objectId, partitionKey) => publishDomainWork({
      db: tx,
      agencyId,
      workClass: WORK_CLASS.CREATOR_RECURRING_PLANNING,
      objectType: "A36ExactPartitionOrderProbe",
      objectId,
      partitionKey,
      availableAt: new Date(),
    });

    const transactionA = dbA.$transaction(async (tx) => {
      await pinPhase3AuditSchema(tx);
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
      await publish(tx, `${prefix}-a-p1`, p1);
      releaseFirstWrite();
      await tx.$queryRawUnsafe("SELECT pg_sleep(0.5)");
      await publish(tx, `${prefix}-a-p2`, p2);
    }, { maxWait: 10_000, timeout: 30_000 });

    await firstWriteVisible;
    const transactionB = dbB.$transaction(async (tx) => {
      await pinPhase3AuditSchema(tx);
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
      await publish(tx, `${prefix}-b-p2`, p2);
      await publish(tx, `${prefix}-b-p1`, p1);
    }, { maxWait: 10_000, timeout: 30_000 });

    await Promise.all([transactionA, transactionB]);
    assert.equal(await dbA.domainWorkItem.count({
      where: { agencyId, objectType: "A36ExactPartitionOrderProbe" },
    }), 4);
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
    await cleanupPhase3PostgresAgencyFixture(dbA, agencyId);
    await dbA.$disconnect();
    await dbB.$disconnect();
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
      await tx.$queryRawUnsafe(
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
    await cleanupPhase3PostgresAgencyFixture(db, scope.agencyId).catch(() => null);
    await db.$disconnect();
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
