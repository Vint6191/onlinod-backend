"use strict";

const { WORK_CLASS, currentDependencyRevision, blockDomainWorkClaim } = require("./domain-work-authority-service");
const DEPENDENCY = "ANALYTICS_PROJECTION_LIFECYCLE";

// Caller holds the shared Agency lifecycle barrier. A reversible soft delete
// must not acknowledge unprocessed projection work. Sleep on the existing
// durable dependency authority; Agency restore publishes one bounded wake job.
async function pauseDeletedAgencyProjection({ db, lifecycle, item, ownerToken }) {
  if (!lifecycle.row?.deletedAt) return false;
  const hardDelete = await db.domainWorkItem.findUnique({ where: { agencyId_workClass_objectType_objectId: {
    agencyId: item.agencyId, workClass: WORK_CLASS.DESTRUCTIVE_AGENCY_CLEANUP,
    objectType: "Phase2AgencyDestructiveCleanup", objectId: item.agencyId,
  } }, select: { id: true } });
  // Hard deletion is irreversible and its bounded cleanup owns remaining rows.
  if (hardDelete) return false;
  const identity = { agencyId: item.agencyId, dependencyKind: DEPENDENCY, dependencyKey: item.agencyId };
  const revision = await currentDependencyRevision({ db, ...identity });
  const result = await blockDomainWorkClaim({ db, item, ownerToken, ...identity,
    dependencyRevision: revision, reason: "AGENCY_SOFT_DELETED" });
  if (result.lost) throw Object.assign(new Error("ANALYTICS_PROJECTION_CLAIM_LOST"), { code: "ANALYTICS_PROJECTION_CLAIM_LOST" });
  return true;
}

module.exports = { pauseDeletedAgencyProjection };
