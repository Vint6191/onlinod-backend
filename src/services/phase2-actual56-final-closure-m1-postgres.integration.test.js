"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const release = require("./phase2-release-compatibility-authority-service");
const work = require("./domain-work-authority-service");

function token(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isFenceError(error, marker) {
  const text = [error?.message, error?.meta?.message, error?.meta?.code, error?.code].filter(Boolean).join(" ");
  return text.includes(marker) || text.includes("55000");
}

async function cleanupAgency(db, agencyId) {
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
    // Integration DBs are disposable; do not mask the actual M1 assertion if a
    // pre-existing unrelated destructive trigger prevents fixture cleanup.
  }
}

test("M1 PostgreSQL: old Creator/Member/executor writers fail closed while new generation drains safely", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const agencyId = token("m1_agency");
  const userId = token("m1_user");
  const memberId = token("m1_member");
  const creatorId = token("m1_creator");
  const workClass = work.WORK_CLASS.DEPENDENCY_FANOUT;
  const objectA = token("legacy_claim");
  const objectB = token("ready_claim");

  try {
    await db.agency.create({ data: { id: agencyId, name: agencyId } });
    await db.user.create({ data: { id: userId, email: `${userId}@example.test`, passwordHash: "integration" } });
    await db.agencyMember.create({ data: { id: memberId, agencyId, userId, role: "OWNER", assignedCreators: "all" } });

    await release.runCreatorAccountWriteTransaction(db, (tx) => tx.creatorAccount.create({
      data: { id: creatorId, agencyId, displayName: "M1", username: token("m1_username") },
    }));

    await assert.rejects(
      db.creatorAccount.update({ where: { id: creatorId }, data: { notes: "old-binary-write" } }),
      (error) => isFenceError(error, "PHASE2_INCOMPATIBLE_CREATOR_WRITER"),
      "migrated DB must reject old Creator writer without the release token",
    );

    await release.runCreatorAccountWriteTransaction(db, (tx) => tx.creatorAccount.update({
      where: { id: creatorId }, data: { notes: "new-binary-write" },
    }));
    assert.equal((await db.creatorAccount.findUnique({ where: { id: creatorId }, select: { notes: true } })).notes, "new-binary-write");

    await assert.rejects(
      db.agencyMember.delete({ where: { id: memberId } }),
      (error) => isFenceError(error, "PHASE2_AGENCY_MEMBER_PHYSICAL_DELETE_RETIRED"),
      "old platform-admin physical Member DELETE must be DB-fenced",
    );
    await db.agencyMember.update({ where: { id: memberId }, data: { deactivatedAt: new Date() } });
    assert.ok((await db.agencyMember.findUnique({ where: { id: memberId }, select: { deactivatedAt: true } })).deactivatedAt);

    const a = await work.publishDomainWork({
      db, agencyId, workClass, objectType: "M1Rolling", objectId: objectA,
      partitionKey: creatorId, creatorId, availableAt: new Date(Date.now() - 1_000),
    });
    await work.publishDomainWork({
      db, agencyId, workClass, objectType: "M1Rolling", objectId: objectB,
      partitionKey: creatorId, creatorId, availableAt: new Date(Date.now() - 1_000),
    });

    await assert.rejects(
      db.domainWorkItem.update({
        where: { id: a.id },
        data: { state: "CLAIMED", ownerToken: "old-executor", claimFence: { increment: 1 }, leaseUntil: new Date(Date.now() + 60_000) },
      }),
      (error) => isFenceError(error, "PHASE2_INCOMPATIBLE_DOMAIN_EXECUTOR"),
      "old executor must not acquire new DWI ownership after migration",
    );

    // Simulate a claim that existed before the release migration: acquire it with
    // the new token, then clear only the generation stamp (the release trigger does
    // not watch that column) while keeping a live lease.
    await db.$transaction(async (tx) => {
      await release.authorizeDomainWorkExecutor(tx);
      await tx.domainWorkItem.update({
        where: { id: a.id },
        data: { state: "CLAIMED", ownerToken: "pre-migration-owner", claimFence: { increment: 1 }, leaseUntil: new Date(Date.now() + 60_000) },
      });
      await tx.domainWorkItem.update({ where: { id: a.id }, data: { claimExecutionGeneration: null } });
    });

    const blocked = await work.claimDomainWorkBatch({ db, workClass, agencyId, ownerToken: "new-executor", limit: 2 });
    assert.equal(blocked.skipped, true);
    assert.equal(blocked.reason, "legacy_executor_drain");
    assert.equal(blocked.items.length, 0);

    await db.domainWorkItem.update({ where: { id: a.id }, data: { leaseUntil: new Date(Date.now() - 1_000) } });
    const admitted = await work.claimDomainWorkBatch({ db, workClass, agencyId, ownerToken: "new-executor", limit: 2 });
    assert.ok(admitted.items.length >= 1);
    for (const item of admitted.items) {
      assert.equal(item.claimExecutionGeneration, release.DOMAIN_WORK_EXECUTOR_GENERATION);
    }
  } finally {
    await cleanupAgency(db, agencyId);
    await db.$disconnect();
  }
});
