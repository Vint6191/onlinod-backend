"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";

function token(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

test("A1/A4 PostgreSQL: superseded failure cannot delay V2 and reclaimed owner fences stale commit", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const {
    WORK_CLASS,
    publishDomainWork,
    claimDomainWorkBatch,
    failDomainWorkClaim,
    lockDomainWorkClaimForCommit,
  } = require("./domain-work-authority-service");

  const db1 = new PrismaClient();
  const db2 = new PrismaClient();
  const agencyId = token("p2_domain_settlement_agency");
  const staleFailureObjectId = token("p2_domain_stale_failure");
  const reclaimObjectId = token("p2_domain_reclaim");

  try {
    await db1.agency.create({ data: { id: agencyId, name: `Phase2 domain settlement ${agencyId}` } });

    await publishDomainWork({
      db: db1,
      agencyId,
      workClass: WORK_CLASS.DEPENDENCY_FANOUT,
      objectType: "SettlementFixture",
      objectId: staleFailureObjectId,
      partitionKey: agencyId,
      availableAt: new Date(Date.now() - 5_000),
    });
    const v1Claim = await claimDomainWorkBatch({
      db: db1,
      agencyId,
      workClass: WORK_CLASS.DEPENDENCY_FANOUT,
      objectType: "SettlementFixture",
      objectIds: [staleFailureObjectId],
      ownerToken: token("owner_v1"),
      limit: 1,
      perAgencyQuantum: 1,
      perPartitionQuantum: 1,
      leaseMs: 60_000,
    });
    assert.equal(v1Claim.items.length, 1);
    const v1 = v1Claim.items[0];
    assert.equal(BigInt(v1.claimedRevision), 1n);

    // Publish V2 while V1 still owns the lease. A V1 failure after this point must
    // release V2 immediately rather than copying V1's retry clock onto the identity.
    await publishDomainWork({
      db: db2,
      agencyId,
      workClass: WORK_CLASS.DEPENDENCY_FANOUT,
      objectType: "SettlementFixture",
      objectId: staleFailureObjectId,
      partitionKey: agencyId,
      availableAt: new Date(),
    });
    const farRetry = new Date(Date.now() + 15 * 60_000);
    const failed = await failDomainWorkClaim({
      db: db1,
      item: v1,
      ownerToken: v1Claim.ownerToken,
      error: Object.assign(new Error("old V1 failure"), { code: "V1_TRANSIENT" }),
      retryAt: farRetry,
    });
    assert.equal(failed.lost, false);
    assert.equal(failed.superseded, true);

    const afterFailure = await db1.domainWorkItem.findUnique({ where: { id: v1.id } });
    assert.equal(BigInt(afterFailure.requestedRevision), 2n);
    assert.equal(BigInt(afterFailure.completedRevision), 0n);
    assert.equal(afterFailure.state, "READY");
    assert.equal(afterFailure.ownerToken, null);
    assert.equal(afterFailure.nextAttemptAt, null);
    assert.equal(afterFailure.errorClass, null);
    assert.equal(afterFailure.lastError, null);
    assert.ok(afterFailure.availableAt.getTime() < farRetry.getTime() - 60_000, "V2 must not inherit V1's far retry deadline");

    await publishDomainWork({
      db: db1,
      agencyId,
      workClass: WORK_CLASS.DEPENDENCY_FANOUT,
      objectType: "SettlementFixture",
      objectId: reclaimObjectId,
      partitionKey: agencyId,
      availableAt: new Date(Date.now() - 5_000),
    });
    const oldClaim = await claimDomainWorkBatch({
      db: db1,
      agencyId,
      workClass: WORK_CLASS.DEPENDENCY_FANOUT,
      objectType: "SettlementFixture",
      objectIds: [reclaimObjectId],
      ownerToken: token("owner_old"),
      limit: 1,
      perAgencyQuantum: 1,
      perPartitionQuantum: 1,
      leaseMs: 60_000,
    });
    assert.equal(oldClaim.items.length, 1);
    const oldItem = oldClaim.items[0];

    await db1.domainWorkItem.update({
      where: { id: oldItem.id },
      data: { leaseUntil: new Date(Date.now() - 1_000) },
    });
    const newClaim = await claimDomainWorkBatch({
      db: db2,
      agencyId,
      workClass: WORK_CLASS.DEPENDENCY_FANOUT,
      objectType: "SettlementFixture",
      objectIds: [reclaimObjectId],
      ownerToken: token("owner_new"),
      limit: 1,
      perAgencyQuantum: 1,
      perPartitionQuantum: 1,
      leaseMs: 60_000,
    });
    assert.equal(newClaim.items.length, 1);
    assert.ok(BigInt(newClaim.items[0].claimFence) > BigInt(oldItem.claimFence));

    const staleGuard = await lockDomainWorkClaimForCommit({ db: db1, item: oldItem, ownerToken: oldClaim.ownerToken });
    assert.equal(staleGuard.lost, true, "reclaimed V1 owner must be fenced before domain mutation");
    const currentGuard = await lockDomainWorkClaimForCommit({ db: db2, item: newClaim.items[0], ownerToken: newClaim.ownerToken });
    assert.equal(currentGuard.current, true);
    assert.equal(currentGuard.lost, false);
  } finally {
    try { await db1.agency.delete({ where: { id: agencyId } }); } catch (_) {}
    await Promise.allSettled([db1.$disconnect(), db2.$disconnect()]);
  }
});
