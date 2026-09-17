"use strict";

const prisma = require("../prisma");

const CAMPAIGN_CAUSAL_V1_SETTING_KEY = "phase3.campaignCausalObservationV1";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function activeValue(value) {
  return object(value).active === true;
}

async function campaignCausalV1State({ db = prisma, lockForCommit = false } = {}) {
  if (lockForCommit && typeof db.$queryRawUnsafe === "function") {
    let rows;
    try {
      rows = await db.$queryRawUnsafe(
        'SELECT "value" FROM "SystemSetting" WHERE "key" = $1 FOR SHARE',
        CAMPAIGN_CAUSAL_V1_SETTING_KEY,
      );
    } catch (error) {
      // Legacy in-memory ledger doubles sometimes expose one purpose-specific
      // $queryRawUnsafe mock (DB clock only) but no SystemSetting model. Keep
      // those doubles in bridge mode; production Prisma has SystemSetting and
      // must fail closed on a missing/failed durable barrier.
      if (typeof db.systemSetting?.findUnique !== "function") return { active: false, value: {} };
      throw error;
    }
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !Object.hasOwn(row, "value")) {
      if (typeof db.systemSetting?.findUnique !== "function") return { active: false, value: {} };
      throw new Error("CAMPAIGN_CAUSAL_V1_BARRIER_MISSING");
    }
    return { active: activeValue(row.value), value: object(row.value) };
  }
  // Tiny in-memory transaction doubles used by legacy unit suites may not expose
  // SystemSetting. Production Prisma always exposes it; keep those doubles in
  // pre-activation bridge mode rather than weakening the production barrier.
  if (typeof db.systemSetting?.findUnique !== "function") return { active: false, value: {} };
  const row = await db.systemSetting.findUnique({ where: { key: CAMPAIGN_CAUSAL_V1_SETTING_KEY } });
  return { active: activeValue(row?.value), value: object(row?.value) };
}

async function activateCampaignCausalV1({ db = prisma, activatedBy = "operator" } = {}) {
  return db.$transaction(async (tx) => {
    if (typeof tx.$queryRawUnsafe !== "function") throw new Error("CAMPAIGN_CAUSAL_V1_DB_LOCK_UNAVAILABLE");
    const rows = await tx.$queryRawUnsafe(
      'SELECT "value" FROM "SystemSetting" WHERE "key" = $1 FOR UPDATE',
      CAMPAIGN_CAUSAL_V1_SETTING_KEY,
    );
    if (!Array.isArray(rows) || !rows[0]) throw new Error("CAMPAIGN_CAUSAL_V1_BARRIER_MISSING");
    if (activeValue(rows[0].value)) return { active: true, alreadyActive: true, revoked: 0, stamped: 0 };

    // One set-based activation fence. Every currently CLAIMED Campaign owner is
    // revoked because a mixed-version Backend could have leased a v1-stamped row
    // to an old Desktop before the bridge fleet was drained. Exact old-revision
    // read leases are deleted before the job revision advances. Scheduled/paused
    // rows are protocol-stamped in the same transaction.
    const cutoverRows = await tx.$queryRawUnsafe(`
      WITH claimed AS MATERIALIZED (
        SELECT "id", "leaseRevision"
        FROM "JobInstance"
        WHERE "jobKey" = 'fetch_campaigns'
          AND "status" = 'CLAIMED'
        FOR UPDATE
      ),
      cleaned AS (
        DELETE FROM "FanObservationReadLease" AS r
        USING claimed AS c
        WHERE r."jobId" = c."id"
          AND r."leaseRevision" = c."leaseRevision"
        RETURNING r."jobId"
      ),
      revoked AS (
        UPDATE "JobInstance" AS j
        SET "params" = COALESCE(j."params", '{}'::jsonb)
              || '{"observationTokenVersion":1,"observationReadLeaseVersion":1}'::jsonb,
            "status" = 'SCHEDULED',
            "nextRunAt" = CURRENT_TIMESTAMP,
            "claimedAt" = NULL,
            "claimedByDeviceId" = NULL,
            "leaseUntil" = NULL,
            "leaseTokenHash" = NULL,
            "leaseMemberId" = NULL,
            "leaseAccessEpoch" = NULL,
            "workId" = NULL,
            "leaseRevision" = j."leaseRevision" + 1,
            "lastError" = 'campaign causal v1 activation requeue',
            "updatedAt" = CURRENT_TIMESTAMP
        FROM claimed AS c
        WHERE j."id" = c."id"
          AND j."status" = 'CLAIMED'
          AND j."leaseRevision" = c."leaseRevision"
        RETURNING j."id"
      ),
      stamped AS (
        UPDATE "JobInstance" AS j
        SET "params" = COALESCE(j."params", '{}'::jsonb)
              || '{"observationTokenVersion":1,"observationReadLeaseVersion":1}'::jsonb,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE j."jobKey" = 'fetch_campaigns'
          AND j."status" IN ('SCHEDULED', 'PAUSED')
        RETURNING j."id"
      )
      SELECT
        (SELECT COUNT(*)::int FROM revoked) AS "revoked",
        (SELECT COUNT(*)::int FROM stamped) AS "stamped"
    `);
    const cutover = Array.isArray(cutoverRows) ? cutoverRows[0] : null;
    const revoked = Number(cutover?.revoked || 0);
    const stamped = Number(cutover?.stamped || 0);

    const previous = object(rows[0].value);
    const epoch = Math.max(0, Number(previous.epoch || 0)) + 1;
    await tx.systemSetting.update({
      where: { key: CAMPAIGN_CAUSAL_V1_SETTING_KEY },
      data: {
        value: {
          active: true,
          epoch,
          activatedAt: new Date().toISOString(),
          activatedBy: String(activatedBy || "operator").slice(0, 120),
        },
      },
    });
    return { active: true, alreadyActive: false, epoch, revoked, stamped };
  }, { maxWait: 10_000, timeout: 120_000 });
}

module.exports = {
  CAMPAIGN_CAUSAL_V1_SETTING_KEY,
  campaignCausalV1State,
  activateCampaignCausalV1,
};
