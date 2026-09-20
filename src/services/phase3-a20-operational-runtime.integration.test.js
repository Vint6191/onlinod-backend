"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const {
  TEAM_CONTROL_PLANE_GENERATION,
  teamControlPlaneActivationDiagnostics,
} = require("./phase2-release-compatibility-authority-service");
const { withPhase3PostgresFixtureAuthority, cleanupPhase3PostgresAgencyFixture } = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");

function id(prefix) {
  return `${prefix}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

function messageOf(error) {
  return `${error?.message || ""} ${error?.meta?.message || ""} ${error?.cause?.message || ""}`;
}

test("A23 PostgreSQL: proof runtime is operationalized and generation-authorized fixtures cross both DB fences", { skip: !enabled, timeout: 60_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const agencyId = id("a23-authorized-agency");
  const creatorId = id("a23-authorized-creator");
  try {
    const diagnostics = await teamControlPlaneActivationDiagnostics(db);
    assert.equal(diagnostics?.row?.requiredGeneration, TEAM_CONTROL_PLANE_GENERATION);
    assert.equal(String(diagnostics?.row?.activationState || "").toUpperCase(), "ACTIVE");
    assert.equal(diagnostics?.dbFence?.ready, true);

    await withPhase3PostgresFixtureAuthority(db, async (tx) => {
      await tx.agency.create({ data: { id: agencyId, name: `A23 ${agencyId}` } });
      await tx.creatorAccount.create({ data: { id: creatorId, agencyId, displayName: `A23 ${creatorId}` } });
    });
    assert.equal(await db.agency.count({ where: { id: agencyId } }), 1);
    assert.equal(await db.creatorAccount.count({ where: { id: creatorId } }), 1);
  } finally {
    try {
      await cleanupPhase3PostgresAgencyFixture(db, agencyId);
    } catch (_) {}
    await db.$disconnect();
  }
});

test("A23 PostgreSQL: migrated DB still rejects retired direct Team and Creator writers", { skip: !enabled, timeout: 60_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const agencyId = id("a23-fenced-agency");
  const rejectedAgencyId = id("a23-retired-agency");
  const creatorId = id("a23-retired-creator");
  try {
    await assert.rejects(
      db.agency.create({ data: { id: rejectedAgencyId, name: `A23 ${rejectedAgencyId}` } }),
      (error) => messageOf(error).includes("PHASE2_INCOMPATIBLE_TEAM_CONTROL_PLANE_WRITER"),
    );

    await withPhase3PostgresFixtureAuthority(db, (tx) => tx.agency.create({ data: { id: agencyId, name: `A23 ${agencyId}` } }));
    await assert.rejects(
      db.creatorAccount.create({ data: { id: creatorId, agencyId, displayName: `A23 ${creatorId}` } }),
      (error) => messageOf(error).includes("PHASE2_INCOMPATIBLE_CREATOR_WRITER"),
    );
  } finally {
    try {
      await cleanupPhase3PostgresAgencyFixture(db, agencyId);
    } catch (_) {}
    await db.$disconnect();
  }
});
