"use strict";

const { randomUUID } = require("node:crypto");
const prisma = require("../prisma");
const { withDbAdvisoryXactLock } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");

const COLLECTION_CONTRACT_VERSION = 1;
const COLLECTOR_TYPES = Object.freeze({
  EARNINGS: "EARNINGS",
  NOTIFICATIONS: "NOTIFICATIONS",
  FINANCIAL: "FINANCIAL",
  CAMPAIGNS: "CAMPAIGNS",
});

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function clean(value, max = 220) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}
function date(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
function mode(value) {
  return String(value || "").trim().toLowerCase() === "catchup" ? "catchup" : "full";
}

function collectorPlanningProofAt(collectorType, collectionMode, state) {
  const requestedMode = mode(collectionMode);
  if (collectorType === COLLECTOR_TYPES.NOTIFICATIONS) {
    return requestedMode === "catchup"
      ? date(state?.lastCatchupVerifiedAt) || date(state?.fullBackfillVerifiedAt)
      : date(state?.fullBackfillVerifiedAt);
  }
  if (collectorType === COLLECTOR_TYPES.FINANCIAL || collectorType === COLLECTOR_TYPES.CAMPAIGNS) {
    return requestedMode === "catchup"
      ? date(state?.lastCatchupCompletedAt) || date(state?.baselineVerifiedAt)
      : date(state?.baselineVerifiedAt);
  }
  return null;
}

function buildCollectionPlanningDedupeParams({ collectorType, collectionMode = "full", state = null } = {}) {
  if (!Object.values(COLLECTOR_TYPES).includes(collectorType)) throw new Error("ANALYTICS_COLLECTOR_TYPE_INVALID");
  const requestedMode = mode(collectionMode);
  const proofAt = collectorPlanningProofAt(collectorType, requestedMode, state);
  const generation = clean(state?.activeGeneration, 120) || "none";
  const orderingAfter = date(state?.activeRequestedAt);
  // Planning identity describes the durable collection epoch and requested
  // provider traversal only. Trigger provenance (manual/automatic/reason) and
  // the newly generated command UUID are deliberately excluded so every caller
  // converges on one creator+collector+mode command for the same proven state.
  return {
    planningEpoch: `${generation}:${proofAt ? proofAt.toISOString() : "none"}`,
    collectionOrderingAfter: orderingAfter ? orderingAfter.toISOString() : "none",
    collectionContractVersion: COLLECTION_CONTRACT_VERSION,
    collectionType: collectorType,
    collectionMode: requestedMode,
  };
}

function buildCollectionCommand({ collectorType, collectionMode = "full", reason, now = new Date() } = {}) {
  if (!Object.values(COLLECTOR_TYPES).includes(collectorType)) throw new Error("ANALYTICS_COLLECTOR_TYPE_INVALID");
  const requestedAt = date(now);
  if (!requestedAt) throw new Error("ANALYTICS_COLLECTION_CLOCK_INVALID");
  return {
    collectionContractVersion: COLLECTION_CONTRACT_VERSION,
    collectionType: collectorType,
    collectionMode: mode(collectionMode),
    collectionGeneration: randomUUID(),
    collectionRequestedAt: requestedAt.toISOString(),
    collectionReason: clean(reason, 120) || "CREATOR_ANALYTICS",
  };
}

function onlyFansUtcDateTime(value) {
  return new Date(value).toISOString().slice(0, 19).replace("T", " ");
}

function stampCollectionAuthorityParams(params, authorityNow, orderingAfter = null) {
  const source = object(params);
  const at = date(authorityNow);
  if (!at) throw new Error("ANALYTICS_COLLECTION_AUTHORITY_CLOCK_INVALID");
  const previous = date(orderingAfter);
  // PostgreSQL owns physical source time, while command ordering is a logical
  // monotonic clock. DateTime crosses Prisma/JS at millisecond precision, so a
  // second command in the same DB millisecond (or after a DB clock correction)
  // must still sort strictly after the durable command it supersedes.
  const orderingAt = previous && at.getTime() <= previous.getTime()
    ? new Date(previous.getTime() + 1)
    : at;
  const type = clean(source.collectionType, 40);
  const stamped = { ...source, collectionAuthorityRequestedAt: orderingAt.toISOString() };
  if (type === COLLECTOR_TYPES.FINANCIAL) {
    const marker = Math.floor(at.getTime() / 1000);
    stamped.initialMarker = marker;
    stamped.endDate = onlyFansUtcDateTime(new Date(marker * 1000));
  } else if (type === COLLECTOR_TYPES.NOTIFICATIONS) {
    // Notification transport accepts a small forward tolerance, but the anchor
    // is PostgreSQL time rather than whichever backend replica planned first.
    stamped.to = new Date(at.getTime() + 5 * 60 * 1000).toISOString();
  }
  return stamped;
}

function collectionCommand(job, expectedType) {
  const params = object(job?.params);
  const version = Number(params.collectionContractVersion);
  const type = clean(params.collectionType, 40);
  const generation = clean(params.collectionGeneration, 120);
  // collectionRequestedAt remains command provenance for Desktop/old queued jobs.
  // New jobs also carry collectionAuthorityRequestedAt, stamped from PostgreSQL
  // while the backend collector planning lock is held. Ordering must prefer the
  // DB-owned clock so replica wall-clock skew cannot poison current generation.
  const requestedAt = date(params.collectionAuthorityRequestedAt ?? params.collectionRequestedAt);
  const requestedMode = mode(params.collectionMode || params.notificationMode || params.financialMode || params.campaignMode);
  if (version !== COLLECTION_CONTRACT_VERSION || type !== expectedType || !generation || !requestedAt) {
    const error = new Error(`Invalid ${expectedType} collection command`);
    error.code = "ANALYTICS_COLLECTION_COMMAND_INVALID";
    throw error;
  }
  return {
    version,
    type,
    generation,
    requestedAt,
    mode: requestedMode,
    reason: clean(params.collectionReason, 120) || "CREATOR_ANALYTICS",
  };
}

function collectorLockKey(type, creatorId) {
  return `analytics-collector:${String(type || "unknown").toLowerCase()}:${String(creatorId || "missing")}`;
}

async function withCollectorStateLock({ db, type, creatorId, work }) {
  if (typeof work !== "function") throw new TypeError("Collector state lock requires work callback");
  // Production Prisma/TransactionClient always supports raw SQL. Tiny unit-test
  // doubles may not; they exercise the authority state machine without
  // pretending to validate PostgreSQL lock behavior.
  if (typeof db?.$executeRawUnsafe !== "function" && typeof db?.$transaction !== "function") return work(db);
  return withDbAdvisoryXactLock({ db, key: collectorLockKey(type, creatorId), work });
}

function commandAuthority(current, command) {
  const currentGeneration = clean(current?.activeGeneration, 120);
  // Generation UUID is the identity of one server-issued collection command.
  // Migration/adoption may replace a legacy process-clock timestamp with a
  // PostgreSQL authority timestamp; that must never make the same generation
  // stale against itself.
  if (currentGeneration && currentGeneration === command.generation) return "CURRENT";
  const currentAt = date(current?.activeRequestedAt);
  if (!currentAt) return "INCOMING";
  const delta = currentAt.getTime() - command.requestedAt.getTime();
  if (delta > 0) return "STALE";
  if (delta < 0) return "INCOMING";
  if (!currentGeneration) return "CURRENT";
  // requestedAt has millisecond precision. If two independently planned server
  // commands collide on the same DB millisecond, the generation that acquired
  // the collector lock first remains authoritative; never fall back to
  // arrival-order last-writer-wins between different generations.
  return "STALE";
}

function sameGeneration(current, command) {
  return clean(current?.activeGeneration, 120) === command.generation;
}

function completedForCommand(current, command) {
  if (!sameGeneration(current, command) || String(current?.status || "").toUpperCase() !== "COMPLETE") return false;
  return command.mode === "catchup"
    ? clean(current?.lastCatchupGeneration, 120) === command.generation
    : clean(current?.baselineGeneration, 120) === command.generation;
}

async function acceptFinancialGeneration({ db = prisma, job, deviceId = null } = {}) {
  const command = collectionCommand(job, COLLECTOR_TYPES.FINANCIAL);
  return withCollectorStateLock({ db, type: COLLECTOR_TYPES.FINANCIAL, creatorId: job.creatorId, work: async (tx) => {
    const existing = await tx.creatorFinancialCollectionState.findUnique({ where: { creatorId: job.creatorId } });
    const authority = commandAuthority(existing, command);
    if (authority === "STALE") return { accepted: false, stale: true, command, state: existing };
    if (authority === "CURRENT" && ["COMPLETE", "PARTIAL"].includes(String(existing?.status || "").toUpperCase())) {
      return { accepted: true, stale: false, replay: true, command, state: existing };
    }
    if (authority === "CURRENT" && String(existing?.status || "").toUpperCase() === "FAILED" && !existing?.retryAfterAt) {
      return { accepted: false, stale: true, terminal: true, command, state: existing };
    }
    const data = {
      status: "SCANNING", mode: command.mode, activeGeneration: command.generation, activeRequestedAt: command.requestedAt,
      retryAfterAt: null, lastErrorCode: null, lastErrorMessage: null, sourceDeviceId: clean(deviceId, 220), sourceJobId: clean(job.id, 220),
    };
    const state = await tx.creatorFinancialCollectionState.upsert({
      where: { creatorId: job.creatorId },
      create: { agencyId: job.agencyId, creatorId: job.creatorId, ...data },
      update: data,
    });
    return { accepted: true, stale: false, command, state };
  }});
}

async function completeFinancialCollection({ db = prisma, job, deviceId = null, complete, scanRunId, boundary = null, rangeFrom = null, rangeTo = null } = {}) {
  const command = collectionCommand(job, COLLECTOR_TYPES.FINANCIAL);
  return withCollectorStateLock({ db, type: COLLECTOR_TYPES.FINANCIAL, creatorId: job.creatorId, work: async (tx) => {
    const current = await tx.creatorFinancialCollectionState.findUnique({ where: { creatorId: job.creatorId } });
    if (commandAuthority(current, command) === "STALE") return { applied: false, stale: true, command, state: current };
    if (complete === true && completedForCommand(current, command)) {
      return { applied: true, stale: false, replay: true, command, state: current, scanRunId: clean(scanRunId, 120) };
    }
    const now = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
    const success = complete === true;
    const common = {
      status: success ? "COMPLETE" : "PARTIAL", mode: command.mode, activeGeneration: command.generation, activeRequestedAt: command.requestedAt,
      retryAfterAt: null, lastErrorCode: success ? null : "FINANCIAL_COLLECTION_PARTIAL",
      lastErrorMessage: success ? null : "Financial collection did not prove its requested source boundary",
      sourceDeviceId: clean(deviceId, 220), sourceJobId: clean(job.id, 220),
    };
    const successData = success && command.mode === "full" ? {
      baselineVerifiedAt: now, baselineGeneration: command.generation, baselineRangeFrom: date(rangeFrom), baselineRangeTo: date(rangeTo),
    } : success && command.mode === "catchup" ? {
      lastCatchupCompletedAt: now, lastCatchupGeneration: command.generation, lastBoundary: clean(boundary, 220),
    } : {};
    const state = await tx.creatorFinancialCollectionState.upsert({
      where: { creatorId: job.creatorId }, create: { agencyId: job.agencyId, creatorId: job.creatorId, ...common, ...successData }, update: { ...common, ...successData },
    });
    return { applied: true, stale: false, command, state, scanRunId: clean(scanRunId, 120) };
  }});
}

async function recordFinancialCollectionFailure({ db = prisma, job, error, terminal = true, retryAfterAt = null } = {}) {
  let command;
  try { command = collectionCommand(job, COLLECTOR_TYPES.FINANCIAL); } catch { return null; }
  return withCollectorStateLock({ db, type: COLLECTOR_TYPES.FINANCIAL, creatorId: job.creatorId, work: async (tx) => {
    const current = await tx.creatorFinancialCollectionState.findUnique({ where: { creatorId: job.creatorId } });
    if (commandAuthority(current, command) === "STALE" || completedForCommand(current, command)) return current;
    const retryAt = terminal ? null : date(retryAfterAt) || new Date((await dbAuthorityNow({ db: tx, fallbackNow: new Date() })).getTime() + 5 * 60 * 1000);
    const data = {
      status: "FAILED", mode: command.mode, activeGeneration: command.generation, activeRequestedAt: command.requestedAt, retryAfterAt: retryAt,
      lastErrorCode: "FINANCIAL_COLLECTION_FAILED", lastErrorMessage: clean(error?.message || error, 2000), sourceJobId: clean(job.id, 220),
    };
    return tx.creatorFinancialCollectionState.upsert({
      where: { creatorId: job.creatorId }, create: { agencyId: job.agencyId, creatorId: job.creatorId, ...data }, update: data,
    });
  }});
}

async function acceptCampaignGeneration({ db = prisma, job, deviceId = null } = {}) {
  const command = collectionCommand(job, COLLECTOR_TYPES.CAMPAIGNS);
  return withCollectorStateLock({ db, type: COLLECTOR_TYPES.CAMPAIGNS, creatorId: job.creatorId, work: async (tx) => {
    const existing = await tx.creatorCampaignCollectionState.findUnique({ where: { creatorId: job.creatorId } });
    const authority = commandAuthority(existing, command);
    if (authority === "STALE") return { accepted: false, stale: true, command, state: existing };
    if (authority === "CURRENT" && ["COMPLETE", "PARTIAL"].includes(String(existing?.status || "").toUpperCase())) {
      return { accepted: true, stale: false, replay: true, command, state: existing };
    }
    if (authority === "CURRENT" && String(existing?.status || "").toUpperCase() === "FAILED" && !existing?.retryAfterAt) {
      return { accepted: false, stale: true, terminal: true, command, state: existing };
    }
    const data = {
      status: "SCANNING", mode: command.mode, activeGeneration: command.generation, activeRequestedAt: command.requestedAt, retryAfterAt: null,
      lastErrorCode: null, lastErrorMessage: null, sourceDeviceId: clean(deviceId, 220), sourceJobId: clean(job.id, 220),
    };
    const state = await tx.creatorCampaignCollectionState.upsert({
      where: { creatorId: job.creatorId }, create: { agencyId: job.agencyId, creatorId: job.creatorId, ...data }, update: data,
    });
    return { accepted: true, stale: false, command, state };
  }});
}

async function completeCampaignCollection({ db = prisma, job, deviceId = null, complete, scanRunId } = {}) {
  const command = collectionCommand(job, COLLECTOR_TYPES.CAMPAIGNS);
  return withCollectorStateLock({ db, type: COLLECTOR_TYPES.CAMPAIGNS, creatorId: job.creatorId, work: async (tx) => {
    const current = await tx.creatorCampaignCollectionState.findUnique({ where: { creatorId: job.creatorId } });
    if (commandAuthority(current, command) === "STALE") return { applied: false, stale: true, command, state: current };
    if (complete === true && completedForCommand(current, command)) {
      return { applied: true, stale: false, replay: true, command, state: current };
    }
    const now = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
    const success = complete === true;
    const common = {
      status: success ? "COMPLETE" : "PARTIAL", mode: command.mode, activeGeneration: command.generation, activeRequestedAt: command.requestedAt,
      retryAfterAt: null, lastErrorCode: success ? null : "CAMPAIGN_COLLECTION_PARTIAL",
      lastErrorMessage: success ? null : "Campaign collection did not prove all requested campaign/claimer/value frontiers",
      sourceDeviceId: clean(deviceId, 220), sourceJobId: clean(job.id, 220), ...(success ? { lastCompleteScanRunId: clean(scanRunId, 120) } : {}),
    };
    const successData = success && command.mode === "full" ? { baselineVerifiedAt: now, baselineGeneration: command.generation }
      : success && command.mode === "catchup" ? { lastCatchupCompletedAt: now, lastCatchupGeneration: command.generation } : {};
    const state = await tx.creatorCampaignCollectionState.upsert({
      where: { creatorId: job.creatorId }, create: { agencyId: job.agencyId, creatorId: job.creatorId, ...common, ...successData }, update: { ...common, ...successData },
    });
    return { applied: true, stale: false, command, state };
  }});
}

async function recordCampaignCollectionFailure({ db = prisma, job, error, terminal = true, retryAfterAt = null } = {}) {
  let command;
  try { command = collectionCommand(job, COLLECTOR_TYPES.CAMPAIGNS); } catch { return null; }
  return withCollectorStateLock({ db, type: COLLECTOR_TYPES.CAMPAIGNS, creatorId: job.creatorId, work: async (tx) => {
    const current = await tx.creatorCampaignCollectionState.findUnique({ where: { creatorId: job.creatorId } });
    if (commandAuthority(current, command) === "STALE" || completedForCommand(current, command)) return current;
    const retryAt = terminal ? null : date(retryAfterAt) || new Date((await dbAuthorityNow({ db: tx, fallbackNow: new Date() })).getTime() + 5 * 60 * 1000);
    const data = {
      status: "FAILED", mode: command.mode, activeGeneration: command.generation, activeRequestedAt: command.requestedAt, retryAfterAt: retryAt,
      lastErrorCode: "CAMPAIGN_COLLECTION_FAILED", lastErrorMessage: clean(error?.message || error, 2000), sourceJobId: clean(job.id, 220),
    };
    return tx.creatorCampaignCollectionState.upsert({
      where: { creatorId: job.creatorId }, create: { agencyId: job.agencyId, creatorId: job.creatorId, ...data }, update: data,
    });
  }});
}

module.exports = {
  COLLECTION_CONTRACT_VERSION,
  COLLECTOR_TYPES,
  buildCollectionCommand,
  buildCollectionPlanningDedupeParams,
  stampCollectionAuthorityParams,
  collectionCommand,
  withCollectorStateLock,
  commandAuthority,
  sameGeneration,
  acceptFinancialGeneration,
  completeFinancialCollection,
  recordFinancialCollectionFailure,
  acceptCampaignGeneration,
  completeCampaignCollection,
  recordCampaignCollectionFailure,
};
