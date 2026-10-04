"use strict";

// Demand is creator-scoped and survives Campaign generations. Current Work is
// only a traversal receipt; an empty next tranche cannot erase older debt.
// The existing (creatorId,status,updatedAt) index supports both presence probes.
async function readCampaignRefreshDebt({ db, creatorId }) {
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(`SELECT
      EXISTS (SELECT 1 FROM "CreatorFanRefreshDemand" WHERE "creatorId"=$1 AND "status"='QUEUED') AS queued,
      EXISTS (SELECT 1 FROM "CreatorFanRefreshDemand" WHERE "creatorId"=$1 AND "status"='FAILED') AS failed`, creatorId);
    if (typeof rows?.[0]?.queued !== "boolean" || typeof rows?.[0]?.failed !== "boolean") throw new Error("CAMPAIGN_REFRESH_DEBT_INVALID");
    return rows[0];
  }
  const find = (status) => db?.creatorFanRefreshDemand?.findFirst?.({ where: { creatorId, status }, select: { id: true } });
  const [queued, failed] = await Promise.all([find("QUEUED"), find("FAILED")]);
  return { queued: Boolean(queued), failed: Boolean(failed) };
}

module.exports = { readCampaignRefreshDebt };
