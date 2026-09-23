"use strict";

const { runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { DOMAIN_WORK_GENERATION, WORK_CLASS } = require("./domain-work-authority-service");

// Operator-only exact repair command. No HTTP/admin generic mutation route is
// added. A request must name its tenant, identity and observed revision; stale
// commands cannot release another tenant's work or overwrite a fresh producer.
async function resumeDomainWorkAfterRepair({ db, agencyId, workId, expectedRevision, reason, fallbackNow = new Date() }) {
  if (!agencyId || !workId || !/^\d+$/.test(String(expectedRevision || "")) || !String(reason || "").trim()) {
    throw Object.assign(new Error("Repair requires agency, work ID, expected revision and reason"), { code: "DOMAIN_WORK_REPAIR_IDENTITY_REQUIRED" });
  }
  const revision = BigInt(expectedRevision);
  return runDbTransaction(db, async (tx) => {
    const before = await tx.domainWorkItem.findFirst({ where: { id: workId, agencyId } });
    if (!before) return { resumed: false, reason: "not_found" };
    const cleanup = [WORK_CLASS.DESTRUCTIVE_AGENCY_CLEANUP, WORK_CLASS.DESTRUCTIVE_CREATOR_CLEANUP].includes(before.workClass);
    // Canonical lifecycle prefix before DWI, matching retirement/producer order.
    if (typeof tx.$queryRawUnsafe === "function") {
      await tx.$queryRawUnsafe('SELECT "id" FROM "Agency" WHERE "id"=$1 FOR SHARE', agencyId);
      if (before.creatorId) await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorAccount" WHERE "agencyId"=$1 AND "id"=$2 FOR SHARE', agencyId, before.creatorId);
    }
    const agency = await tx.agency.findFirst({ where: { id: agencyId }, select: { deletedAt: true } });
    const creator = before.creatorId ? await tx.creatorAccount.findFirst({ where: { agencyId, id: before.creatorId }, select: { deletedAt: true } }) : null;
    if (!agency || (!cleanup && (agency.deletedAt || (before.creatorId && (!creator || creator.deletedAt))))) {
      return { resumed: false, reason: "lifecycle_retired" };
    }
    if (typeof tx.$queryRawUnsafe === "function") await tx.$queryRawUnsafe('SELECT "id" FROM "DomainWorkItem" WHERE "id"=$1 FOR UPDATE', workId);
    const at = await dbAuthorityNow({ db: tx, fallbackNow });
    const current = await tx.domainWorkItem.findFirst({ where: { id: workId, agencyId } });
    if (!current || current.state !== "RECONCILE_REQUIRED" || BigInt(current.requestedRevision) !== revision
        || current.activeGeneration !== DOMAIN_WORK_GENERATION) return { resumed: false, reason: "revision_or_state_changed" };
    const changed = await tx.domainWorkItem.updateMany({ where: {
      id: workId, agencyId, state: "RECONCILE_REQUIRED", requestedRevision: revision, activeGeneration: DOMAIN_WORK_GENERATION,
    }, data: {
      requestedRevision: { increment: 1n }, state: "READY", isOutstanding: true,
      ownerToken: null, leaseUntil: at, availableAt: at, nextAttemptAt: null,
      consecutiveFailures: 0, failureRevision: 0n, lastFailureAt: null,
      errorClass: null, lastError: null, terminalCause: null, progressCursor: null,
      lastRepair: { at: at.toISOString(), reason: String(reason).trim().slice(0, 2000),
        previousRevision: String(revision), previousError: current.lastError, previousCause: current.terminalCause },
    } });
    return Number(changed.count) === 1 ? { resumed: true, requestedRevision: String(revision + 1n) } : { resumed: false, reason: "revision_or_state_changed" };
  });
}

module.exports = { resumeDomainWorkAfterRepair };
