"use strict";

const FAILURE_COUNT_LIMIT = 1000;

// These are diagnostic counts, not coverage arithmetic. One snapshot and
// bounded index probes preserve presence/recovery even with millions of failures.
// At saturation the returned value is a proven lower bound, never an estimate.
async function readCampaignRefreshFailureStatus({ db, creatorId }) {
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(`
      SELECT
        (SELECT COUNT(*)::int FROM (SELECT 1 FROM "CreatorFanRefreshDemand"
          WHERE "creatorId"=$1 AND "status"='FAILED' AND "quarantinedAt" IS NULL
          ORDER BY "id" LIMIT $2) retryable) AS "failed",
        (SELECT COUNT(*)::int FROM (SELECT 1 FROM "CreatorFanRefreshDemand"
          WHERE "creatorId"=$1 AND "status"='FAILED' AND "quarantinedAt" IS NOT NULL
          ORDER BY "id" LIMIT $2) quarantined) AS "quarantined",
        (SELECT "nextRetryAt" FROM "CreatorFanRefreshDemand"
          WHERE "creatorId"=$1 AND "status"='FAILED' AND "quarantinedAt" IS NULL AND "nextRetryAt" IS NOT NULL
          ORDER BY "nextRetryAt","id" LIMIT 1) AS "nextRetryAt",
        last_failure."onlyFansUserId",last_failure."lastError",last_failure."lastFailedAt",
        last_failure."retryAttempts",last_failure."quarantinedAt"
      FROM (SELECT 1) singleton LEFT JOIN LATERAL (
        SELECT "onlyFansUserId","lastError","lastFailedAt","retryAttempts","quarantinedAt"
        FROM "CreatorFanRefreshDemand" WHERE "creatorId"=$1 AND "status"='FAILED'
        ORDER BY "lastFailedAt" DESC,"id" LIMIT 1
      ) last_failure ON true`, creatorId, FAILURE_COUNT_LIMIT + 1);
    if (!rows?.[0] || !Number.isInteger(rows[0].failed) || !Number.isInteger(rows[0].quarantined)) {
      throw new Error("CAMPAIGN_REFRESH_FAILURE_STATUS_INVALID");
    }
    return { ...rows[0], failedExact: rows[0].failed <= FAILURE_COUNT_LIMIT,
      quarantinedExact: rows[0].quarantined <= FAILURE_COUNT_LIMIT };
  }
  // Older semantic adapters have no PostgreSQL. Keep their exact-count API;
  // production Prisma always executes the bounded statement above.
  const model = db?.creatorFanRefreshDemand;
  const failed = await model?.count?.({ where: { creatorId, status: "FAILED", quarantinedAt: null } }) || 0;
  const quarantined = await model?.count?.({ where: { creatorId, status: "FAILED", quarantinedAt: { not: null } } }) || 0;
  const retry = failed ? await model?.findFirst?.({
    where: { creatorId, status: "FAILED", quarantinedAt: null, nextRetryAt: { not: null } },
    orderBy: [{ nextRetryAt: "asc" }, { id: "asc" }], select: { nextRetryAt: true },
  }) : null;
  const last = failed || quarantined ? await model?.findFirst?.({
    where: { creatorId, status: "FAILED" }, orderBy: [{ lastFailedAt: "desc" }, { id: "asc" }],
    select: { onlyFansUserId: true, lastError: true, lastFailedAt: true, retryAttempts: true, quarantinedAt: true },
  }) : null;
  return { ...last, failed, quarantined, nextRetryAt: retry?.nextRetryAt || null,
    failedExact: true, quarantinedExact: true };
}

module.exports = { FAILURE_COUNT_LIMIT, readCampaignRefreshFailureStatus };
