"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const authority = require("./domain-work-authority-service");

function token(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`; }

async function cleanupAgency(db, agencyId) {
  await db.agency.delete({ where: { id: agencyId } }).catch(() => undefined);
}

test("F55-01 PostgreSQL/Prisma: production broad and creator-scoped claims execute without VOID decoding", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const agencyId = token("p2_actual55_claim_agency");
  const creatorId = token("creator");
  try {
    await db.agency.create({ data: { id: agencyId, name: agencyId } });
    await authority.publishDomainWork({ db, agencyId, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION,
      objectType: "Actual55BroadClaim", objectId: token("broad"), partitionKey: creatorId, creatorId, availableAt: new Date(Date.now() - 1000) });
    const broad = await authority.claimDomainWorkBatch({ db, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION,
      ownerToken: token("broad_owner"), limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1 });
    assert.equal(broad.items.length, 1);
    assert.equal(broad.items[0].agencyId, agencyId);

    await authority.ackDomainWorkClaim({ db, item: broad.items[0], ownerToken: broad.ownerToken });

    await authority.publishDomainWork({ db, agencyId, workClass: authority.WORK_CLASS.CUSTOM_SOURCE_PIPELINE,
      objectType: "CustomContentSubmission", objectId: token("source"), partitionKey: creatorId, creatorId, availableAt: new Date(Date.now() - 1000) });
    const scoped = await authority.claimDomainWorkBatch({ db, workClass: authority.WORK_CLASS.CUSTOM_SOURCE_PIPELINE,
      agencyId, creatorIds: [creatorId], objectType: "CustomContentSubmission",
      ownerToken: token("scoped_owner"), limit: 1, perPartitionQuantum: 1 });
    assert.equal(scoped.items.length, 1);
    assert.equal(scoped.items[0].creatorId, creatorId);
  } finally {
    await cleanupAgency(db, agencyId);
    await db.$disconnect();
  }
});

test("F55-05 PostgreSQL: publish same identity racing ACK converges without advisory/row deadlock", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db1 = new PrismaClient();
  const db2 = new PrismaClient();
  const agencyId = token("p2_actual55_publish_ack");
  try {
    await db1.agency.create({ data: { id: agencyId, name: agencyId } });
    for (let i = 0; i < 12; i += 1) {
      const objectId = token(`race_${i}`);
      await authority.publishDomainWork({ db: db1, agencyId, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION,
        objectType: "Actual55PublishAck", objectId, partitionKey: "creator-race", creatorId: "creator-race", availableAt: new Date(Date.now() - 1000) });
      const claim = await authority.claimDomainWorkBatch({ db: db1, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION,
        agencyId, objectType: "Actual55PublishAck", objectIds: [objectId], ownerToken: token("owner"), limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1 });
      assert.equal(claim.items.length, 1);
      const item = claim.items[0];
      await Promise.all([
        authority.ackDomainWorkClaim({ db: db1, item, ownerToken: claim.ownerToken }),
        authority.publishDomainWork({ db: db2, agencyId, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION,
          objectType: "Actual55PublishAck", objectId, partitionKey: "creator-race", creatorId: "creator-race", availableAt: new Date(Date.now() - 1000) }),
      ]);
      const current = await db1.domainWorkItem.findUnique({ where: { id: item.id } });
      assert.equal(String(current.activeGeneration), authority.DOMAIN_WORK_GENERATION);
      assert.equal(current.isOutstanding, true);
      assert.equal(String(current.state), "READY");
      assert.ok(BigInt(current.requestedRevision) > BigInt(current.completedRevision));
    }
  } finally {
    await cleanupAgency(db1, agencyId);
    await Promise.allSettled([db1.$disconnect(), db2.$disconnect()]);
  }
});

test("INT7 PostgreSQL: missing broad partition catalog self-heals from one physical DWI fallback", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const agencyId = token("p2_int7_catalog_agency");
  const creatorId = token("creator_catalog");
  const objectId = token("catalog_work");
  try {
    await db.agency.create({ data: { id: agencyId, name: agencyId } });
    await authority.publishDomainWork({ db, agencyId, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION,
      objectType: "Actual55Int7CatalogFallback", objectId, partitionKey: creatorId, creatorId,
      availableAt: new Date(Date.now() - 1000) });

    await db.phase2WorkBroadClaimPartitionState.deleteMany({
      where: { agencyId, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION, partitionKey: creatorId },
    });
    assert.equal(await db.phase2WorkBroadClaimPartitionState.count({
      where: { agencyId, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION, partitionKey: creatorId },
    }), 0);

    const claim = await authority.claimDomainWorkBatch({
      db, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION, agencyId,
      objectType: "Actual55Int7CatalogFallback", objectIds: [objectId],
      ownerToken: token("catalog_owner"), limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1,
    });
    assert.equal(claim.items.length, 1);
    assert.equal(claim.items[0].id != null, true);

    const healed = await db.phase2WorkBroadClaimPartitionState.findUnique({
      where: {
        agencyId_workClass_partitionKey: {
          agencyId, workClass: authority.WORK_CLASS.CUSTOM_COMMUNICATION, partitionKey: creatorId,
        },
      },
    });
    assert.ok(healed, "physical fallback must repair the missing partition catalog row");
    assert.equal(String(healed.activeGeneration), authority.DOMAIN_WORK_GENERATION);
  } finally {
    await cleanupAgency(db, agencyId);
    await db.$disconnect();
  }
});

