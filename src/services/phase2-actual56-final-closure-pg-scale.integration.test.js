"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";

function token(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bounded(promise, label, ms = 10_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withClients(count, run) {
  const { PrismaClient } = require("@prisma/client");
  const clients = Array.from({ length: count }, () => new PrismaClient());
  try {
    return await run(...clients);
  } finally {
    await Promise.allSettled(clients.map((client) => client.$disconnect()));
  }
}

async function cleanupAgency(db, agencyId, userIds = []) {
  const work = require("./domain-work-authority-service");
  try {
    await work.publishDomainWork({
      db,
      agencyId,
      workClass: work.WORK_CLASS.DESTRUCTIVE_AGENCY_CLEANUP,
      objectType: "Phase2AgencyDestructiveCleanup",
      objectId: agencyId,
      partitionKey: agencyId,
      availableAt: new Date(Date.now() - 1_000),
    });
    await db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_destructive_agency_id',$1,true) AS value`, agencyId);
      await tx.agency.delete({ where: { id: agencyId } });
    });
  } catch (_) {
    // Disposable integration DB: cleanup must never hide the closure assertion.
  }
  if (userIds.length) {
    try { await db.user.deleteMany({ where: { id: { in: userIds } } }); } catch (_) {}
  }
}

async function projectionRow(db, agencyId, workClass, partitionKey) {
  const rows = await db.$queryRawUnsafe(
    `SELECT "outstandingCount","activeGeneration" FROM "Phase2WorkBroadClaimPartitionState"
      WHERE "agencyId"=$1 AND "workClass"=$2 AND "partitionKey"=$3`,
    agencyId, workClass, partitionKey,
  );
  return rows?.[0] || null;
}

test("C1 PostgreSQL: concurrent final settlements conserve current partition membership", { skip: !enabled }, async () => {
  const work = require("./domain-work-authority-service");
  await withClients(2, async (left, right) => {
    const agencyId = token("c1_agency");
    const partitionKey = token("c1_partition");
    const workClass = work.WORK_CLASS.DEPENDENCY_FANOUT;
    const generation = await work.activeDomainWorkGeneration({ db: left, workClass });
    const releaseLeft = deferred();
    const leftSettled = deferred();
    let rightFinished = false;
    try {
      await left.agency.create({ data: { id: agencyId, name: agencyId } });
      const a = await work.publishDomainWork({ db: left, agencyId, workClass, objectType: "C1Conservation", objectId: token("a"), partitionKey, activeGeneration: generation });
      const b = await work.publishDomainWork({ db: left, agencyId, workClass, objectType: "C1Conservation", objectId: token("b"), partitionKey, activeGeneration: generation });
      assert.equal(Number((await projectionRow(left, agencyId, workClass, partitionKey))?.outstandingCount), 2);

      const t1 = left.$transaction(async (tx) => {
        await tx.domainWorkItem.update({ where: { id: a.id }, data: { state: "DONE", isOutstanding: false } });
        leftSettled.resolve();
        await releaseLeft.promise;
      });
      await leftSettled.promise;
      const t2 = right.$transaction(async (tx) => {
        await tx.domainWorkItem.update({ where: { id: b.id }, data: { state: "DONE", isOutstanding: false } });
        rightFinished = true;
      });
      await delay(125);
      assert.equal(rightFinished, false, "second final settlement must serialize on the partition fence");
      releaseLeft.resolve();
      await bounded(Promise.all([t1, t2]), "C1 concurrent final settlement");

      assert.equal(await left.domainWorkItem.count({ where: { agencyId, workClass, partitionKey, isOutstanding: true } }), 0);
      assert.equal(await projectionRow(left, agencyId, workClass, partitionKey), null);
    } finally {
      releaseLeft.resolve();
      await cleanupAgency(left, agencyId);
    }
  });
});

test("C1 PostgreSQL: settle-vs-republish and delete-vs-settle end exactly at physical truth", { skip: !enabled }, async () => {
  const work = require("./domain-work-authority-service");
  await withClients(2, async (left, right) => {
    const agencyId = token("c1_mix_agency");
    const partitionKey = token("c1_mix_partition");
    const workClass = work.WORK_CLASS.DEPENDENCY_FANOUT;
    const generation = await work.activeDomainWorkGeneration({ db: left, workClass });
    const releaseSettle = deferred();
    const settled = deferred();
    try {
      await left.agency.create({ data: { id: agencyId, name: agencyId } });
      const objectId = token("republish");
      const item = await work.publishDomainWork({ db: left, agencyId, workClass, objectType: "C1Republish", objectId, partitionKey, activeGeneration: generation });

      const settle = left.$transaction(async (tx) => {
        await tx.domainWorkItem.update({ where: { id: item.id }, data: { state: "DONE", isOutstanding: false } });
        settled.resolve();
        await releaseSettle.promise;
      });
      await settled.promise;
      let republished = false;
      const republish = work.publishDomainWork({ db: right, agencyId, workClass, objectType: "C1Republish", objectId, partitionKey, activeGeneration: generation })
        .then((row) => { republished = true; return row; });
      await delay(125);
      assert.equal(republished, false, "republish of the same DWI must wait for its settling transaction");
      releaseSettle.resolve();
      await bounded(Promise.all([settle, republish]), "C1 settle vs republish");
      assert.equal(await left.domainWorkItem.count({ where: { agencyId, workClass, partitionKey, isOutstanding: true } }), 1);
      assert.equal(Number((await projectionRow(left, agencyId, workClass, partitionKey))?.outstandingCount), 1);

      const c = await work.publishDomainWork({ db: left, agencyId, workClass, objectType: "C1DeleteSettle", objectId: token("c"), partitionKey, activeGeneration: generation });
      assert.equal(Number((await projectionRow(left, agencyId, workClass, partitionKey))?.outstandingCount), 2);
      await bounded(Promise.all([
        left.$transaction((tx) => tx.domainWorkItem.delete({ where: { id: item.id } })),
        right.$transaction((tx) => tx.domainWorkItem.update({ where: { id: c.id }, data: { state: "DONE", isOutstanding: false } })),
      ]), "C1 delete vs settle");
      assert.equal(await left.domainWorkItem.count({ where: { agencyId, workClass, partitionKey, isOutstanding: true } }), 0);
      assert.equal(await projectionRow(left, agencyId, workClass, partitionKey), null);
    } finally {
      releaseSettle.resolve();
      await cleanupAgency(left, agencyId);
    }
  });
});

test("C3/C4 PostgreSQL: operational owner filtering is complete beyond 500 global rows and follows live User/Creator state", { skip: !enabled }, async () => {
  const release = require("./phase2-release-compatibility-authority-service");
  const { listTeamPendingDialogs } = require("./team-pending-read-service");
  await withClients(1, async (db) => {
    const agencyId = token("pending_agency");
    const creatorId = token("pending_creator");
    const userA = token("pending_user_a");
    const userB = token("pending_user_b");
    const memberA = token("pending_member_a");
    const memberB = token("pending_member_b");
    const userIds = [userA, userB];
    try {
      await db.agency.create({ data: { id: agencyId, name: agencyId } });
      await db.user.createMany({ data: [
        { id: userA, email: `${userA}@example.test`, passwordHash: "integration" },
        { id: userB, email: `${userB}@example.test`, passwordHash: "integration" },
      ] });
      await db.agencyMember.createMany({ data: [
        { id: memberA, agencyId, userId: userA, role: "OWNER", roleKey: "owner", assignedCreators: "all" },
        { id: memberB, agencyId, userId: userB, role: "MANAGER", roleKey: "manager", assignedCreators: "all" },
      ] });
      await release.runCreatorAccountWriteTransaction(db, (tx) => tx.creatorAccount.create({
        data: { id: creatorId, agencyId, displayName: creatorId, username: token("pending_username") },
      }));

      const baseTime = Date.now() - 60_000;
      const rows = [];
      for (let i = 0; i < 550; i += 1) rows.push({
        id: token(`pending_a_${i}`), agencyId, creatorId, dialogId: `other_${i}`,
        status: "PENDING", incomingCount: 1, firstIncomingAt: new Date(baseTime + i), lastIncomingAt: new Date(baseTime + i),
        ownerMemberId: memberA, derivationVersion: "team_pending_v2", projectionState: "FULL",
      });
      for (let i = 0; i < 20; i += 1) rows.push({
        id: token(`pending_b_${i}`), agencyId, creatorId, dialogId: `target_${i}`,
        status: "PENDING", incomingCount: 1, firstIncomingAt: new Date(baseTime + 10_000 + i), lastIncomingAt: new Date(baseTime + 10_000 + i),
        ownerMemberId: memberB, derivationVersion: "team_pending_v2", projectionState: "FULL",
      });
      await db.teamPendingDialogState.createMany({ data: rows });

      const memberRead = await listTeamPendingDialogs({ agencyId, memberId: memberB, limit: 10, db });
      assert.equal(memberRead.rows.length, 10, "member rows after the old global-prefix-500 horizon must remain visible");
      assert.ok(memberRead.rows.every((row) => row.ownerMemberId === memberB));
      assert.equal(memberRead.summary.pendingDialogs, 20);

      await db.user.update({ where: { id: userB }, data: { disabledAt: new Date() } });
      const disabledMemberRead = await listTeamPendingDialogs({ agencyId, memberId: memberB, limit: 10, db });
      assert.equal(disabledMemberRead.rows.length, 0);
      assert.equal(disabledMemberRead.summary.pendingDialogs, 0);
      const unassigned = await listTeamPendingDialogs({ agencyId, ownership: "unassigned", limit: 10, db });
      assert.equal(unassigned.rows.length, 10, "disabled owner rows beyond 500 must become operationally unassigned before LIMIT");
      assert.ok(unassigned.rows.every((row) => row.ownerMemberId === null));
      assert.equal(unassigned.summary.unassignedDialogs, 20);

      await release.runCreatorAccountWriteTransaction(db, (tx) => tx.creatorAccount.update({ where: { id: creatorId }, data: { deletedAt: new Date() } }));
      const retired = await listTeamPendingDialogs({ agencyId, ownership: "unassigned", limit: 10, db });
      assert.equal(retired.rows.length, 0, "retired Creator must disappear from current Pending work");
      assert.equal(retired.summary.pendingDialogs, 0);
    } finally {
      await cleanupAgency(db, agencyId, userIds);
    }
  });
});

test("C6 PostgreSQL scale: one Creator create does not rewrite 500 unrelated AgencyMember rows", { skip: !enabled }, async () => {
  const { createCreatorDraft } = require("./creator-enrollment-authority-service");
  const { assertHumanCreatorCreateAuthority, currentCreatorCatalogGeneration } = require("./creator-human-management-authority-service");
  await withClients(1, async (db) => {
    const agencyId = token("c6_agency");
    const userIds = Array.from({ length: 500 }, (_, i) => token(`c6_user_${i}`));
    const memberIds = Array.from({ length: 500 }, (_, i) => token(`c6_member_${i}`));
    try {
      await db.agency.create({ data: { id: agencyId, name: agencyId } });
      await db.user.createMany({ data: userIds.map((id) => ({ id, email: `${id}@example.test`, passwordHash: "integration" })) });
      await db.agencyMember.createMany({ data: memberIds.map((id, i) => ({
        id, agencyId, userId: userIds[i], role: i === 0 ? "OWNER" : "CHATTER", roleKey: i === 0 ? "owner" : "chatter", assignedCreators: "all",
      })) });
      const actorMember = await db.agencyMember.findUnique({ where: { id: memberIds[0] } });
      const beforeRows = await db.$queryRawUnsafe(`SELECT "id",xmin::text AS xmin,"accessEpoch" FROM "AgencyMember" WHERE "agencyId"=$1 ORDER BY "id"`, agencyId);
      const before = new Map(beforeRows.map((row) => [String(row.id), { xmin: String(row.xmin), accessEpoch: Number(row.accessEpoch) }]));
      const generationBefore = await currentCreatorCatalogGeneration({ db, agencyId });

      const started = process.hrtime.bigint();
      const creator = await createCreatorDraft({
        db, agencyId, displayName: "C6 Scale", username: token("c6_username"),
        beforeCreate: (tx) => assertHumanCreatorCreateAuthority({ tx, agencyId, actorMember }),
      });
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const generationAfter = await currentCreatorCatalogGeneration({ db, agencyId });
      const afterRows = await db.$queryRawUnsafe(`SELECT "id",xmin::text AS xmin,"accessEpoch" FROM "AgencyMember" WHERE "agencyId"=$1 ORDER BY "id"`, agencyId);
      const changedMembers = afterRows.filter((row) => {
        const old = before.get(String(row.id));
        return !old || old.xmin !== String(row.xmin) || old.accessEpoch !== Number(row.accessEpoch);
      });

      assert.ok(creator?.id);
      assert.equal(afterRows.length, 500);
      assert.equal(changedMembers.length, 0, "Creator create must not rewrite unrelated Member rows/accessEpochs");
      assert.equal(generationAfter, generationBefore + 1, "Creator create must advance exactly one Agency catalog generation");
      console.log(`# C6_SCALE_METRICS members=500 changedMemberRows=${changedMembers.length} creatorCreateMs=${durationMs.toFixed(2)} catalogGenerationDelta=${generationAfter - generationBefore}`);
    } finally {
      await cleanupAgency(db, agencyId, userIds);
    }
  });
});
