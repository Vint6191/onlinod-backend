"use strict";

const { runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { afterPlanningCommit } = require("./job-planning-repository");
const { assertManagementCommitAuthority } = require("./management-commit-authority-service");

function claimLost() {
  return Object.assign(new Error("Home Analytics demand ownership changed or expired"), { code: "ANALYTICS_DEMAND_PLANNING_CLAIM_LOST" });
}

async function planAnalyticsDemandCreator({ db, demand, member, creator, startDay, endDay, now, coverageRows }) {
  if (typeof db?.$transaction !== "function") {
    throw Object.assign(new Error("Home planning requires a root transaction"), { code: "ANALYTICS_DEMAND_TRANSACTION_REQUIRED" });
  }
  return afterPlanningCommit(() => runDbTransaction(db, async (tx) => {
    // Canonical lifecycle order: Agency -> Creator -> User -> Member -> demand.
    // Revocation/retirement writers cannot pass these locks before our commit.
    await assertManagementCommitAuthority({ tx, agencyId: demand.agencyId, actorMember: member,
      permissionKey: "creator_analytics.refresh", creatorIds: [creator.id] });
    const liveCreator = await tx.creatorAccount.findFirst({ where: {
      id: creator.id, agencyId: demand.agencyId, status: "READY", deletedAt: null,
    }, select: { id: true } });
    if (!liveCreator) throw Object.assign(new Error("Home creator is no longer ready"), { code: "MANAGEMENT_CREATOR_RETIRED" });
    if (typeof tx.$queryRawUnsafe === "function") {
      await tx.$queryRawUnsafe('SELECT "key" FROM "AnalyticsCollectionDemand" WHERE "key"=$1 FOR UPDATE', demand.key);
    }
    const at = await dbAuthorityNow({ db: tx, fallbackNow: now });
    const current = await tx.analyticsCollectionDemand.findUnique({ where: { key: demand.key } });
    if (!current || current.agencyId !== demand.agencyId || current.claimToken !== demand.claimToken
      || Number(current.claimedRevision) !== Number(demand.claimedRevision)
      || Number(current.requestRevision) !== Number(demand.claimedRevision)
      || current.requestedByMemberId !== member.id
      || Number(current.requestedAccessEpoch) !== Number(member.accessEpoch)
      || (current.cursorCreatorId || null) !== (demand.cursorCreatorId || null)
      || current.completedAt || current.quarantinedAt || !(new Date(current.claimUntil) > at)) throw claimLost();
    if (current.creatorIds != null && (!Array.isArray(current.creatorIds) || !current.creatorIds.includes(creator.id))) throw claimLost();

    const { ensureAnalyticsWindowFreshness } = require("./analytics-collection-planner");
    const result = await ensureAnalyticsWindowFreshness({ db: tx, creatorId: creator.id, agencyId: demand.agencyId,
      startDay, endDay, displayRangeKey: current.rangeKey, reason: current.reason, priority: current.priority,
      now: at, coverageRows });
    // Jobs and cursor have one commit. Expiry while planning rolls both back;
    // notifications stay buffered until the root transaction actually commits.
    const finishedAt = await dbAuthorityNow({ db: tx, fallbackNow: now });
    const saved = await tx.analyticsCollectionDemand.updateMany({ where: {
      key: current.key, claimToken: demand.claimToken, claimedRevision: demand.claimedRevision,
      requestRevision: demand.claimedRevision, completedAt: null, quarantinedAt: null, claimUntil: { gt: finishedAt },
    }, data: { cursorCreatorId: creator.id } });
    if (Number(saved.count) !== 1) throw claimLost();
    return result;
  }, { maxWait: 5000, timeout: 20_000 }));
}

module.exports = { planAnalyticsDemandCreator };
