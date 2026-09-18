"use strict";

const prisma = require("../prisma");

const CAMPAIGN_CAUSAL_V1_SETTING_KEY = "phase3.campaignCausalObservationV1";
const CAMPAIGN_WRITER_GENERATION_GUC = "onlinod.campaign_writer_generation";
const DEFAULT_ACTIVATION_ATTEMPTS = 4;
const DEFAULT_ACTIVATION_RETRY_BASE_MS = 50;

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function activeValue(value) {
  return object(value).active === true;
}

function writerGenerationActiveValue(value) {
  return object(value).writerGenerationActive === true;
}

function positiveInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function activationState(value) {
  const normalized = object(value);
  return {
    active: activeValue(normalized),
    writerGenerationActive: writerGenerationActiveValue(normalized),
    epoch: Math.max(0, Number(normalized.epoch || 0) || 0),
    writerGeneration: positiveInteger(normalized.writerGeneration, 0),
    value: normalized,
  };
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
      if (typeof db.systemSetting?.findUnique !== "function") return activationState({});
      throw error;
    }
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !Object.hasOwn(row, "value")) {
      if (typeof db.systemSetting?.findUnique !== "function") return activationState({});
      throw new Error("CAMPAIGN_CAUSAL_V1_BARRIER_MISSING");
    }
    return activationState(row.value);
  }
  // Tiny in-memory transaction doubles used by legacy unit suites may not expose
  // SystemSetting. Production Prisma always exposes it; keep those doubles in
  // pre-activation bridge mode rather than weakening the production barrier.
  if (typeof db.systemSetting?.findUnique !== "function") return activationState({});
  const row = await db.systemSetting.findUnique({ where: { key: CAMPAIGN_CAUSAL_V1_SETTING_KEY } });
  return activationState(row?.value);
}

// Enter the exact DB-backed Campaign writer generation for the current
// transaction. The SystemSetting row is share-locked until transaction commit.
// A migration trigger takes the same share lock for every CAMPAIGNS ingest-batch
// write and rejects sessions whose transaction-local generation marker does not
// equal the activated writer generation. Old Backend binaries never set this GUC
// and therefore fail closed after writerGenerationActive becomes true.
async function enterCampaignWriterGeneration({ db = prisma } = {}) {
  if (typeof db.$queryRawUnsafe !== "function") {
    const state = await campaignCausalV1State({ db, lockForCommit: false });
    if (state.writerGenerationActive) throw new Error("CAMPAIGN_WRITER_GENERATION_SESSION_UNAVAILABLE");
    return state;
  }

  let rows;
  try {
    rows = await db.$queryRawUnsafe(
      'SELECT "value" FROM "SystemSetting" WHERE "key" = $1 FOR SHARE',
      CAMPAIGN_CAUSAL_V1_SETTING_KEY,
    );
  } catch (error) {
    if (typeof db.systemSetting?.findUnique !== "function") return activationState({});
    throw error;
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || !Object.hasOwn(row, "value")) {
    if (typeof db.systemSetting?.findUnique !== "function") return activationState({});
    throw new Error("CAMPAIGN_CAUSAL_V1_BARRIER_MISSING");
  }
  const state = activationState(row.value);
  if (!state.writerGenerationActive) return state;
  if (!state.writerGeneration) throw new Error("CAMPAIGN_WRITER_GENERATION_INVALID");

  await db.$queryRawUnsafe(
    "SELECT set_config($1, $2, true) AS \"campaignWriterGeneration\"",
    CAMPAIGN_WRITER_GENERATION_GUC,
    String(state.writerGeneration),
  );
  return state;
}

function errorCodeCandidates(error) {
  return [
    error?.code,
    error?.meta?.code,
    error?.cause?.code,
    error?.cause?.meta?.code,
  ].filter(Boolean).map((value) => String(value));
}

function retryableActivationError(error) {
  const codes = new Set(errorCodeCandidates(error));
  if (codes.has("40P01") || codes.has("40001") || codes.has("P2034")) return true;
  return /deadlock detected|serialization failure|write conflict|transaction conflict/i.test(String(error?.message || ""));
}

function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function activateCampaignCausalV1Once({ db, activatedBy }) {
  return db.$transaction(async (tx) => {
    if (typeof tx.$queryRawUnsafe !== "function") throw new Error("CAMPAIGN_CAUSAL_V1_DB_LOCK_UNAVAILABLE");

    // Lock order is intentionally JobInstance -> activation barrier, matching
    // /jobs/progress (which already fences the live JobInstance before Campaign
    // ledger work). Old Backend generations therefore cannot form the previous
    // JobInstance -> barrier / barrier -> JobInstance deadlock cycle. We lock all
    // live Campaign rows before the barrier so no SCHEDULED/PAUSED row can be
    // claimed while the generation cutover is being established.
    await tx.$queryRawUnsafe(`
      SELECT "id"
      FROM "JobInstance"
      WHERE "jobKey" = 'fetch_campaigns'
        AND "status" IN ('CLAIMED', 'SCHEDULED', 'PAUSED')
      FOR UPDATE
    `);

    const rows = await tx.$queryRawUnsafe(
      'SELECT "value" FROM "SystemSetting" WHERE "key" = $1 FOR UPDATE',
      CAMPAIGN_CAUSAL_V1_SETTING_KEY,
    );
    if (!Array.isArray(rows) || !rows[0]) throw new Error("CAMPAIGN_CAUSAL_V1_BARRIER_MISSING");
    const previous = object(rows[0].value);
    const previousState = activationState(previous);
    if (previousState.active && previousState.writerGenerationActive) {
      return {
        active: true,
        writerGenerationActive: true,
        writerGeneration: previousState.writerGeneration,
        alreadyActive: true,
        revoked: 0,
        stamped: 0,
      };
    }

    // One set-based activation fence. Every currently CLAIMED Campaign owner is
    // revoked because a mixed-version Backend could have leased a v1-stamped row
    // to an old Desktop before the bridge fleet was drained. Exact old-revision
    // read leases are deleted before the job revision advances. Scheduled/paused
    // rows are protocol-stamped in the same transaction. The rows are already
    // locked above; the CTE re-select is therefore non-blocking and keeps the
    // cutover set explicit in one statement.
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

    const epoch = previousState.active
      ? Math.max(1, previousState.epoch)
      : previousState.epoch + 1;
    const writerGeneration = Math.max(0, previousState.writerGeneration) + 1;
    const activatedAt = previousState.active && previous.activatedAt
      ? previous.activatedAt
      : new Date().toISOString();
    const writerGenerationActivatedAt = new Date().toISOString();
    await tx.systemSetting.update({
      where: { key: CAMPAIGN_CAUSAL_V1_SETTING_KEY },
      data: {
        value: {
          ...previous,
          active: true,
          epoch,
          activatedAt,
          activatedBy: previousState.active && previous.activatedBy
            ? previous.activatedBy
            : String(activatedBy || "operator").slice(0, 120),
          writerGenerationActive: true,
          writerGeneration,
          writerGenerationActivatedAt,
          writerGenerationActivatedBy: String(activatedBy || "operator").slice(0, 120),
        },
      },
    });
    return {
      active: true,
      writerGenerationActive: true,
      writerGeneration,
      alreadyActive: false,
      epoch,
      revoked,
      stamped,
    };
  }, { maxWait: 10_000, timeout: 120_000 });
}

async function activateCampaignCausalV1({
  db = prisma,
  activatedBy = "operator",
  maxAttempts = DEFAULT_ACTIVATION_ATTEMPTS,
  retryBaseMs = DEFAULT_ACTIVATION_RETRY_BASE_MS,
} = {}) {
  const attempts = Math.max(1, Math.min(8, Number(maxAttempts) || DEFAULT_ACTIVATION_ATTEMPTS));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await activateCampaignCausalV1Once({ db, activatedBy });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !retryableActivationError(error)) throw error;
      const delayMs = Math.min(2_000, Math.max(0, Number(retryBaseMs) || 0) * (2 ** (attempt - 1)));
      await sleep(delayMs);
    }
  }
  throw lastError || new Error("CAMPAIGN_CAUSAL_V1_ACTIVATION_FAILED");
}

module.exports = {
  CAMPAIGN_CAUSAL_V1_SETTING_KEY,
  CAMPAIGN_WRITER_GENERATION_GUC,
  campaignCausalV1State,
  enterCampaignWriterGeneration,
  retryableActivationError,
  activateCampaignCausalV1,
};
