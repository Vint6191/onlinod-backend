"use strict";

const { createHash } = require("node:crypto");
const { runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");

const FAMILY = Object.freeze({
  PROVIDER_OPERATIONAL: "PROVIDER_OPERATIONAL",
  CUSTOM_EXTERNAL_PROJECTION: "CUSTOM_EXTERNAL_PROJECTION",
  CUSTOM_SOURCE_PIPELINE: "CUSTOM_SOURCE_PIPELINE",
  TEAM_ACTIVITY_CONTRIBUTION: "TEAM_ACTIVITY_CONTRIBUTION",
  TEAM_RESPONSE_RANGE_REPAIR: "TEAM_RESPONSE_RANGE_REPAIR",
  TEAM_DIALOG_PROJECTION: "TEAM_DIALOG_PROJECTION",
  TEAM_MONEY_ROOT_CLASSIFICATION: "TEAM_MONEY_ROOT_CLASSIFICATION",
  TEAM_MONEY_RECONCILIATION: "TEAM_MONEY_RECONCILIATION",
  TEAM_READ_SUMMARY: "TEAM_READ_SUMMARY",
  TELEGRAM_CONFIRMED_PROJECTION: "TELEGRAM_CONFIRMED_PROJECTION",
  TELEGRAM_INBOUND_PROJECTION: "TELEGRAM_INBOUND_PROJECTION",
});

const GENERATION = Object.freeze({
  PROVIDER_OPERATIONAL: "phase2_provider_operational_coverage_v1",
  CUSTOM_EXTERNAL_PROJECTION: "phase2_custom_external_coverage_v1",
  CUSTOM_SOURCE_PIPELINE: "phase2_custom_source_pipeline_coverage_v1",
  TEAM_ACTIVITY_CONTRIBUTION: "phase2_team_activity_contribution_v2",
  TEAM_RESPONSE_RANGE_REPAIR: "phase2_team_response_range_v2",
  TEAM_DIALOG_PROJECTION: "phase2_team_dialog_projection_v1",
  TEAM_MONEY_ROOT_CLASSIFICATION: "phase2_team_money_root_classification_v1",
  TEAM_MONEY_RECONCILIATION: "phase2_team_money_reconciliation_v1",
  TEAM_READ_SUMMARY: "phase2_team_money_read_summary_v1",
  TELEGRAM_CONFIRMED_PROJECTION: "phase2_telegram_confirmed_projection_v1",
  TELEGRAM_INBOUND_PROJECTION: "phase2_telegram_inbound_projection_v1",
});

const ENUMERATION = Object.freeze({ PENDING: "PENDING", RUNNING: "RUNNING", COMPLETE: "COMPLETE", FAILED: "FAILED" });

const LIVE_WORK_CLASS_BY_FAMILY = Object.freeze({
  [FAMILY.CUSTOM_SOURCE_PIPELINE]: "CUSTOM_SOURCE_PIPELINE",
  [FAMILY.TEAM_RESPONSE_RANGE_REPAIR]: "TEAM_RESPONSE_RANGE_REPAIR",
  [FAMILY.TEAM_DIALOG_PROJECTION]: "TEAM_DIALOG_PROJECTION",
  [FAMILY.TEAM_MONEY_ROOT_CLASSIFICATION]: "TEAM_MONEY_RECONCILIATION",
  [FAMILY.TEAM_MONEY_RECONCILIATION]: "TEAM_MONEY_RECONCILIATION",
  [FAMILY.TEAM_READ_SUMMARY]: "TEAM_READ_SUMMARY",
  [FAMILY.TELEGRAM_CONFIRMED_PROJECTION]: "TELEGRAM_CONFIRMED_PROJECTION",
  [FAMILY.TELEGRAM_INBOUND_PROJECTION]: "TELEGRAM_INBOUND_PROJECTION",
  [FAMILY.CUSTOM_EXTERNAL_PROJECTION]: "CUSTOM_EXTERNAL_PROJECTION",
});

async function assertCoverageMutationClaim({ tx, workItem = null, ownerToken = null, fallbackNow = new Date() } = {}) {
  if (!workItem) return { guarded: false, current: true };
  const { lockDomainWorkClaimForCommit } = require("./domain-work-authority-service");
  const claim = await lockDomainWorkClaimForCommit({
    db: tx, item: workItem, ownerToken, fallbackNow,
  });
  if (!claim?.current || claim?.lost) {
    const error = new Error("Historical coverage mutation lost DomainWork ownership");
    error.code = "PHASE2_COVERAGE_WORK_OWNERSHIP_LOST";
    error.status = 409;
    error.lostOwnership = true;
    throw error;
  }
  if (claim?.newerRevision) {
    const error = new Error("Historical coverage mutation was superseded by a newer work revision");
    error.code = "PHASE2_COVERAGE_WORK_REVISION_SUPERSEDED";
    error.status = 409;
    error.lostOwnership = true;
    throw error;
  }
  return { guarded: true, current: true, claim };
}


function clean(value, max = 240) {
  const out = String(value ?? "").trim();
  return out ? out.slice(0, max) : null;
}
function coverageId({ agencyId, family, generation }) {
  return `p2cov_${createHash("md5").update([agencyId, family, generation].map((v) => String(v ?? "")).join("\u001f")).digest("hex")}`;
}
function identityWhere({ agencyId, family, generation }) {
  return { agencyId_family_generation: { agencyId: String(agencyId), family: String(family), generation: String(generation) } };
}
function normalizeIdentity({ agencyId, family, generation }) {
  const a = clean(agencyId, 180); const f = clean(family, 120); const g = clean(generation, 120);
  if (!a || !f || !g) throw Object.assign(new Error("PHASE2_COVERAGE_IDENTITY_REQUIRED"), { code: "PHASE2_COVERAGE_IDENTITY_REQUIRED" });
  return { agencyId: a, family: f, generation: g };
}

async function ensurePhase2Coverage({ db = null, agencyId, family, generation, sourceWatermark = null } = {}) {
  if (!db) db = require("../prisma");
  const identity = normalizeIdentity({ agencyId, family, generation });
  if (!db?.phase2WorkCoverage?.upsert) {
    throw Object.assign(new Error("Phase2WorkCoverage storage is unavailable"), { code: "PHASE2_COVERAGE_STORAGE_REQUIRED" });
  }
  return db.phase2WorkCoverage.upsert({
    where: identityWhere(identity),
    create: {
      id: coverageId(identity), ...identity, active: false, enumerationState: ENUMERATION.PENDING,
      sourceWatermark: clean(sourceWatermark, 500), unresolvedCount: 0,
    },
    update: sourceWatermark == null ? {} : { sourceWatermark: clean(sourceWatermark, 500) },
  });
}

async function requestPhase2CoverageEnumeration({ db = null, agencyId, family, generation, now = new Date() } = {}) {
  if (!db) db = require("../prisma");
  const identity = normalizeIdentity({ agencyId, family, generation });
  const coverage = await ensurePhase2Coverage({ db, ...identity });
  const alreadyComplete = coverage?.active === true
    && String(coverage?.enumerationState || "") === ENUMERATION.COMPLETE
    && coverage?.completedAt != null;
  if (alreadyComplete) {
    return { ok: true, requested: false, alreadyComplete: true, coverage };
  }

  const objectType = "Phase2Coverage";
  const objectId = `${identity.family}:${identity.generation}`;
  const workClass = "HISTORICAL_ENUMERATION";
  if (db?.domainWorkItem?.findUnique) {
    const existing = await db.domainWorkItem.findUnique({
      where: {
        agencyId_workClass_objectType_objectId: {
          agencyId: identity.agencyId, workClass, objectType, objectId,
        },
      },
      select: {
        id: true, state: true, requestedRevision: true, completedRevision: true,
        availableAt: true, nextAttemptAt: true, progressCursor: true,
      },
    });
    let requestedRevision = 0n;
    let completedRevision = 0n;
    try { requestedRevision = BigInt(existing?.requestedRevision || 0); } catch (_) {}
    try { completedRevision = BigInt(existing?.completedRevision || 0); } catch (_) {}
    if (existing && (String(existing.state || "") !== "DONE" || requestedRevision > completedRevision)) {
      return { ok: true, requested: false, inFlight: true, coverage, work: existing };
    }
  }

  // Lazy import keeps coverage storage independent from the execution kernel at module load
  // while still giving every manual/bootstrap request the same revisioned DomainWork authority.
  const { publishDomainWork, WORK_CLASS } = require("./domain-work-authority-service");
  const work = await publishDomainWork({
    db, agencyId: identity.agencyId, workClass: WORK_CLASS.HISTORICAL_ENUMERATION,
    objectType, objectId, parentObjectId: identity.agencyId, partitionKey: identity.agencyId,
    availableAt: now instanceof Date ? now : new Date(now),
  });
  return { ok: true, requested: true, inFlight: false, coverage, work };
}

async function markPhase2CoverageRunning({ db = null, agencyId, family, generation, enumeratedThrough = undefined, sourceWatermark = undefined, workItem = null, ownerToken = null, fallbackNow = new Date() } = {}) {
  if (!db) db = require("../prisma");
  const identity = normalizeIdentity({ agencyId, family, generation });
  return runDbTransaction(db, async (tx) => {
    await assertCoverageMutationClaim({ tx, workItem, ownerToken, fallbackNow });
    await ensurePhase2Coverage({ db: tx, ...identity, sourceWatermark });
    const data = { enumerationState: ENUMERATION.RUNNING, active: false, completedAt: null };
    if (enumeratedThrough !== undefined) data.enumeratedThrough = clean(enumeratedThrough, 500);
    if (sourceWatermark !== undefined) data.sourceWatermark = clean(sourceWatermark, 500);
    return tx.phase2WorkCoverage.update({ where: identityWhere(identity), data });
  });
}

async function markPhase2CoverageComplete({ db = null, agencyId, family, generation, enumeratedThrough = null, projectedThrough = null, unresolvedCount = 0, sourceWatermark = undefined, fallbackNow = new Date(), workItem = null, ownerToken = null } = {}) {
  if (!db) db = require("../prisma");
  const identity = normalizeIdentity({ agencyId, family, generation });
  return runDbTransaction(db, async (tx) => {
    await assertCoverageMutationClaim({ tx, workItem, ownerToken, fallbackNow });
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    await ensurePhase2Coverage({ db: tx, ...identity, sourceWatermark });
    const data = {
      active: true, enumerationState: ENUMERATION.COMPLETE,
      enumeratedThrough: clean(enumeratedThrough, 500), projectedThrough: clean(projectedThrough, 500),
      unresolvedCount: Math.max(0, Math.floor(Number(unresolvedCount) || 0)), activatedAt: authorityNow, completedAt: authorityNow,
    };
    if (sourceWatermark !== undefined) data.sourceWatermark = clean(sourceWatermark, 500);
    return tx.phase2WorkCoverage.update({ where: identityWhere(identity), data });
  });
}

async function markPhase2CoverageFailed({ db = null, agencyId, family, generation, enumeratedThrough = undefined, unresolvedCount = 1, workItem = null, ownerToken = null, fallbackNow = new Date() } = {}) {
  if (!db) db = require("../prisma");
  const identity = normalizeIdentity({ agencyId, family, generation });
  return runDbTransaction(db, async (tx) => {
    await assertCoverageMutationClaim({ tx, workItem, ownerToken, fallbackNow });
    await ensurePhase2Coverage({ db: tx, ...identity });
    const data = { active: false, enumerationState: ENUMERATION.FAILED, completedAt: null, unresolvedCount: Math.max(1, Math.floor(Number(unresolvedCount) || 1)) };
    if (enumeratedThrough !== undefined) data.enumeratedThrough = clean(enumeratedThrough, 500);
    return tx.phase2WorkCoverage.update({ where: identityWhere(identity), data });
  });
}

async function phase2CoverageStatus({ db = null, agencyId, family, generation } = {}) {
  if (!db) db = require("../prisma");
  const identity = normalizeIdentity({ agencyId, family, generation });
  const row = await db?.phase2WorkCoverage?.findUnique?.({ where: identityWhere(identity) });
  if (!row) {
    return { ready: false, historicalReady: false, currentReady: false, fresh: false, state: "MISSING", semanticState: "UNKNOWN", row: null, live: null };
  }
  const historicalReady = row.active === true && String(row.enumerationState || "") === ENUMERATION.COMPLETE && row.completedAt != null;
  const workClass = LIVE_WORK_CLASS_BY_FAMILY[identity.family] || null;
  let live = null;
  let fresh = historicalReady;
  if (workClass) {
    try {
      const { domainWorkFamilyState } = require("./domain-work-authority-service");
      live = await domainWorkFamilyState({ db, agencyId: identity.agencyId, workClass });
      fresh = historicalReady && live?.fresh === true;
    } catch (_) {
      fresh = false;
      live = { fresh: false, outstandingCount: null, state: "UNKNOWN" };
    }
  }
  const currentReady = historicalReady && fresh;
  const semanticState = !historicalReady
    ? (String(row.enumerationState || "") === ENUMERATION.FAILED ? "PARTIAL" : "TRANSITION")
    : currentReady ? "CURRENT_FRESH" : "CURRENT_STALE";
  return {
    // `ready` is retained as historical-enumeration compatibility. New current readers
    // must use currentReady/fresh; historical coverage is never live convergence proof.
    ready: historicalReady,
    historicalReady,
    currentReady,
    fresh,
    state: String(row.enumerationState || "UNKNOWN"),
    semanticState,
    row,
    live,
  };
}

async function requirePhase2CoverageReady({ db = null, agencyId, family, generation, code = "PHASE2_COVERAGE_INCOMPLETE" } = {}) {
  if (!db) db = require("../prisma");
  const status = await phase2CoverageStatus({ db, agencyId, family, generation });
  if (status.ready) return status.row;
  const error = new Error(`Phase 2 ${family} coverage is not complete for agency ${agencyId}`);
  error.code = code; error.status = 503; error.coverageState = status.state;
  throw error;
}

module.exports = {
  FAMILY, GENERATION, ENUMERATION, LIVE_WORK_CLASS_BY_FAMILY, coverageId,
  ensurePhase2Coverage, requestPhase2CoverageEnumeration, markPhase2CoverageRunning, markPhase2CoverageComplete, markPhase2CoverageFailed,
  phase2CoverageStatus, requirePhase2CoverageReady,
};
