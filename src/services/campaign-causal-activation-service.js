"use strict";
const { classifyCommitConflict } = require("./db-commit-kernel");
const { runDbTransaction } = require("./db-transaction-service");


const prisma = require("../prisma");

const CAMPAIGN_CAUSAL_V1_SETTING_KEY = "phase3.campaignCausalObservationV1";
const CAMPAIGN_WRITER_GENERATION_GUC = "onlinod.campaign_writer_generation";
const CAMPAIGN_CLAIM_GENERATION_GUC = "onlinod.campaign_claim_generation";
const CAMPAIGN_WRITER_FENCE_MIGRATION = "20260918003000_phase3_campaign_writer_generation_fence";
const CAMPAIGN_CLAIM_FENCE_MIGRATION = "20260918150000_phase3_campaign_claim_generation_fence";
const CAMPAIGN_PHYSICAL_FENCE_TRIGGERS = Object.freeze([
  Object.freeze({ name: "phase3_campaign_writer_generation_ingest_guard_trg", table: "AnalyticsIngestBatch", fn: "phase3_campaign_writer_generation_guard" }),
  Object.freeze({ name: "phase3_campaign_writer_generation_identity_guard_trg", table: "CreatorFan", fn: "phase3_campaign_writer_generation_guard" }),
  Object.freeze({ name: "phase3_campaign_writer_generation_value_guard_trg", table: "CreatorFanValueCurrent", fn: "phase3_campaign_writer_generation_guard" }),
  Object.freeze({ name: "phase3_campaign_claim_generation_guard_trg", table: "JobInstance", fn: "phase3_campaign_claim_generation_guard" }),
]);
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

function claimGenerationActiveValue(value) {
  return object(value).claimGenerationActive === true;
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
    claimGenerationActive: claimGenerationActiveValue(normalized),
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

async function enterCampaignClaimGeneration({ db = prisma } = {}) {
  const state = await campaignCausalV1State({ db, lockForCommit: false });
  if (!state.claimGenerationActive) return state;
  if (!state.writerGeneration) throw new Error("CAMPAIGN_CLAIM_GENERATION_INVALID");
  if (typeof db.$queryRawUnsafe !== "function") {
    throw new Error("CAMPAIGN_CLAIM_GENERATION_SESSION_UNAVAILABLE");
  }
  await db.$queryRawUnsafe(
    "SELECT set_config($1, $2, true) AS \"campaignClaimGeneration\"",
    CAMPAIGN_CLAIM_GENERATION_GUC,
    String(state.writerGeneration),
  );
  return state;
}

function physicalFenceError(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

async function assertCampaignActivationPhysicalFences({ db }) {
  if (typeof db?.$queryRawUnsafe !== "function") {
    throw physicalFenceError("CAMPAIGN_ACTIVATION_PHYSICAL_PREFLIGHT_UNAVAILABLE", "PostgreSQL catalog access is required");
  }
  const triggerRows = await db.$queryRawUnsafe(`
    SELECT
      t.tgname AS "triggerName",
      c.relname AS "tableName",
      t.tgenabled AS "enabled",
      p.proname AS "functionName",
      pg_get_functiondef(p.oid) AS "functionDefinition"
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal
      AND t.tgname IN (
        'phase3_campaign_writer_generation_ingest_guard_trg',
        'phase3_campaign_writer_generation_identity_guard_trg',
        'phase3_campaign_writer_generation_value_guard_trg',
        'phase3_campaign_claim_generation_guard_trg'
      )
  `);
  const byName = new Map((Array.isArray(triggerRows) ? triggerRows : []).map((row) => [String(row?.triggerName || ""), row]));
  for (const expected of CAMPAIGN_PHYSICAL_FENCE_TRIGGERS) {
    const row = byName.get(expected.name);
    if (!row) throw physicalFenceError("CAMPAIGN_ACTIVATION_TRIGGER_PREFLIGHT_FAILED", `missing trigger ${expected.name}`);
    if (String(row.tableName || "") !== expected.table) {
      throw physicalFenceError("CAMPAIGN_ACTIVATION_TRIGGER_PREFLIGHT_FAILED", `${expected.name} table mismatch`);
    }
    if (String(row.functionName || "") !== expected.fn) {
      throw physicalFenceError("CAMPAIGN_ACTIVATION_TRIGGER_PREFLIGHT_FAILED", `${expected.name} function mismatch`);
    }
    const functionDefinition = String(row.functionDefinition || "");
    if (expected.fn === "phase3_campaign_writer_generation_guard"
        && (!functionDefinition.includes("onlinod.campaign_writer_generation")
          || !functionDefinition.includes("CAMPAIGN_WRITER_GENERATION_RETIRED"))) {
      throw physicalFenceError("CAMPAIGN_ACTIVATION_TRIGGER_PREFLIGHT_FAILED", `${expected.fn} definition mismatch`);
    }
    if (expected.fn === "phase3_campaign_claim_generation_guard"
        && (!functionDefinition.includes("onlinod.campaign_claim_generation")
          || !functionDefinition.includes("CAMPAIGN_CLAIM_GENERATION_RETIRED"))) {
      throw physicalFenceError("CAMPAIGN_ACTIVATION_TRIGGER_PREFLIGHT_FAILED", `${expected.fn} definition mismatch`);
    }
    if (!["O", "A"].includes(String(row.enabled || ""))) {
      throw physicalFenceError("CAMPAIGN_ACTIVATION_TRIGGER_PREFLIGHT_FAILED", `${expected.name} disabled`);
    }
  }

  const migrationRows = await db.$queryRawUnsafe(`
    SELECT
      "migration_name" AS "migrationName",
      "finished_at" AS "finishedAt",
      "rolled_back_at" AS "rolledBackAt"
    FROM "_prisma_migrations"
    WHERE "migration_name" IN (
      '${CAMPAIGN_WRITER_FENCE_MIGRATION}',
      '${CAMPAIGN_CLAIM_FENCE_MIGRATION}'
    )
  `);
  const migrations = new Map((Array.isArray(migrationRows) ? migrationRows : []).map((row) => [String(row?.migrationName || ""), row]));
  for (const name of [CAMPAIGN_WRITER_FENCE_MIGRATION, CAMPAIGN_CLAIM_FENCE_MIGRATION]) {
    const row = migrations.get(name);
    if (!row || !row.finishedAt || row.rolledBackAt) {
      throw physicalFenceError("CAMPAIGN_ACTIVATION_MIGRATION_PREFLIGHT_FAILED", `migration ${name} is not fully applied`);
    }
  }
  return { ok: true, triggerCount: CAMPAIGN_PHYSICAL_FENCE_TRIGGERS.length, migrationCount: 2 };
}

function retryableActivationError(error) {
  return Boolean(classifyCommitConflict(error));
}

async function activateCampaignCausalV1Once({ db, activatedBy, maxAttempts, retryBaseMs }) {
  return runDbTransaction(db, async (tx) => {
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
    await assertCampaignActivationPhysicalFences({ db: tx });
    if ((previousState.writerGenerationActive || previousState.claimGenerationActive) && !previousState.writerGeneration) {
      throw physicalFenceError("CAMPAIGN_ACTIVATION_GENERATION_STATE_INVALID", "active physical generation has no writerGeneration");
    }
    if (previousState.active && previousState.writerGenerationActive && previousState.claimGenerationActive) {
      return {
        active: true,
        writerGenerationActive: true,
        claimGenerationActive: true,
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
    const writerGeneration = previousState.writerGenerationActive && previousState.writerGeneration > 0
      ? previousState.writerGeneration
      : Math.max(0, previousState.writerGeneration) + 1;
    const activatedAt = previousState.active && previous.activatedAt
      ? previous.activatedAt
      : new Date().toISOString();
    const writerGenerationActivatedAt = previousState.writerGenerationActive && previous.writerGenerationActivatedAt
      ? previous.writerGenerationActivatedAt
      : new Date().toISOString();
    const claimGenerationActivatedAt = new Date().toISOString();
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
          writerGenerationActivatedBy: previousState.writerGenerationActive && previous.writerGenerationActivatedBy
            ? previous.writerGenerationActivatedBy
            : String(activatedBy || "operator").slice(0, 120),
          claimGenerationActive: true,
          claimGenerationActivatedAt,
          claimGenerationActivatedBy: String(activatedBy || "operator").slice(0, 120),
        },
      },
    });
    return {
      active: true,
      writerGenerationActive: true,
      claimGenerationActive: true,
      writerGeneration,
      alreadyActive: false,
      epoch,
      revoked,
      stamped,
    };
  }, { maxWait: 10_000, timeout: 120_000, deadlineMs: 120_000, maxAttempts, retryBaseMs,
    authority: { kind: "CONTROL", operation: "CAMPAIGN_GENERATION_ACTIVATION" } });
}

async function activateCampaignCausalV1({
  db = prisma,
  activatedBy = "operator",
  maxAttempts = DEFAULT_ACTIVATION_ATTEMPTS,
  retryBaseMs = DEFAULT_ACTIVATION_RETRY_BASE_MS,
} = {}) {
  return activateCampaignCausalV1Once({ db, activatedBy,
    maxAttempts: Math.max(1, Math.min(5, Number(maxAttempts) || DEFAULT_ACTIVATION_ATTEMPTS)),
    retryBaseMs: Math.max(1, Math.min(1000, Number(retryBaseMs) || 1)),
  });
}

module.exports = {
  CAMPAIGN_CAUSAL_V1_SETTING_KEY,
  CAMPAIGN_WRITER_GENERATION_GUC,
  CAMPAIGN_CLAIM_GENERATION_GUC,
  CAMPAIGN_WRITER_FENCE_MIGRATION,
  CAMPAIGN_CLAIM_FENCE_MIGRATION,
  campaignCausalV1State,
  enterCampaignWriterGeneration,
  enterCampaignClaimGeneration,
  assertCampaignActivationPhysicalFences,
  retryableActivationError,
  activateCampaignCausalV1,
};
