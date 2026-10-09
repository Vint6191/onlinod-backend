"use strict";


const prisma = require("../prisma");

const CAMPAIGN_CAUSAL_V1_SETTING_KEY = "phase3.campaignCausalObservationV1";
const CAMPAIGN_WRITER_GENERATION_GUC = "onlinod.campaign_writer_generation";
const CAMPAIGN_CLAIM_GENERATION_GUC = "onlinod.campaign_claim_generation";
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
async function enterCampaignObservationWriter({ db = prisma } = {}) {
  // Observation-version triggers invalidate frontier proofs written by older
  // binaries during a rolling deploy. This marker is transaction-local.
  if (typeof db.$executeRawUnsafe === "function") {
    await db.$executeRawUnsafe("SELECT set_config('onlinod.campaign_observation_version', '1', true)");
    await db.$executeRawUnsafe("SELECT set_config('onlinod.campaign_directory_count_version', '1', true)");
    await db.$executeRawUnsafe("SELECT set_config('onlinod.campaign_traversal_authority_version', '1', true), set_config('onlinod.campaign_fair_pages_version', '1', true)");
  }
}

async function enterCampaignWriterGeneration({ db = prisma } = {}) {
  await enterCampaignObservationWriter({ db });
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

async function enterCampaignBoundedExecution({ db = prisma } = {}) {
  if (typeof db.$executeRawUnsafe === "function") {
    await db.$executeRawUnsafe("SELECT set_config('onlinod.campaign_bounded_traversal_version', '1', true)");
    await db.$executeRawUnsafe("SELECT set_config('onlinod.campaign_traversal_authority_version', '1', true), set_config('onlinod.campaign_fair_pages_version', '1', true)");
  }
}
async function enterCampaignClaimGeneration({ db = prisma } = {}) {
  await enterCampaignBoundedExecution({ db });
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

module.exports = {
  CAMPAIGN_CAUSAL_V1_SETTING_KEY, CAMPAIGN_WRITER_GENERATION_GUC, CAMPAIGN_CLAIM_GENERATION_GUC,
  campaignCausalV1State, enterCampaignObservationWriter, enterCampaignWriterGeneration,
  enterCampaignBoundedExecution, enterCampaignClaimGeneration,
};
