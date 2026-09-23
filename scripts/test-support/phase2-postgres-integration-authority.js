"use strict";

const { randomUUID } = require("node:crypto");
const release = require("../../src/services/phase2-release-compatibility-authority-service");

async function authorizeFixtureTransaction(tx, { team = false, creator = false, domainExecutor = false } = {}) {
  if (team) await release.assertTeamControlPlaneWriteAdmission(tx);
  if (creator) await release.authorizeCreatorAccountWrite(tx);
  if (domainExecutor) await release.authorizeDomainWorkExecutor(tx);
  return tx;
}

async function withFixtureAuthorities(db, authorities, work, options = undefined) {
  if (!db || typeof db.$transaction !== "function") {
    throw Object.assign(new Error("PostgreSQL integration fixture requires Prisma transaction support"), { code: "PHASE2_PG_FIXTURE_TRANSACTION_REQUIRED" });
  }
  if (typeof work !== "function") throw new TypeError("PostgreSQL integration fixture work callback is required");
  return db.$transaction(async (tx) => {
    await authorizeFixtureTransaction(tx, authorities);
    return work(tx);
  }, options);
}

async function claimAgencyDestructiveFixture(db, agencyId) {
  const id = String(agencyId || "").trim();
  if (!id) throw Object.assign(new Error("PostgreSQL fixture Agency id is required"), { code: "PHASE2_PG_FIXTURE_AGENCY_REQUIRED" });
  const domainWork = require("../../src/services/domain-work-authority-service");
  const ownerToken = `phase2-fixture-agency-delete:${randomUUID()}`;
  const work = await domainWork.publishDomainWork({
    db,
    agencyId: id,
    workClass: domainWork.WORK_CLASS.DESTRUCTIVE_AGENCY_CLEANUP,
    objectType: "Phase2AgencyDestructiveCleanup",
    objectId: id,
    partitionKey: id,
    creatorId: null,
  });
  const claim = await domainWork.claimDomainWorkBatch({
    db,
    agencyId: id,
    workClass: domainWork.WORK_CLASS.DESTRUCTIVE_AGENCY_CLEANUP,
    objectType: "Phase2AgencyDestructiveCleanup",
    objectIds: [id],
    ownerToken,
    limit: 1,
    leaseMs: 120_000,
  });
  const claimed = (claim?.items || []).find((item) => String(item?.id || "") === String(work?.id || ""));
  if (!claimed) {
    const error = new Error(`PostgreSQL fixture could not claim exact Agency destructive work: ${id}`);
    error.code = "PHASE2_PG_FIXTURE_DESTRUCTIVE_CLAIM_REQUIRED";
    throw error;
  }
  return { workId: String(claimed.id), ownerToken: String(claim?.ownerToken || ownerToken) };
}

async function installAgencyDestructiveFixtureAuthority(tx, agencyId, claim) {
  await tx.$queryRawUnsafe(`
    SELECT set_config('onlinod.phase2_destructive_agency_id',$1,true) AS "agencyId",
           set_config('onlinod.phase2_destructive_agency_work_id',$2,true) AS "workId",
           set_config('onlinod.phase2_destructive_agency_owner_token',$3,true) AS "ownerToken"
  `, String(agencyId), String(claim?.workId || ""), String(claim?.ownerToken || ""));
}

async function cleanupAgencyFixture(db, { agencyId, userIds = [] } = {}) {
  if (!agencyId) return;
  const claim = await claimAgencyDestructiveFixture(db, agencyId);
  return withFixtureAuthorities(db, { team: true, creator: true }, async (tx) => {
    await installAgencyDestructiveFixtureAuthority(tx, agencyId, claim);
    await tx.agency.delete({ where: { id: agencyId } });
    if (userIds.length) await tx.user.deleteMany({ where: { id: { in: userIds } } });
  });
}

module.exports = {
  authorizeFixtureTransaction,
  withFixtureAuthorities,
  claimAgencyDestructiveFixture,
  installAgencyDestructiveFixtureAuthority,
  cleanupAgencyFixture,
};
