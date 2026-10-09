"use strict";
const { runRootCommit } = require("./db-commit-kernel");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { DOMAIN_WORK_GENERATION } = require("./domain-work-authority-service");
const KIND = "notification_identity_recovery_v1";
// The exact predicate is indexed by the current baseline. Only this known,
// corrected cause gets one automatic recovery; other quarantine stays intact.
const PREDICATE = require("./notification-identity-recovery-contract.json").where;
async function recoverNotificationIdentityWork({ db } = {}) {
  const rows = await db.$queryRawUnsafe(`SELECT "id","agencyId","creatorId" FROM "DomainWorkItem" WHERE ${PREDICATE} ORDER BY "id" LIMIT 4`);
  const report = { selected: rows.length, resumed: 0, retained: 0, contended: 0 };
  for (const row of rows) {
    const outcome = await runRootCommit(db, async ({ tx }) => {
      // Canonical lifecycle -> creator -> work, never work -> lifecycle.
      const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId: row.agencyId });
      const creators = row.creatorId ? await tx.$queryRawUnsafe('SELECT "id","deletedAt" FROM "CreatorAccount" WHERE "agencyId"=$1 AND "id"=$2 FOR SHARE', row.agencyId, row.creatorId) : [];
      const locked = await tx.$queryRawUnsafe(`SELECT * FROM "DomainWorkItem" WHERE "id"=$1 AND "agencyId"=$2 AND ${PREDICATE} FOR UPDATE SKIP LOCKED`, row.id, row.agencyId);
      const item = locked[0]; if (!item) return "contended";
      const resumable = lifecycle.row && !lifecycle.row.deletedAt && creators[0] && !creators[0].deletedAt
        && item.activeGeneration === DOMAIN_WORK_GENERATION && item.isOutstanding;
      const at = await dbAuthorityNow({ db: tx });
      await tx.domainWorkItem.update({ where: { id: item.id }, data: {
        // Preserve the current consumer cursor when retrying the corrected cause.
        ...(resumable ? { requestedRevision: { increment: 1n }, claimFence: { increment: 1n }, state: "READY",
          ownerToken: null, leaseUntil: at, availableAt: at, nextAttemptAt: null,
          consecutiveFailures: 0, failureRevision: 0n, lastFailureAt: null,
          errorClass: null, lastError: null, terminalCause: null } : {}),
        lastRepair: { kind: KIND, at: at.toISOString(), outcome: resumable ? "RESUMED_WITH_CURSOR" : "RETAINED_FOR_REVIEW",
          previousRevision: String(item.requestedRevision), previousError: item.lastError, previousCause: item.terminalCause },
      } });
      return resumable ? "resumed" : "retained";
    }, { profile: "JOB_CHUNK", authority: { kind: KIND, agencyId: row.agencyId, creatorId: row.creatorId } });
    report[outcome]++;
  }
  return report;
}
module.exports = { KIND, PREDICATE, recoverNotificationIdentityWork };
