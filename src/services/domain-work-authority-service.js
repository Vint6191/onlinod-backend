"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { domainWorkFailureOutcome } = require("./domain-work-failure-policy");
const { runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const {
  DOMAIN_WORK_EXECUTOR_GENERATION,
  authorizeDomainWorkExecutor,
  authorizeDomainWorkDependencyWakeBridge,
} = require("./phase2-release-compatibility-authority-service");

const DOMAIN_WORK_GENERATION = "phase2_domain_work_v3_actual55";
const DOMAIN_WORK_PROJECTION_VERSION = "phase2_domain_work_v3_actual55";
const DEFAULT_LEASE_MS = 2 * 60 * 1000;
const MAX_BATCH = 100;
const DOMAIN_WORK_CLAIM_SHARD_COUNT = 128;
const DOMAIN_WORK_CLAIM_TOPOLOGY_ID = "phase3_domain_work_claim_topology_a36_v1";
const DOMAIN_WORK_MEMBER_SCOPE_SHARD_PROBE = 32;
const DOMAIN_WORK_MEMBER_SCOPE_CREATOR_PROBE = 16;
const DOMAIN_DEPENDENCY_WAKE_OBJECT_TYPE = "DomainDependency";

const WORK_CLASS = Object.freeze({
  ADMIN_BILLING_PRICING: "ADMIN_BILLING_PRICING",
  CUSTOM_COMMUNICATION: "CUSTOM_COMMUNICATION",
  CUSTOM_REMINDER: "CUSTOM_REMINDER",
  CUSTOM_SOURCE_PIPELINE: "CUSTOM_SOURCE_PIPELINE",
  TELEGRAM_CONFIRMED_PROJECTION: "TELEGRAM_CONFIRMED_PROJECTION",
  TELEGRAM_INBOUND_PROJECTION: "TELEGRAM_INBOUND_PROJECTION",
  CUSTOM_EXTERNAL_PROJECTION: "CUSTOM_EXTERNAL_PROJECTION",
  TEAM_DIALOG_PROJECTION: "TEAM_DIALOG_PROJECTION",
  TEAM_RESPONSE_RANGE_REPAIR: "TEAM_RESPONSE_RANGE_REPAIR",
  TEAM_MONEY_RECONCILIATION: "TEAM_MONEY_RECONCILIATION",
  TEAM_READ_SUMMARY: "TEAM_READ_SUMMARY",
  DEPENDENCY_WAKE: "DEPENDENCY_WAKE",
  DEPENDENCY_FANOUT: "DEPENDENCY_FANOUT",
  HISTORICAL_ENUMERATION: "HISTORICAL_ENUMERATION",
  RETENTION: "RETENTION",
  DESTRUCTIVE_CREATOR_CLEANUP: "DESTRUCTIVE_CREATOR_CLEANUP",
  DESTRUCTIVE_AGENCY_CLEANUP: "DESTRUCTIVE_AGENCY_CLEANUP",
  CREATOR_RECURRING_PLANNING: "CREATOR_RECURRING_PLANNING",
});

const STATE = Object.freeze({ READY: "READY", CLAIMED: "CLAIMED", BLOCKED: "BLOCKED", RECONCILE_REQUIRED: "RECONCILE_REQUIRED", DONE: "DONE" });


// During a rolling Actual52 -> DomainWork cutover, the old maintenance authority can
// still be present on another replica. Actual52 does not understand activeGeneration
// and can rewrite a lane row under its own generation, so new current-business work
// must not start until every already-held retired legacy lane has drained. The DB
// migration separately prevents any NEW owner token from being acquired on those keys.
const LEGACY_DRAIN_WORK_CLASSES = new Set([
  WORK_CLASS.CUSTOM_COMMUNICATION,
  WORK_CLASS.CUSTOM_REMINDER,
  WORK_CLASS.CUSTOM_SOURCE_PIPELINE,
  WORK_CLASS.TELEGRAM_CONFIRMED_PROJECTION,
  WORK_CLASS.TELEGRAM_INBOUND_PROJECTION,
  WORK_CLASS.CUSTOM_EXTERNAL_PROJECTION,
  WORK_CLASS.TEAM_DIALOG_PROJECTION,
  WORK_CLASS.TEAM_RESPONSE_RANGE_REPAIR,
  WORK_CLASS.TEAM_MONEY_RECONCILIATION,
  WORK_CLASS.TEAM_READ_SUMMARY,
]);

function clean(value, max = 240) {
  const out = String(value ?? "").trim();
  return out ? out.slice(0, max) : null;
}
function asDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
function bounded(value, fallback = 25, max = MAX_BATCH) {
  const n = Math.floor(Number(value) || fallback);
  return Math.max(1, Math.min(max, n));
}
function asBigInt(value, fallback = 0n) {
  try { return BigInt(value == null ? fallback : value); } catch (_) { return BigInt(fallback); }
}
function workId({ agencyId, workClass, objectType, objectId }) {
  const identity = [agencyId, workClass, objectType, objectId].map((v) => clean(v, 1000) || "").join("\u001f");
  return `dwi_${createHash("md5").update(identity).digest("hex")}`;
}
function identityWhere({ agencyId, workClass, objectType, objectId }) {
  return { agencyId_workClass_objectType_objectId: { agencyId: String(agencyId), workClass: String(workClass), objectType: String(objectType), objectId: String(objectId) } };
}
function dependencyId({ agencyId, dependencyKind, dependencyKey }) {
  return `p2dep_${createHash("md5").update([agencyId, dependencyKind, dependencyKey].map((v) => String(v ?? "")).join("\u001f")).digest("hex")}`;
}
async function lockDependencyRevisionForBlock(tx, { agencyId, dependencyKind, dependencyKey }) {
  const identity = { agencyId: String(agencyId), dependencyKind: String(dependencyKind), dependencyKey: String(dependencyKey) };
  if (typeof tx?.$queryRawUnsafe === "function") {
    const id = dependencyId(identity);
    await tx.$queryRawUnsafe(
      `INSERT INTO "Phase2DependencyState"("id","agencyId","dependencyKind","dependencyKey","revision","changedAt","createdAt","updatedAt")
       VALUES($1,$2,$3,$4,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
       ON CONFLICT ("agencyId","dependencyKind","dependencyKey") DO NOTHING`,
      id, identity.agencyId, identity.dependencyKind, identity.dependencyKey,
    );
    const rows = await tx.$queryRawUnsafe(
      `SELECT "revision" FROM "Phase2DependencyState"
        WHERE "agencyId"=$1 AND "dependencyKind"=$2 AND "dependencyKey"=$3
        FOR UPDATE`,
      identity.agencyId, identity.dependencyKind, identity.dependencyKey,
    );
    return asBigInt(rows?.[0]?.revision, 0n);
  }
  if (tx?.phase2DependencyState?.upsert) {
    const where = { agencyId_dependencyKind_dependencyKey: identity };
    const row = await tx.phase2DependencyState.upsert({
      where,
      create: { id: dependencyId(identity), ...identity, revision: 0n, changedAt: new Date() },
      update: {},
    });
    return asBigInt(row?.revision, 0n);
  }
  return currentDependencyRevision({ db: tx, ...identity });
}
function normalizePublish(input = {}) {
  const agencyId = clean(input.agencyId, 180);
  const workClass = clean(input.workClass, 120);
  const objectType = clean(input.objectType, 120);
  const objectId = clean(input.objectId, 240);
  if (!agencyId || !workClass || !objectType || !objectId) {
    const error = new Error("Domain work identity is required"); error.code = "DOMAIN_WORK_IDENTITY_REQUIRED"; throw error;
  }
  const hasExplicitAvailableAt = input.availableAt !== undefined
    && input.availableAt !== null
    && input.availableAt !== "";
  const availableAt = hasExplicitAvailableAt ? asDate(input.availableAt) : null;
  if (hasExplicitAvailableAt && !availableAt) {
    const error = new Error("Domain work availableAt must be a valid timestamp");
    error.code = "DOMAIN_WORK_AVAILABLE_AT_INVALID";
    throw error;
  }
  return {
    id: workId({ agencyId, workClass, objectType, objectId }), agencyId, workClass, objectType, objectId,
    parentObjectId: clean(input.parentObjectId, 240),
    partitionKey: clean(input.partitionKey, 240) || agencyId,
    creatorId: clean(input.creatorId, 180), accountId: clean(input.accountId, 180),
    dependencyKind: clean(input.dependencyKind, 120), dependencyKey: clean(input.dependencyKey, 240),
    dependencyRevision: asBigInt(input.dependencyRevision, 0n),
    // null means "immediately". PostgreSQL resolves that value from its own
    // clock in the INSERT statement, so a Render/DB clock skew cannot publish
    // fresh work a few milliseconds into the database's future.
    availableAt,
    activeGeneration: clean(input.activeGeneration, 120) || DOMAIN_WORK_GENERATION,
    projectionVersion: clean(input.projectionVersion, 120) || DOMAIN_WORK_PROJECTION_VERSION,
  };
}

async function publishDomainWork({ db = null, fallbackNow = null, ...input } = {}) {
  if (!db) db = require("../prisma");
  const row = normalizePublish(input);
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(
      `INSERT INTO "DomainWorkItem"(
         "id","agencyId","workClass","objectType","objectId","parentObjectId","partitionKey","creatorId","accountId",
         "requestedRevision","completedRevision","activeGeneration","projectionVersion","state","isOutstanding","availableAt",
         "dependencyKind","dependencyKey","dependencyRevision","createdAt","updatedAt"
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,1,0,$10,$11,'READY',TRUE,
         (COALESCE($12::timestamptz,clock_timestamp()) AT TIME ZONE 'UTC')::timestamp(3),
         $13,$14,$15,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
       )
       ON CONFLICT ("agencyId","workClass","objectType","objectId") DO UPDATE SET
         "requestedRevision"="DomainWorkItem"."requestedRevision"+1,
         "parentObjectId"=COALESCE(EXCLUDED."parentObjectId","DomainWorkItem"."parentObjectId"),
         "partitionKey"=EXCLUDED."partitionKey",
         "creatorId"=COALESCE(EXCLUDED."creatorId","DomainWorkItem"."creatorId"),
         "accountId"=COALESCE(EXCLUDED."accountId","DomainWorkItem"."accountId"),
         "dependencyKind"=EXCLUDED."dependencyKind",
         "dependencyKey"=EXCLUDED."dependencyKey",
         "dependencyRevision"=GREATEST("DomainWorkItem"."dependencyRevision",EXCLUDED."dependencyRevision"),
         "state"=CASE WHEN "DomainWorkItem"."state"='CLAIMED' THEN 'CLAIMED' ELSE 'READY' END,
         "isOutstanding"=TRUE,
         "availableAt"=LEAST("DomainWorkItem"."availableAt",EXCLUDED."availableAt"),
         "nextAttemptAt"=NULL,
         "progressCursor"=CASE
           WHEN "DomainWorkItem"."state"='CLAIMED' THEN "DomainWorkItem"."progressCursor"
           WHEN "DomainWorkItem"."workClass"='TEAM_DIALOG_PROJECTION'
             AND ("DomainWorkItem"."progressCursor"->'pendingRepair') IS NOT NULL
             THEN "DomainWorkItem"."progressCursor"
           ELSE NULL END,
         "errorClass"=NULL,"lastError"=NULL,"terminalCause"=NULL,"updatedAt"=CURRENT_TIMESTAMP
       RETURNING *`,
      row.id,row.agencyId,row.workClass,row.objectType,row.objectId,row.parentObjectId,row.partitionKey,row.creatorId,row.accountId,
      row.activeGeneration,row.projectionVersion,row.availableAt,row.dependencyKind,row.dependencyKey,row.dependencyRevision,
    );
    return rows?.[0] || null;
  }
  if (!db?.domainWorkItem?.upsert) {
    const error = new Error("DomainWorkItem storage is unavailable"); error.code = "DOMAIN_WORK_STORAGE_REQUIRED"; throw error;
  }
  // Lightweight/non-PostgreSQL adapters have no shared database clock. Their
  // immediate fallback remains process time; production always takes the raw
  // PostgreSQL branch above.
  const adapterRow = row.availableAt
    ? row
    : { ...row, availableAt: asDate(fallbackNow) || new Date() };
  const existing = await db.domainWorkItem.findUnique?.({ where: identityWhere(row) });
  if (!existing) {
    return db.domainWorkItem.upsert({
      where: identityWhere(row),
      create: { ...adapterRow, requestedRevision: 1n, completedRevision: 0n, state: STATE.READY, isOutstanding: true, claimedRevision: 0n, claimFence: 0n },
      update: {},
    });
  }
  return db.domainWorkItem.update({
    where: { id: existing.id },
    data: {
      requestedRevision: { increment: 1 }, parentObjectId: adapterRow.parentObjectId || existing.parentObjectId || null, partitionKey: adapterRow.partitionKey,
      creatorId: adapterRow.creatorId || existing.creatorId || null, accountId: adapterRow.accountId || existing.accountId || null,
      dependencyKind: adapterRow.dependencyKind, dependencyKey: adapterRow.dependencyKey,
      dependencyRevision: adapterRow.dependencyRevision > asBigInt(existing.dependencyRevision) ? adapterRow.dependencyRevision : asBigInt(existing.dependencyRevision),
      state: String(existing.state) === STATE.CLAIMED ? STATE.CLAIMED : STATE.READY, isOutstanding: true,
      availableAt: asDate(existing.availableAt) && asDate(existing.availableAt) < adapterRow.availableAt ? existing.availableAt : adapterRow.availableAt,
      nextAttemptAt: null,
      progressCursor: String(existing.state) === STATE.CLAIMED
        ? existing.progressCursor ?? null
        : (String(existing.workClass) === WORK_CLASS.TEAM_DIALOG_PROJECTION && existing.progressCursor?.pendingRepair ? existing.progressCursor : null),
      errorClass: null, lastError: null, terminalCause: null,
    },
  });
}


async function activeDomainWorkGeneration({ db, workClass, fallback = DOMAIN_WORK_GENERATION } = {}) {
  const klass = clean(workClass, 120);
  if (!klass) return clean(fallback, 120) || DOMAIN_WORK_GENERATION;
  if (db?.phase2WorkGenerationAuthority?.findUnique) {
    const row = await db.phase2WorkGenerationAuthority.findUnique({ where: { workClass: klass }, select: { activeGeneration: true } });
    return clean(row?.activeGeneration, 120) || clean(fallback, 120) || DOMAIN_WORK_GENERATION;
  }
  if (typeof db?.$queryRawUnsafe === "function") {
    try {
      const rows = await db.$queryRawUnsafe(
        `SELECT "activeGeneration" FROM "Phase2WorkGenerationAuthority" WHERE "workClass"=$1 LIMIT 1`,
        klass,
      );
      return clean(rows?.[0]?.activeGeneration, 120) || clean(fallback, 120) || DOMAIN_WORK_GENERATION;
    } catch (_) {}
  }
  return clean(fallback, 120) || DOMAIN_WORK_GENERATION;
}

async function probeCurrentDomainWorkPresence({ db, agencyId, workClass, activeGeneration }) {
  const a = clean(agencyId, 180);
  const klass = clean(workClass, 120);
  const generation = clean(activeGeneration, 120);
  if (!a || !klass || !generation) return null;
  if (db?.domainWorkItem?.findFirst) {
    const row = await db.domainWorkItem.findFirst({
      where: { agencyId: a, workClass: klass, activeGeneration: generation, isOutstanding: true },
      select: { id: true },
    });
    return Boolean(row);
  }
  if (typeof db?.$queryRawUnsafe === "function") {
    try {
      const rows = await db.$queryRawUnsafe(
        `SELECT 1 AS present FROM "DomainWorkItem"
          WHERE "agencyId"=$1 AND "workClass"=$2 AND "activeGeneration"=$3 AND "isOutstanding"=TRUE
          LIMIT 1`,
        a, klass, generation,
      );
      return Array.isArray(rows) ? rows.length > 0 : null;
    } catch (_) {}
  }
  return null;
}

async function domainWorkFamilyState({ db = null, agencyId, workClass } = {}) {
  if (!db) db = require("../prisma");
  const a = clean(agencyId, 180); const klass = clean(workClass, 120);
  if (!a || !klass) return { fresh: false, outstandingCount: null, hasOutstanding: null, state: "UNKNOWN" };

  const activeGeneration = await activeDomainWorkGeneration({ db, workClass: klass, fallback: DOMAIN_WORK_GENERATION });
  const present = await probeCurrentDomainWorkPresence({ db, agencyId: a, workClass: klass, activeGeneration });
  if (present === true) {
    return {
      fresh: false,
      outstandingCount: null,
      hasOutstanding: true,
      state: "CURRENT_WORK_PRESENT",
      activeGeneration,
    };
  }
  if (present === false) {
    return {
      fresh: true,
      outstandingCount: 0,
      hasOutstanding: false,
      state: "NO_LIVE_WORK",
      activeGeneration,
    };
  }

  // Phase2WorkFamilyState is retained only as migration/diagnostic compatibility.
  // It is deliberately not current execution truth: a single Agency+workClass row
  // was a hot writer and a coarse freshness authority. Current readiness is proven
  // directly from the indexed physical workset above.
  return {
    fresh: false,
    outstandingCount: null,
    hasOutstanding: null,
    state: "UNKNOWN",
    activeGeneration,
  };
}

async function hasOutstandingDomainWork({ db = null, agencyId, workClass } = {}) {
  const status = await domainWorkFamilyState({ db, agencyId, workClass });
  if (typeof status.hasOutstanding === "boolean") return status.hasOutstanding;
  return status.outstandingCount == null ? null : status.outstandingCount > 0;
}

async function legacyExecutorDrainStatus({ db, workClass, fallbackNow = new Date() }) {
  const klass = clean(workClass, 120);
  const needsLegacyLaneDrain = LEGACY_DRAIN_WORK_CLASSES.has(klass);
  const authorityNow = await dbAuthorityNow({ db, fallbackNow });

  // Two independent rolling fences coexist here:
  // 1) the older maintenance-lane generation fence only applies to the historical
  //    lane-backed work classes listed in LEGACY_DRAIN_WORK_CLASSES;
  // 2) the Actual56 release-generation fence applies to EVERY DomainWork class.
  // A live pre-migration DWI claim must drain before the new binary acquires any
  // work of the same class, including DEPENDENCY_FANOUT and destructive classes.
  if (db?.phase2LegacyExecutorFence?.findMany && db?.maintenanceLaneState?.findMany) {
    let rows = [];
    if (needsLegacyLaneDrain) {
      const fences = await db.phase2LegacyExecutorFence.findMany({ select: { laneKey: true } });
      const keys = (fences || []).map((row) => clean(row?.laneKey, 180)).filter(Boolean);
      if (!keys.length) return { ready: false, lanes: [], reason: "legacy_executor_fence_uninitialized" };
      rows = await db.maintenanceLaneState.findMany({
        where: { key: { in: keys }, ownerToken: { not: null }, leaseUntil: { gt: authorityNow } },
        select: { key: true, generation: true, ownerToken: true, leaseUntil: true },
      });
    }

    let domainRows = [];
    if (db?.phase2ReleaseCompatibilityAuthority?.findUnique && db?.domainWorkItem?.findMany) {
      const authority = await db.phase2ReleaseCompatibilityAuthority.findUnique({
        where: { scope: "DOMAIN_WORK_EXECUTOR" }, select: { requiredGeneration: true },
      });
      const required = clean(authority?.requiredGeneration, 120);
      if (!required) return { ready: false, lanes: [], reason: "release_executor_fence_uninitialized" };
      domainRows = await db.domainWorkItem.findMany({
        where: {
          workClass: klass, isOutstanding: true, state: STATE.CLAIMED, leaseUntil: { gt: authorityNow },
          OR: [{ claimExecutionGeneration: null }, { claimExecutionGeneration: { not: required } }],
        },
        select: { id: true, claimExecutionGeneration: true, ownerToken: true, leaseUntil: true },
        orderBy: [{ leaseUntil: "asc" }, { id: "asc" }], take: 100,
      });
    }
    const legacy = [
      ...(rows || []),
      ...(domainRows || []).map((row) => ({ key: row.id, generation: row.claimExecutionGeneration || "legacy", ownerToken: row.ownerToken, leaseUntil: row.leaseUntil, domainWork: true })),
    ];
    return { ready: legacy.length === 0, lanes: legacy, reason: legacy.length ? "legacy_executor_drain" : null };
  }

  if (typeof db?.$queryRawUnsafe === "function") {
    try {
      let rows = [];
      if (needsLegacyLaneDrain) {
        rows = await db.$queryRawUnsafe(`
          SELECT m."key",m."generation",m."ownerToken",m."leaseUntil"
            FROM "MaintenanceLaneState" m
            JOIN "Phase2LegacyExecutorFence" f ON f."laneKey"=m."key"
           WHERE m."ownerToken" IS NOT NULL
             AND m."leaseUntil" > $1
           ORDER BY m."key" ASC`, authorityNow);
      }
      const domainRows = await db.$queryRawUnsafe(`
        WITH release_authority AS (
          SELECT "requiredGeneration"
            FROM "Phase2ReleaseCompatibilityAuthority"
           WHERE "scope"='DOMAIN_WORK_EXECUTOR'
           LIMIT 1
        )
        SELECT d."id" AS "key",COALESCE(d."claimExecutionGeneration",'legacy') AS "generation",d."ownerToken",d."leaseUntil"
          FROM "DomainWorkItem" d
          CROSS JOIN release_authority a
         WHERE d."workClass"=$2
           AND d."isOutstanding"=TRUE
           AND d."state"='CLAIMED'
           AND d."leaseUntil">$1
           AND d."claimExecutionGeneration" IS DISTINCT FROM a."requiredGeneration"
         ORDER BY d."leaseUntil" ASC,d."id" ASC
         LIMIT 100`, authorityNow, klass);
      const legacy = [...(rows || []), ...(domainRows || []).map((row) => ({ ...row, domainWork: true }))];
      return { ready: legacy.length === 0, lanes: legacy, reason: legacy.length ? "legacy_executor_drain" : null };
    } catch (error) {
      const wrapped = new Error("Phase2 rolling executor fence is unavailable");
      wrapped.code = "PHASE2_RELEASE_EXECUTOR_FENCE_REQUIRED";
      wrapped.cause = error;
      throw wrapped;
    }
  }

  return { ready: true, lanes: [], skipped: true, reason: "legacy_executor_fence_adapter_unavailable" };
}

function normalizeMemberClaimScope(value, agencyId) {
  if (!value || typeof value !== "object") return null;
  const memberId = clean(value.memberId, 180);
  const userId = clean(value.userId, 180);
  const scopedAgencyId = clean(value.agencyId || agencyId, 180);
  const accessEpoch = Number(value.accessEpoch);
  if (!memberId || !userId || !scopedAgencyId || !Number.isInteger(accessEpoch) || accessEpoch < 1) {
    throw Object.assign(new Error("member claim scope requires memberId, userId, agencyId and accessEpoch"), {
      code: "DOMAIN_WORK_MEMBER_SCOPE_REQUIRED",
    });
  }
  if (agencyId && String(agencyId) !== scopedAgencyId) {
    throw Object.assign(new Error("member claim scope agency does not match claim agency"), {
      code: "DOMAIN_WORK_MEMBER_SCOPE_AGENCY_MISMATCH",
    });
  }
  return { memberId, userId, agencyId: scopedAgencyId, accessEpoch };
}

async function lockMemberClaimAuthority(tx, authority, mode) {
  if (!authority) return { authorized: true, broad: null };
  const rows = await tx.$queryRawUnsafe(
    `SELECT m."id",
            "phase3_member_has_broad_creator_access"(
              m."role"::text,m."roleKey",m."assignedCreators"
            ) AS broad
       FROM "AgencyMember" m
       JOIN "Agency" a ON a."id"=m."agencyId" AND a."deletedAt" IS NULL
      WHERE m."id"=$1 AND m."userId"=$2 AND m."agencyId"=$3
        AND m."accessEpoch"=$4 AND m."deletedAt" IS NULL AND m."deactivatedAt" IS NULL
      FOR SHARE OF m`,
    authority.memberId, authority.userId, authority.agencyId, authority.accessEpoch,
  );
  const row = rows?.[0] || null;
  const broad = row?.broad === true;
  return { authorized: Boolean(row) && (mode === "broad" ? broad : !broad), broad };
}

async function reserveMemberScopeCreatorProbe({
  db, authority, workClass, generation, fallbackNow,
  shardLimit = DOMAIN_WORK_MEMBER_SCOPE_SHARD_PROBE,
  creatorsPerShard = DOMAIN_WORK_MEMBER_SCOPE_CREATOR_PROBE,
} = {}) {
  return runDbTransaction(db, async (tx) => {
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    if (typeof tx?.$queryRawUnsafe !== "function") {
      return { mode: "unavailable", authorityNow, creatorIds: [] };
    }
    const current = await lockMemberClaimAuthority(tx, authority, "scoped");
    if (!current.authorized) {
      if (current.broad === true) return { mode: "broad", authorityNow, creatorIds: [] };
      return { mode: "denied", authorityNow, creatorIds: [] };
    }

    // A peer can commit after this statement takes its sorted snapshot but
    // before it locks a shard. Reject that revision instead of reusing its old
    // position/cursor. Observe the fixed 128-shard ring so a stale 32-shard
    // tranche can be replaced without scanning the member's whole creator scope.
    const rows = await tx.$queryRawUnsafe(
      `WITH observed_shards AS MATERIALIZED (
         SELECT s."id",s."claimShard",s."revision",s."lastSelectedAt",
                CASE WHEN w."nextDispatchAt" IS NOT NULL AND w."nextDispatchAt" <= $4 THEN 0 ELSE 1 END AS "dueRank"
           FROM "DomainWorkMemberScopeShardState" s
           LEFT JOIN "DomainWorkClaimShardState" w
             ON w."agencyId"=s."agencyId" AND w."workClass"=$6
            AND w."activeGeneration"=$5 AND w."claimShard"=s."claimShard"
          WHERE s."memberId"=$1 AND s."agencyId"=$2 AND s."accessEpoch"=$3
          ORDER BY "dueRank",
                   s."lastSelectedAt" NULLS FIRST,s."revision",s."claimShard"
          LIMIT ${DOMAIN_WORK_CLAIM_SHARD_COUNT}
       ), selected_shards AS MATERIALIZED (
         SELECT s."id",s."claimShard",s."cursorCreatorId",s."revision"
           FROM observed_shards o JOIN "DomainWorkMemberScopeShardState" s
             ON s."id"=o."id" AND s."revision"=o."revision"
          ORDER BY o."dueRank",o."lastSelectedAt" NULLS FIRST,o."revision",o."claimShard"
          FOR UPDATE OF s SKIP LOCKED
          LIMIT $7
       ), ring AS MATERIALIZED (
         SELECT s."id",s."claimShard",picked."creatorId",picked.phase
           FROM selected_shards s
           CROSS JOIN LATERAL (
             (SELECT x."creatorId",0::int AS phase
                FROM "AgencyMemberCreatorAccessCurrent" x
                JOIN "CreatorAccount" live_creator
                  ON live_creator."id"=x."creatorId" AND live_creator."agencyId"=x."agencyId"
                 AND live_creator."deletedAt" IS NULL
               WHERE x."memberId"=$1 AND x."agencyId"=$2 AND x."accessEpoch"=$3
                 AND x."claimShard"=s."claimShard"
                 AND x."creatorId">COALESCE(s."cursorCreatorId",'')
               ORDER BY x."creatorId"
               LIMIT $8)
             UNION ALL
             (SELECT x."creatorId",1::int AS phase
                FROM "AgencyMemberCreatorAccessCurrent" x
                JOIN "CreatorAccount" live_creator
                  ON live_creator."id"=x."creatorId" AND live_creator."agencyId"=x."agencyId"
                 AND live_creator."deletedAt" IS NULL
               WHERE x."memberId"=$1 AND x."agencyId"=$2 AND x."accessEpoch"=$3
                 AND x."claimShard"=s."claimShard"
                 AND x."creatorId"<=COALESCE(s."cursorCreatorId",'')
               ORDER BY x."creatorId"
               LIMIT $8)
           ) picked
       ), ranked AS MATERIALIZED (
         SELECT r.*,row_number() OVER (PARTITION BY r."id" ORDER BY r.phase,r."creatorId") AS position
           FROM ring r
       ), bounded_probe AS MATERIALIZED (
         SELECT * FROM ranked WHERE position <= $8
       ), last_probe AS MATERIALIZED (
         SELECT DISTINCT ON (b."id") b."id",b."creatorId"
           FROM bounded_probe b
          ORDER BY b."id",b.position DESC
       ), advanced AS (
         UPDATE "DomainWorkMemberScopeShardState" s
            SET "cursorCreatorId"=COALESCE(last_probe."creatorId",s."cursorCreatorId"),
                "lastSelectedAt"=GREATEST($4,s."lastSelectedAt"),"revision"=s."revision"+1,"updatedAt"=CURRENT_TIMESTAMP
           FROM selected_shards selected
           LEFT JOIN last_probe ON last_probe."id"=selected."id"
          WHERE s."id"=selected."id" AND s."revision"=selected."revision"
         RETURNING s."id"
       )
       SELECT b."creatorId"
         FROM bounded_probe b
         JOIN advanced a ON a."id"=b."id"
        ORDER BY b."claimShard",b.position`,
      authority.memberId,authority.agencyId,authority.accessEpoch,authorityNow,
      String(generation),String(workClass),
      bounded(shardLimit, DOMAIN_WORK_MEMBER_SCOPE_SHARD_PROBE, DOMAIN_WORK_CLAIM_SHARD_COUNT),
      bounded(creatorsPerShard, DOMAIN_WORK_MEMBER_SCOPE_CREATOR_PROBE, 64),
    );
    return {
      mode: "scoped",
      authorityNow,
      creatorIds: Array.from(new Set((rows || []).map((row) => clean(row?.creatorId, 180)).filter(Boolean))),
    };
  });
}

async function claimDomainWorkBatchInternal({
  db = null, workClass, agencyId = null, objectType = null, objectIds = null, creatorIds = null, memberScope = null, ownerToken = randomUUID(), limit = 25,
  perAgencyQuantum = 10, perPartitionQuantum = 2, leaseMs = DEFAULT_LEASE_MS, generation = DOMAIN_WORK_GENERATION, fallbackNow = new Date(),
} = {}) {
  if (!db) db = require("../prisma");
  const klass = clean(workClass, 120);
  if (!klass) throw Object.assign(new Error("workClass is required"), { code: "DOMAIN_WORK_CLASS_REQUIRED" });
  const take = bounded(limit);
  const quantum = bounded(perAgencyQuantum, 10, take);
  const partitionQuantum = bounded(perPartitionQuantum, 2, quantum);
  const normalizedObjectIds = Array.from(new Set((Array.isArray(objectIds) ? objectIds : []).map((value) => clean(value, 240)).filter(Boolean)));
  let normalizedCreatorIds = Array.from(new Set((Array.isArray(creatorIds) ? creatorIds : []).map((value) => clean(value, 180)).filter(Boolean)));
  const memberAuthority = normalizeMemberClaimScope(memberScope, agencyId);
  // A member-scoped claim has exactly one tenant authority.  Do not keep the
  // caller's optional outer agencyId as a second, weaker source: a broad member
  // with no outer agencyId would otherwise fall into global Agency dispatch and
  // could claim another tenant after only proving membership in its own Agency.
  const effectiveAgencyId = memberAuthority?.agencyId || clean(agencyId, 180);
  let memberAuthorityMode = null;
  if (memberAuthority && Array.isArray(creatorIds)) {
    throw Object.assign(new Error("memberScope and creatorIds are mutually exclusive"), { code: "DOMAIN_WORK_SCOPE_AMBIGUOUS" });
  }
  if (!memberAuthority && Array.isArray(creatorIds) && !normalizedCreatorIds.length) {
    return { ownerToken, authorityNow: null, leaseUntil: null, items: [] };
  }

  const activeGeneration = await activeDomainWorkGeneration({ db, workClass: klass, fallback: generation });
  if (String(activeGeneration) !== String(generation)) {
    return { ownerToken, authorityNow: null, leaseUntil: null, items: [], skipped: true, reason: "unsupported_domain_work_generation", activeGeneration };
  }
  const drain = await legacyExecutorDrainStatus({ db, workClass: klass, fallbackNow });
  if (!drain.ready) {
    return { ownerToken, authorityNow: null, leaseUntil: null, items: [], skipped: true, reason: drain.reason || "legacy_executor_drain", legacyExecutors: drain.lanes || [] };
  }

  const rawCapable = typeof db?.$queryRawUnsafe === "function";

  // Both broad and member-scoped production claims depend on the same online
  // current-only topology. During BUILDING old rolling replicas may continue,
  // while the new binary fails closed instead of observing a partial backfill.
  let dependencyWakeBridge = false;
  if (rawCapable && typeof db?.domainWorkClaimTopologyState?.findUnique === "function") {
    const topology = await db.domainWorkClaimTopologyState.findUnique({
      where: { id: DOMAIN_WORK_CLAIM_TOPOLOGY_ID },
      select: { generation: true, activationState: true, revision: true },
    });
    dependencyWakeBridge = Boolean(
      topology?.generation === DOMAIN_WORK_CLAIM_TOPOLOGY_ID
      && topology?.activationState === "BUILDING"
      && klass === WORK_CLASS.DEPENDENCY_WAKE,
    );
    if ((!topology || topology.generation !== DOMAIN_WORK_CLAIM_TOPOLOGY_ID || topology.activationState !== "ACTIVE")
        && !dependencyWakeBridge) {
      return {
        ownerToken,
        authorityNow: null,
        leaseUntil: null,
        items: [],
        skipped: true,
        reason: "domain_work_claim_topology_building",
        topologyState: topology?.activationState || "MISSING",
      };
    }
  }
  const authorizeClaimExecutor = async (tx) => {
    try {
      await (dependencyWakeBridge
        ? authorizeDomainWorkDependencyWakeBridge(tx)
        : authorizeDomainWorkExecutor(tx));
      return true;
    } catch (error) {
      if (error?.code === "DOMAIN_WORK_DEPENDENCY_WAKE_BRIDGE_TRANSITION") return false;
      throw error;
    }
  };

  if (memberAuthority) {
    if (!rawCapable) {
      return { ownerToken, authorityNow: null, leaseUntil: null, items: [], skipped: true, reason: "domain_work_member_scope_storage_unavailable" };
    }
    const probe = await reserveMemberScopeCreatorProbe({
      db, authority: memberAuthority, workClass: klass, generation: String(generation), fallbackNow,
    });
    if (probe.mode === "denied") {
      return { ownerToken, authorityNow: probe.authorityNow, leaseUntil: null, items: [], skipped: true, reason: "domain_work_member_scope_stale" };
    }
    if (probe.mode === "broad") {
      memberAuthorityMode = "broad";
    } else if (probe.mode === "scoped") {
      memberAuthorityMode = "scoped";
      normalizedCreatorIds = probe.creatorIds;
      if (!normalizedCreatorIds.length) {
        return { ownerToken, authorityNow: probe.authorityNow, leaseUntil: null, items: [] };
      }
    } else {
      return { ownerToken, authorityNow: probe.authorityNow, leaseUntil: null, items: [], skipped: true, reason: "domain_work_member_scope_storage_unavailable" };
    }
  }

  // Actual55 Root A: ready-head rows are no longer execution authority.  They were
  // introduced as a physical admission optimization, but making correctness depend
  // on their mutable MIN created the F55-01/F55-02/F55-05 failure cluster (Prisma
  // VOID decoding, Agency-wide serialization and row/advisory lock inversion).
  // Production admission still ends at physically-current isOutstanding DWI rows.
  // Creator-scoped workers seek exact creator identities. Broad workers reserve a
  // rebuildable Agency dispatch row and a fixed per-Agency shard dispatch row in
  // separate short transactions, then claim physical DWI without holding either
  // locator lock. This preserves global Agency fairness, parallelism inside a huge
  // Agency and the canonical DWI -> partition -> shard -> Agency lock order.
  if (rawCapable && normalizedCreatorIds.length) {
    const scopedAgencyId = effectiveAgencyId;
    if (!scopedAgencyId) {
      throw Object.assign(new Error("creator-scoped DomainWork claim requires agencyId"), { code: "DOMAIN_WORK_SCOPED_AGENCY_REQUIRED" });
    }
    return runDbTransaction(db, async (tx) => {
      const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
      const leaseUntil = new Date(authorityNow.getTime() + Math.max(30_000, Number(leaseMs) || DEFAULT_LEASE_MS));
      if (typeof tx?.$queryRawUnsafe !== "function") {
        return { ownerToken, authorityNow, leaseUntil, items: [], skipped: true, reason: "domain_work_raw_storage_unavailable" };
      }
      if (!await authorizeClaimExecutor(tx)) {
        return {
          ownerToken, authorityNow, leaseUntil: null, items: [], skipped: true,
          reason: "domain_work_dependency_wake_bridge_transition",
        };
      }
      if (memberAuthority) {
        const access = await lockMemberClaimAuthority(tx, memberAuthority, "scoped");
        if (!access.authorized) {
          return { ownerToken, authorityNow, leaseUntil: null, items: [], skipped: true, reason: "domain_work_member_scope_stale" };
        }
      }
      const params = [klass, authorityNow, String(generation), ownerToken, leaseUntil, partitionQuantum, take];
      const creatorValues = normalizedCreatorIds.map((value) => {
        params.push(value);
        return `($${params.length})`;
      }).join(",");
      params.push(scopedAgencyId);
      const scopedAgencyParam = params.length;
      let scopedWorkFilter = ` AND d."agencyId"=$${scopedAgencyParam}`;
      let creatorAuthorityCte = "";
      let creatorAuthorityRelation = "scoped_creators";
      if (memberAuthorityMode === "scoped") {
        params.push(memberAuthority.memberId);
        const memberParam = params.length;
        params.push(memberAuthority.accessEpoch);
        const epochParam = params.length;
        creatorAuthorityCte = `, authorized_creators AS MATERIALIZED (
           SELECT c."creatorId"
             FROM scoped_creators c
             JOIN "AgencyMemberCreatorAccessCurrent" x
               ON x."memberId"=$${memberParam} AND x."agencyId"=$${scopedAgencyParam}
              AND x."accessEpoch"=$${epochParam} AND x."creatorId"=c."creatorId"
             JOIN "CreatorAccount" live_creator
               ON live_creator."id"=x."creatorId" AND live_creator."agencyId"=x."agencyId"
              AND live_creator."deletedAt" IS NULL
         )`;
        creatorAuthorityRelation = "authorized_creators";
      }
      if (objectType) {
        params.push(String(objectType));
        scopedWorkFilter += ` AND d."objectType"=$${params.length}`;
      }
      if (normalizedObjectIds.length) {
        const placeholders = normalizedObjectIds.map((value) => { params.push(value); return `$${params.length}`; }).join(",");
        scopedWorkFilter += ` AND d."objectId" IN (${placeholders})`;
      }

      const rows = await tx.$queryRawUnsafe(
        `WITH scoped_creators("creatorId") AS (
           VALUES ${creatorValues}
         )${creatorAuthorityCte}, candidates AS (
           SELECT d."id",d."claimableAt"
             FROM ${creatorAuthorityRelation} c
             CROSS JOIN LATERAL (
               SELECT d."id",
                      "phase3_domain_work_claimable_at"(
                        d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"
                      ) AS "claimableAt"
                 FROM "DomainWorkItem" d
                WHERE d."workClass"=$1
                  AND d."activeGeneration"=$3
                  AND d."creatorId"=c."creatorId"
                  AND d."isOutstanding"=TRUE
                  AND d."state" IN ('READY','CLAIMED')
                  AND "phase3_domain_work_claimable_at"(
                        d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"
                      ) <= $2${scopedWorkFilter}
                ORDER BY "phase3_domain_work_claimable_at"(
                           d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"
                         ),d."id"
                FOR UPDATE OF d SKIP LOCKED
                LIMIT $6
             ) d
            ORDER BY d."claimableAt",d."id"
            LIMIT $7
         )
         UPDATE "DomainWorkItem" d SET
           "state"='CLAIMED',"ownerToken"=$4,"claimFence"=d."claimFence"+1,
           "claimedRevision"=d."requestedRevision","leaseUntil"=$5,"attempts"=d."attempts"+1,
           "updatedAt"=CURRENT_TIMESTAMP
          FROM candidates c WHERE d."id"=c."id"
         RETURNING d.*`, ...params,
      );
      return { ownerToken, authorityNow, leaseUntil, items: rows || [] };
    });
  }

  if (rawCapable && typeof db?.$transaction === "function") {
    // The shared ACTIVE gate above covers both broad hierarchy and member-scope
    // projections before any locator can influence execution admission.
    const claimed = [];
    const claimedByAgency = new Map();
    const suppressedAgencies = [];
    const suppressedShards = [];
    let bridgeTransitioned = false;
    // Normal cost is three short bounded transactions per tranche: Agency
    // reservation, shard reservation, and physical claim. The fixed repair
    // margin can rotate every shard of one corrupt Agency without depending on
    // total Agencies, creator partitions, or lifetime history.
    const maxTranches = Math.max(1, Math.min(384, take + DOMAIN_WORK_CLAIM_SHARD_COUNT));
    let firstAuthorityNow = null;
    let lastLeaseUntil = null;

    for (let attempt = 0; attempt < maxTranches && claimed.length < take; attempt += 1) {
      const remaining = take - claimed.length;
      const exhaustedAgencies = effectiveAgencyId
        ? (Number(claimedByAgency.get(effectiveAgencyId) || 0) >= quantum ? [effectiveAgencyId] : [])
        : Array.from(claimedByAgency.entries()).filter(([, count]) => count >= quantum).map(([id]) => id);
      if (effectiveAgencyId && exhaustedAgencies.length) break;

      let selectedAgency = effectiveAgencyId;
      if (!selectedAgency) {
        const agencyReservation = await runDbTransaction(db, async (tx) => {
          const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
          if (typeof tx?.$queryRawUnsafe !== "function") return { agencyId: null, authorityNow };
          if (!await authorizeClaimExecutor(tx)) {
            return { agencyId: null, authorityNow, bridgeTransitioned: true };
          }

          const excluded = Array.from(new Set([...exhaustedAgencies, ...suppressedAgencies]));
          const params = [klass, authorityNow, String(generation)];
          let locatorFilter = "";
          if (excluded.length) {
            const placeholders = excluded.map((value) => { params.push(value); return `$${params.length}`; }).join(",");
            locatorFilter += ` AND a."agencyId" NOT IN (${placeholders})`;
          }
          const reservationSql =
            `WITH observed AS MATERIALIZED (
               SELECT a."id",a."revision",a."nextDispatchAt",a."agencyId"
                 FROM "DomainWorkClaimAgencyState" a
                WHERE a."workClass"=$1 AND a."activeGeneration"=$3
                  AND a."nextDispatchAt" <= $2${locatorFilter}
                ORDER BY a."nextDispatchAt",a."revision",a."agencyId"
                LIMIT 128
             ), candidate AS MATERIALIZED (
               SELECT a."id",a."revision"
                 FROM observed o JOIN "DomainWorkClaimAgencyState" a
                   ON a."id"=o."id" AND a."revision"=o."revision"
                ORDER BY o."nextDispatchAt",o."revision",o."agencyId"
                FOR UPDATE OF a SKIP LOCKED
                LIMIT 1
             ), stamp AS MATERIALIZED (
               SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "selectedAt"
                 FROM candidate
             )
             UPDATE "DomainWorkClaimAgencyState" a
                SET "nextDispatchAt"=GREATEST(stamp."selectedAt",a."lastSelectedAt"),
                    "lastSelectedAt"=GREATEST(stamp."selectedAt",a."lastSelectedAt"),
                    "revision"=a."revision"+1,"updatedAt"=CURRENT_TIMESTAMP
               FROM candidate c CROSS JOIN stamp
              WHERE a."id"=c."id" AND a."revision"=c."revision"
             RETURNING a."agencyId"`;

          let rows = await tx.$queryRawUnsafe(reservationSql, ...params);
          // Reservations never wait behind a DWI writer reconciling shard ->
          // Agency. Contention retries the bounded hierarchy; only actual
          // absence of due locators permits physical-witness repair.
          let reservedAgency = clean(rows?.[0]?.agencyId, 180);

          if (!reservedAgency) {
            // A snapshot can see a locator before a peer reserves it. Never
            // accept its new revision at the old sorted position, or bypass
            // the fair hierarchy because the bounded window was contended.
            const due = await tx.$queryRawUnsafe(
              `SELECT a."id" FROM "DomainWorkClaimAgencyState" a
                WHERE a."workClass"=$1 AND a."activeGeneration"=$3
                  AND a."nextDispatchAt" <= $2${locatorFilter}
                ORDER BY a."nextDispatchAt",a."revision",a."agencyId" LIMIT 1`, ...params,
            );
            if (due?.length) return { agencyId: null, authorityNow, contended: true };
            const physicalParams = [klass, authorityNow, String(generation)];
            let physicalFilter = "";
            if (excluded.length) {
              const placeholders = excluded.map((value) => { physicalParams.push(value); return `$${physicalParams.length}`; }).join(",");
              physicalFilter += ` AND d."agencyId" NOT IN (${placeholders})`;
            }
            if (objectType) {
              physicalParams.push(String(objectType));
              physicalFilter += ` AND d."objectType"=$${physicalParams.length}`;
            }
            if (normalizedObjectIds.length) {
              const placeholders = normalizedObjectIds.map((value) => { physicalParams.push(value); return `$${physicalParams.length}`; }).join(",");
              physicalFilter += ` AND d."objectId" IN (${placeholders})`;
            }
            rows = await tx.$queryRawUnsafe(
              `SELECT d."agencyId"
                 FROM "DomainWorkItem" d
                WHERE d."workClass"=$1 AND d."activeGeneration"=$3 AND d."isOutstanding"=TRUE
                  AND d."state" IN ('READY','CLAIMED')
                  AND "phase3_domain_work_claimable_at"(d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil") <= $2${physicalFilter}
                ORDER BY "phase3_domain_work_claimable_at"(d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"),
                         d."agencyId",d."partitionKey",d."id"
                LIMIT 1`,
              ...physicalParams,
            );
            reservedAgency = clean(rows?.[0]?.agencyId, 180);
          }
          return { agencyId: reservedAgency, authorityNow };
        });
        if (agencyReservation.bridgeTransitioned) {
          bridgeTransitioned = true;
          break;
        }
        if (agencyReservation.contended) continue;
        selectedAgency = clean(agencyReservation.agencyId, 180);
        if (!firstAuthorityNow) firstAuthorityNow = agencyReservation.authorityNow || null;
      }
      if (!selectedAgency) break;

      const shardReservation = await runDbTransaction(db, async (tx) => {
        const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
        if (typeof tx?.$queryRawUnsafe !== "function") return { claimShard: null, authorityNow };
        if (!await authorizeClaimExecutor(tx)) {
          return { claimShard: null, authorityNow, bridgeTransitioned: true };
        }

        const shardParams = [klass, authorityNow, String(generation), selectedAgency];
        let shardFilter = "";
        const skippedForAgency = suppressedShards
          .filter((entry) => entry.agencyId === selectedAgency)
          .map((entry) => entry.claimShard);
        if (skippedForAgency.length) {
          const placeholders = skippedForAgency.map((value) => { shardParams.push(value); return `$${shardParams.length}`; }).join(",");
          shardFilter += ` AND s."claimShard" NOT IN (${placeholders})`;
        }
        const reservationSql =
          `WITH observed AS MATERIALIZED (
             SELECT s."id",s."revision",s."nextDispatchAt",s."claimShard"
               FROM "DomainWorkClaimShardState" s
              WHERE s."agencyId"=$4 AND s."workClass"=$1 AND s."activeGeneration"=$3
                AND s."nextDispatchAt" <= $2${shardFilter}
              ORDER BY s."nextDispatchAt",s."revision",s."claimShard"
              LIMIT 128
           ), candidate AS MATERIALIZED (
             SELECT s."id",s."revision"
               FROM observed o JOIN "DomainWorkClaimShardState" s
                 ON s."id"=o."id" AND s."revision"=o."revision"
              ORDER BY o."nextDispatchAt",o."revision",o."claimShard"
              FOR UPDATE OF s SKIP LOCKED
              LIMIT 1
           ), stamp AS MATERIALIZED (
             SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "selectedAt"
               FROM candidate
           )
           UPDATE "DomainWorkClaimShardState" s
              SET "nextDispatchAt"=GREATEST(stamp."selectedAt",s."lastSelectedAt"),
                  "lastSelectedAt"=GREATEST(stamp."selectedAt",s."lastSelectedAt"),
                  "revision"=s."revision"+1,"updatedAt"=CURRENT_TIMESTAMP
             FROM candidate c CROSS JOIN stamp
            WHERE s."id"=c."id" AND s."revision"=c."revision"
           RETURNING s."claimShard"`;

        let shardRows = await tx.$queryRawUnsafe(reservationSql, ...shardParams);
        let selectedShard = Number(shardRows?.[0]?.claimShard);

        if (!Number.isInteger(selectedShard) || selectedShard < 0 || selectedShard >= DOMAIN_WORK_CLAIM_SHARD_COUNT) {
          const due = await tx.$queryRawUnsafe(
            `SELECT s."id" FROM "DomainWorkClaimShardState" s
              WHERE s."agencyId"=$4 AND s."workClass"=$1 AND s."activeGeneration"=$3
                AND s."nextDispatchAt" <= $2${shardFilter}
              ORDER BY s."nextDispatchAt",s."revision",s."claimShard" LIMIT 1`, ...shardParams,
          );
          if (due?.length) return { claimShard: null, authorityNow, contended: true };
          // Locator loss cannot lose work. This physical probe is constrained to
          // one Agency and an indexed current-DWI expression, never DONE history.
          const physicalParams = [klass, authorityNow, String(generation), selectedAgency];
          let physicalFilter = "";
          if (objectType) {
            physicalParams.push(String(objectType));
            physicalFilter += ` AND d."objectType"=$${physicalParams.length}`;
          }
          if (normalizedObjectIds.length) {
            const placeholders = normalizedObjectIds.map((value) => { physicalParams.push(value); return `$${physicalParams.length}`; }).join(",");
            physicalFilter += ` AND d."objectId" IN (${placeholders})`;
          }
          if (skippedForAgency.length) {
            const placeholders = skippedForAgency.map((value) => { physicalParams.push(value); return `$${physicalParams.length}`; }).join(",");
            physicalFilter += ` AND "phase3_domain_work_claim_shard"(d."partitionKey") NOT IN (${placeholders})`;
          }
          shardRows = await tx.$queryRawUnsafe(
            `SELECT "phase3_domain_work_claim_shard"(d."partitionKey") AS "claimShard"
               FROM "DomainWorkItem" d
              WHERE d."agencyId"=$4 AND d."workClass"=$1 AND d."activeGeneration"=$3 AND d."isOutstanding"=TRUE
                AND d."state" IN ('READY','CLAIMED')
                AND "phase3_domain_work_claimable_at"(d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil") <= $2${physicalFilter}
              ORDER BY "phase3_domain_work_claimable_at"(d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"),
                       d."partitionKey",d."id"
              LIMIT 1`,
            ...physicalParams,
          );
          selectedShard = Number(shardRows?.[0]?.claimShard);
        }
        if (!Number.isInteger(selectedShard) || selectedShard < 0 || selectedShard >= DOMAIN_WORK_CLAIM_SHARD_COUNT) {
          await tx.$queryRawUnsafe(
            `SELECT "phase3_reconcile_domain_work_claim_agency"($1,$2,$3,$4) AS "reconciled"`,
            selectedAgency,klass,String(generation),authorityNow,
          );
          return { claimShard: null, authorityNow };
        }
        return { claimShard: selectedShard, authorityNow };
      });

      if (shardReservation.bridgeTransitioned) {
        bridgeTransitioned = true;
        break;
      }
      if (shardReservation.contended) continue;

      const selectedShard = shardReservation.claimShard == null ? Number.NaN : Number(shardReservation.claimShard);
      if (!firstAuthorityNow) firstAuthorityNow = shardReservation.authorityNow || null;
      if (!Number.isInteger(selectedShard) || selectedShard < 0 || selectedShard >= DOMAIN_WORK_CLAIM_SHARD_COUNT) {
        if (effectiveAgencyId) break;
        suppressedAgencies.push(selectedAgency);
        continue;
      }

      const tranche = await runDbTransaction(db, async (tx) => {
        const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
        const leaseUntil = new Date(authorityNow.getTime() + Math.max(30_000, Number(leaseMs) || DEFAULT_LEASE_MS));
        if (typeof tx?.$queryRawUnsafe !== "function") return { agencyId: selectedAgency, claimShard: selectedShard, authorityNow, leaseUntil, items: [] };
        if (!await authorizeClaimExecutor(tx)) {
          return {
            agencyId: selectedAgency, claimShard: selectedShard, authorityNow,
            leaseUntil: null, items: [], bridgeTransitioned: true,
          };
        }
        if (memberAuthorityMode === "broad") {
          const access = await lockMemberClaimAuthority(tx, memberAuthority, "broad");
          if (!access.authorized) {
            return {
              agencyId: selectedAgency, claimShard: selectedShard, authorityNow,
              leaseUntil: null, items: [], accessDenied: true,
            };
          }
        }

        const alreadyClaimed = Number(claimedByAgency.get(selectedAgency) || 0);
        const agencyTake = Math.max(1, Math.min(remaining, quantum - alreadyClaimed));
        const partitionsNeeded = Math.max(1, Math.ceil(agencyTake / partitionQuantum));
        const partitionSelectionCap = Math.min(256, Math.max(partitionsNeeded, partitionsNeeded * 2));

        const partitionRows = await tx.$queryRawUnsafe(
          `SELECT f."partitionKey"
             FROM "Phase2WorkBroadClaimPartitionState" f
            WHERE f."agencyId"=$4 AND f."workClass"=$1 AND f."activeGeneration"=$3
              AND f."claimShard"=$5 AND f."nextClaimableAt" <= $2
            ORDER BY f."nextClaimableAt",f."revision",f."partitionKey"
            LIMIT $6`,
          klass,authorityNow,String(generation),selectedAgency,selectedShard,partitionSelectionCap,
        );
        const selectedPartitions = Array.from(new Set(
          (partitionRows || []).map((row) => clean(row?.partitionKey, 500)).filter(Boolean),
        )).sort();

        const params = [klass,authorityNow,String(generation),selectedAgency,partitionQuantum,agencyTake,ownerToken,leaseUntil];
        const partitionValues = selectedPartitions.map((value) => { params.push(value); return `($${params.length})`; }).join(",");
        let workFilter = "";
        if (objectType) {
          params.push(String(objectType));
          workFilter += ` AND d."objectType"=$${params.length}`;
        }
        if (normalizedObjectIds.length) {
          const placeholders = normalizedObjectIds.map((value) => { params.push(value); return `$${params.length}`; }).join(",");
          workFilter += ` AND d."objectId" IN (${placeholders})`;
        }

        let rows = [];
        if (selectedPartitions.length) {
          rows = await tx.$queryRawUnsafe(
            `WITH selected_partitions("partitionKey") AS MATERIALIZED (
               VALUES ${partitionValues}
             ), candidates AS MATERIALIZED (
             SELECT picked."id",picked."claimableAt",p."partitionKey"
               FROM selected_partitions p
               CROSS JOIN LATERAL (
                 SELECT d."id",
                        "phase3_domain_work_claimable_at"(d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil") AS "claimableAt"
                   FROM "DomainWorkItem" d
                  WHERE d."agencyId"=$4 AND d."workClass"=$1 AND d."activeGeneration"=$3
                    AND d."partitionKey"=p."partitionKey" AND d."isOutstanding"=TRUE
                    AND d."state" IN ('READY','CLAIMED')
                    AND "phase3_domain_work_claimable_at"(d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil") <= $2${workFilter}
                  ORDER BY "phase3_domain_work_claimable_at"(d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"),d."id"
                  FOR UPDATE OF d SKIP LOCKED
                  LIMIT $5
               ) picked
              ORDER BY picked."claimableAt",picked."id"
              LIMIT $6
           ), claimed AS (
             UPDATE "DomainWorkItem" d SET
               "state"='CLAIMED',"ownerToken"=$7,"claimFence"=d."claimFence"+1,
               "claimedRevision"=d."requestedRevision","leaseUntil"=$8,"attempts"=d."attempts"+1,
               "updatedAt"=CURRENT_TIMESTAMP
              FROM candidates c WHERE d."id"=c."id"
             RETURNING d.*
           )
           SELECT c.* FROM claimed c`,
            ...params,
          );
        }

        if (Number(rows?.length || 0) === 0) {
          // Exceptional locator repair claims one physical row only.  Its DWI
          // UPDATE atomically rebuilds the exact partition/shard wake via triggers.
          const repairParams = [klass,authorityNow,String(generation),selectedAgency,selectedShard,ownerToken,leaseUntil];
          let repairFilter = "";
          if (objectType) {
            repairParams.push(String(objectType));
            repairFilter += ` AND d."objectType"=$${repairParams.length}`;
          }
          if (normalizedObjectIds.length) {
            const placeholders = normalizedObjectIds.map((value) => { repairParams.push(value); return `$${repairParams.length}`; }).join(",");
            repairFilter += ` AND d."objectId" IN (${placeholders})`;
          }
          rows = await tx.$queryRawUnsafe(
            `WITH candidate AS MATERIALIZED (
               SELECT d."id"
                 FROM "DomainWorkItem" d
                WHERE d."agencyId"=$4 AND d."workClass"=$1 AND d."activeGeneration"=$3
                  AND "phase3_domain_work_claim_shard"(d."partitionKey")=$5
                  AND d."isOutstanding"=TRUE AND d."state" IN ('READY','CLAIMED')
                  AND "phase3_domain_work_claimable_at"(d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil") <= $2${repairFilter}
                ORDER BY "phase3_domain_work_claimable_at"(d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"),
                         d."partitionKey",d."id"
                FOR UPDATE OF d SKIP LOCKED
                LIMIT 1
             )
             UPDATE "DomainWorkItem" d SET
               "state"='CLAIMED',"ownerToken"=$6,"claimFence"=d."claimFence"+1,
               "claimedRevision"=d."requestedRevision","leaseUntil"=$7,"attempts"=d."attempts"+1,
               "updatedAt"=CURRENT_TIMESTAMP
              FROM candidate c WHERE d."id"=c."id"
             RETURNING d.*`,
            ...repairParams,
          );
        }

        const reconciledPartitions = Array.from(new Set([
          ...selectedPartitions,
          ...(rows || []).map((row) => clean(row?.partitionKey, 500)).filter(Boolean),
        ])).sort();
        if (reconciledPartitions.length) {
          const reconcileParams = [selectedAgency,klass,String(generation),authorityNow];
          const reconcileValues = reconciledPartitions
            .map((value) => { reconcileParams.push(value); return `($${reconcileParams.length})`; })
            .join(",");
          await tx.$queryRawUnsafe(
            `SELECT "phase3_reconcile_domain_work_claim_partition"($1,$2,$3,p."partitionKey",$4) AS "reconciled"
               FROM (VALUES ${reconcileValues}) AS p("partitionKey")
              ORDER BY p."partitionKey"`,
            ...reconcileParams,
          );
        }
        await tx.$queryRawUnsafe(
          `SELECT "phase3_reconcile_domain_work_claim_shard"($1,$2,$3,$4,$5) AS "reconciled"`,
          selectedAgency,klass,String(generation),selectedShard,authorityNow,
        );
        await tx.$queryRawUnsafe(
          `SELECT "phase3_reconcile_domain_work_claim_agency"($1,$2,$3,$4) AS "reconciled"`,
          selectedAgency,klass,String(generation),authorityNow,
        );
        return { agencyId: selectedAgency, claimShard: selectedShard, authorityNow, leaseUntil, items: rows || [] };
      });

      if (!firstAuthorityNow) firstAuthorityNow = tranche.authorityNow || null;
      if (tranche.bridgeTransitioned) {
        bridgeTransitioned = true;
        break;
      }
      if (tranche.accessDenied) {
        return {
          ownerToken,
          authorityNow: firstAuthorityNow,
          leaseUntil: null,
          items: [],
          skipped: true,
          reason: "domain_work_member_scope_stale",
        };
      }
      if (tranche.leaseUntil) lastLeaseUntil = tranche.leaseUntil;
      if (!tranche.agencyId) break;
      const trancheItems = tranche.items || [];
      claimed.push(...trancheItems);
      if (trancheItems.length) {
        claimedByAgency.set(tranche.agencyId, Number(claimedByAgency.get(tranche.agencyId) || 0) + trancheItems.length);
      } else {
        suppressedShards.push({ agencyId: tranche.agencyId, claimShard: tranche.claimShard });
      }
    }
    return {
      ownerToken,
      authorityNow: firstAuthorityNow,
      leaseUntil: lastLeaseUntil,
      items: claimed.slice(0, take),
      ...(bridgeTransitioned ? {
        bridgeTransitioned: true,
        skipped: claimed.length === 0,
        reason: "domain_work_dependency_wake_bridge_transition",
      } : {}),
    };
  }

  // Adapter/unit fallback. Production PostgreSQL uses the raw paths above; keep
  // the bounded in-memory admission model for lightweight storage adapters.
  return runDbTransaction(db, async (tx) => {
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const leaseUntil = new Date(authorityNow.getTime() + Math.max(30_000, Number(leaseMs) || DEFAULT_LEASE_MS));
    if (!await authorizeClaimExecutor(tx)) {
      return {
        ownerToken, authorityNow, leaseUntil: null, items: [], skipped: true,
        reason: "domain_work_dependency_wake_bridge_transition",
      };
    }
    if (!tx?.domainWorkItem?.findMany || !tx?.domainWorkItem?.updateMany) {
      return { ownerToken, authorityNow, leaseUntil, items: [], skipped: true, reason: "domain_work_storage_unavailable" };
    }
    const discovered = await tx.domainWorkItem.findMany({
      where: {
        workClass: klass,
        isOutstanding: true,
        OR: [{ state: STATE.READY }, { state: STATE.CLAIMED, leaseUntil: { lte: authorityNow } }],
        activeGeneration: generation,
        availableAt: { lte: authorityNow },
        ...(effectiveAgencyId ? { agencyId: effectiveAgencyId } : {}),
        ...(objectType ? { objectType: String(objectType) } : {}),
        ...(normalizedObjectIds.length ? { objectId: { in: normalizedObjectIds } } : {}),
        ...(Array.isArray(creatorIds) ? { creatorId: { in: normalizedCreatorIds } } : {}),
      },
      orderBy: [{ availableAt: "asc" }, { id: "asc" }], take: Math.min(MAX_BATCH * 10, Math.max(take, take * 10)),
    });
    const agencyCounts = new Map(); const partitionCounts = new Map(); const rows = [];
    for (const row of discovered || []) {
      const a = String(row.agencyId); const p = `${a}\u001f${String(row.partitionKey || a)}`;
      if ((agencyCounts.get(a) || 0) >= quantum || (partitionCounts.get(p) || 0) >= partitionQuantum) continue;
      agencyCounts.set(a, (agencyCounts.get(a) || 0) + 1); partitionCounts.set(p, (partitionCounts.get(p) || 0) + 1); rows.push(row);
      if (rows.length >= take) break;
    }
    const items = [];
    for (const current of rows) {
      const fence = asBigInt(current.claimFence) + 1n;
      const changed = await tx.domainWorkItem.updateMany({
        where: {
          id: current.id,
          requestedRevision: current.requestedRevision,
          activeGeneration: generation,
          OR: [{ state: STATE.READY }, { state: STATE.CLAIMED, leaseUntil: { lte: authorityNow } }],
        },
        data: { state: STATE.CLAIMED, ownerToken, claimFence: fence, claimedRevision: current.requestedRevision, leaseUntil, attempts: { increment: 1 } },
      });
      if (Number(changed?.count || 0) === 1) items.push({ ...current, state: STATE.CLAIMED, ownerToken, claimFence: fence, claimedRevision: current.requestedRevision, leaseUntil });
    }
    return { ownerToken, authorityNow, leaseUntil, items };
  });
}

async function claimDomainWorkBatch(input = {}) {
  const ownerToken = input.ownerToken || randomUUID();
  try {
    return await claimDomainWorkBatchInternal({ ...input, ownerToken });
  } catch (error) {
    // Activation may win the topology row between the initial BUILDING read and
    // the first short reservation transaction. No work was acquired: retry on
    // the next pump through the normal ACTIVE/v5 path.
    if (error?.code === "DOMAIN_WORK_DEPENDENCY_WAKE_BRIDGE_TRANSITION") {
      return {
        ownerToken,
        authorityNow: null,
        leaseUntil: null,
        items: [],
        skipped: true,
        reason: "domain_work_dependency_wake_bridge_transition",
      };
    }
    throw error;
  }
}

function claimWhere(item, ownerToken, authorityNow, generation = DOMAIN_WORK_GENERATION) {
  return {
    id: String(item.id), ownerToken: String(ownerToken || item.ownerToken || ""), state: STATE.CLAIMED,
    claimFence: item.claimFence, claimedRevision: item.claimedRevision, activeGeneration: generation,
    leaseUntil: { gt: authorityNow },
  };
}

async function lockDomainWorkClaimForCommit({ db = null, item, ownerToken = null, fallbackNow = new Date(), generation = DOMAIN_WORK_GENERATION } = {}) {
  if (!db) db = require("../prisma");
  if (!item?.id) return { current: false, lost: true };
  return runDbTransaction(db, async (tx) => {
    let current = null;
    if (typeof tx?.$queryRawUnsafe === "function") {
      const rows = await tx.$queryRawUnsafe(
        `SELECT * FROM "DomainWorkItem" WHERE "id"=$1 FOR UPDATE`,
        String(item.id),
      );
      current = rows?.[0] || null;
    } else {
      current = await tx.domainWorkItem?.findFirst?.({ where: { id: String(item.id) } });
    }
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const expectedOwner = String(ownerToken || item.ownerToken || "");
    const valid = Boolean(
      current
      && String(current.state) === STATE.CLAIMED
      && String(current.ownerToken || "") === expectedOwner
      && asBigInt(current.claimFence) === asBigInt(item.claimFence)
      && asBigInt(current.claimedRevision) === asBigInt(item.claimedRevision)
      && String(current.activeGeneration) === String(generation)
      && asDate(current.leaseUntil)
      && asDate(current.leaseUntil) > authorityNow
    );
    if (!valid) return { current: false, lost: true, authorityNow };
    return {
      current: true,
      lost: false,
      authorityNow,
      newerRevision: asBigInt(current.requestedRevision) > asBigInt(item.claimedRevision),
      item: { ...current, claimFence: asBigInt(current.claimFence), claimedRevision: asBigInt(current.claimedRevision), ownerToken: expectedOwner },
    };
  });
}

async function heartbeatDomainWorkClaim({ db = null, item, ownerToken = null, leaseMs = DEFAULT_LEASE_MS, fallbackNow = new Date(), generation = DOMAIN_WORK_GENERATION } = {}) {
  if (!db) db = require("../prisma");
  if (!item?.id) return { renewed: false, lost: true };
  return runDbTransaction(db, async (tx) => {
    const ownership = await lockDomainWorkClaimForCommit({ db: tx, item, ownerToken, fallbackNow, generation });
    if (!ownership.current) return { renewed: false, lost: true };
    const authorityNow = ownership.authorityNow;
    const leaseUntil = new Date(authorityNow.getTime() + Math.max(30_000, Number(leaseMs) || DEFAULT_LEASE_MS));
    const changed = await tx.domainWorkItem?.updateMany?.({ where: claimWhere(item, ownerToken, authorityNow, generation), data: { leaseUntil } });
    if (Number(changed?.count || 0) !== 1) return { renewed: false, lost: true, authorityNow };
    return { renewed: true, lost: false, authorityNow, leaseUntil };
  });
}

async function ackDomainWorkClaim({ db = null, item, ownerToken = null, terminalCause = null, fallbackNow = new Date(), generation = DOMAIN_WORK_GENERATION } = {}) {
  if (!db) db = require("../prisma");
  if (!item?.id) return { acknowledged: false, lost: true };
  return runDbTransaction(db, async (tx) => {
    const ownership = await lockDomainWorkClaimForCommit({ db: tx, item, ownerToken, fallbackNow, generation });
    if (!ownership.current) return { acknowledged: false, lost: true };
    const authorityNow = ownership.authorityNow;
    if (typeof tx?.$queryRawUnsafe === "function") {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE "DomainWorkItem" SET
           "completedRevision"=GREATEST("completedRevision",$1),
           "state"=CASE WHEN "requestedRevision">$1 THEN 'READY' ELSE 'DONE' END,
           "isOutstanding"=CASE WHEN "requestedRevision">$1 THEN TRUE ELSE FALSE END,
           "availableAt"=CASE WHEN "requestedRevision">$1 THEN $2 ELSE "availableAt" END,
           "ownerToken"=NULL,"leaseUntil"=$2,"nextAttemptAt"=NULL,"errorClass"=NULL,"lastError"=NULL,
           "consecutiveFailures"=0,"failureRevision"=0,"lastFailureAt"=NULL,
           "terminalCause"=CASE WHEN "requestedRevision">$1 THEN NULL ELSE $7::text END,
           "progressCursor"=CASE WHEN "requestedRevision">$1 THEN NULL ELSE "progressCursor" END,
           "updatedAt"=CURRENT_TIMESTAMP
         WHERE "id"=$3 AND "state"='CLAIMED' AND "ownerToken"=$4 AND "claimFence"=$5
           AND "claimedRevision"=$1 AND "activeGeneration"=$6 AND "leaseUntil">$2
         RETURNING "requestedRevision","completedRevision","state"`,
        asBigInt(item.claimedRevision),authorityNow,String(item.id),String(ownerToken || item.ownerToken || ""),asBigInt(item.claimFence),String(generation),clean(terminalCause, 120),
      );
      const row = rows?.[0];
      return row ? { acknowledged: true, lost: false, state: row.state, requestedRevision: row.requestedRevision, completedRevision: row.completedRevision } : { acknowledged: false, lost: true };
    }
    const current = await tx.domainWorkItem?.findFirst?.({ where: { id: String(item.id) } });
    if (!current || String(current.ownerToken || "") !== String(ownerToken || item.ownerToken || "") || asBigInt(current.claimFence) !== asBigInt(item.claimFence)
      || asBigInt(current.claimedRevision) !== asBigInt(item.claimedRevision) || String(current.activeGeneration) !== String(generation)
      || !asDate(current.leaseUntil) || asDate(current.leaseUntil) <= authorityNow) return { acknowledged: false, lost: true };
    const hasNewer = asBigInt(current.requestedRevision) > asBigInt(item.claimedRevision);
    const changed = await tx.domainWorkItem.updateMany({
      where: claimWhere(item, ownerToken, authorityNow, generation),
      data: { completedRevision: asBigInt(item.claimedRevision), state: hasNewer ? STATE.READY : STATE.DONE, isOutstanding: hasNewer, availableAt: hasNewer ? authorityNow : current.availableAt, ownerToken: null, leaseUntil: authorityNow, nextAttemptAt: null, errorClass: null, lastError: null, consecutiveFailures: 0, failureRevision: 0n, lastFailureAt: null, terminalCause: hasNewer ? null : clean(terminalCause, 120), progressCursor: hasNewer ? null : current.progressCursor ?? null },
    });
    return Number(changed?.count || 0) === 1 ? { acknowledged: true, lost: false, state: hasNewer ? STATE.READY : STATE.DONE } : { acknowledged: false, lost: true };
  });
}

async function blockDomainWorkClaim({ db = null, item, ownerToken = null, dependencyKind, dependencyKey, dependencyRevision = 0n, reason = "DEPENDENCY_BLOCKED", fallbackNow = new Date(), generation = DOMAIN_WORK_GENERATION } = {}) {
  if (!db) db = require("../prisma");
  const depKind = clean(dependencyKind, 120); const depKey = clean(dependencyKey, 240);
  if (!item?.id || !depKind || !depKey) throw Object.assign(new Error("Blocked domain work requires claim and dependency identity"), { code: "DOMAIN_WORK_DEPENDENCY_REQUIRED" });
  return runDbTransaction(db, async (tx) => {
    const observedDependencyRevision = asBigInt(dependencyRevision);
    const currentDependency = await lockDependencyRevisionForBlock(tx, { agencyId: item.agencyId, dependencyKind: depKind, dependencyKey: depKey });
    // Keep the dependency -> DWI order used by dependency publishers/wakeups.
    const ownership = await lockDomainWorkClaimForCommit({ db: tx, item, ownerToken, fallbackNow, generation });
    if (!ownership.current) return { blocked: false, lost: true };
    const authorityNow = ownership.authorityNow;
    const baseWhere = claimWhere(item, ownerToken, authorityNow, generation);

    // If the dependency already advanced, never publish BLOCKED. The dependency row is
    // locked until this transaction commits, so a producer that advances it afterwards
    // must wait and will wake the READY/BLOCKED row after this transition.
    if (currentDependency > observedDependencyRevision) {
      const changed = await tx.domainWorkItem?.updateMany?.({ where: baseWhere, data: {
        state: STATE.READY, isOutstanding: true, availableAt: authorityNow, ownerToken: null, leaseUntil: authorityNow,
        dependencyKind: depKind, dependencyKey: depKey, dependencyRevision: currentDependency,
        errorClass: null, lastError: null, nextAttemptAt: null, progressCursor: null,
      } });
      return Number(changed?.count || 0) === 1 ? { blocked: false, ready: true, lost: false, newerDependency: true } : { blocked: false, lost: true };
    }

    // BLOCKED is only legal for exactly the revision that was claimed. A canonical
    // invalidation racing between the caller's read and this commit increments
    // requestedRevision and makes this first update miss instead of sleeping V2.
    const blocked = await tx.domainWorkItem?.updateMany?.({
      where: { ...baseWhere, requestedRevision: asBigInt(item.claimedRevision) },
      data: {
        state: STATE.BLOCKED, isOutstanding: true, ownerToken: null, leaseUntil: authorityNow,
        dependencyKind: depKind, dependencyKey: depKey, dependencyRevision: currentDependency,
        errorClass: "DEPENDENCY", lastError: clean(reason, 2000), nextAttemptAt: null,
      },
    });
    if (Number(blocked?.count || 0) === 1) return { blocked: true, ready: false, lost: false };

    // If the exact-revision transition missed only because a newer canonical revision
    // arrived while this claim is still ours, release it immediately as READY.
    const reopened = await tx.domainWorkItem?.updateMany?.({
      where: { ...baseWhere, requestedRevision: { gt: asBigInt(item.claimedRevision) } },
      data: {
        state: STATE.READY, isOutstanding: true, availableAt: authorityNow, ownerToken: null, leaseUntil: authorityNow,
        dependencyKind: depKind, dependencyKey: depKey, dependencyRevision: currentDependency,
        errorClass: null, lastError: null, nextAttemptAt: null, progressCursor: null,
      },
    });
    return Number(reopened?.count || 0) === 1 ? { blocked: false, ready: true, lost: false, newerRevision: true } : { blocked: false, lost: true };
  });
}

async function failDomainWorkClaim({ db = null, item, ownerToken = null, error = null, dependency = null, retryAt = null, fallbackNow = new Date(), generation = DOMAIN_WORK_GENERATION } = {}) {
  if (!db) db = require("../prisma");
  if (!item?.id) return { failed: false, lost: true };
  // Dependency identity/revision comes from the domain, never from message text.
  // Delegate BEFORE locking DWI to preserve dependency -> work lock ordering.
  if (dependency) return blockDomainWorkClaim({ db, item, ownerToken, ...dependency, fallbackNow, generation });
  return runDbTransaction(db, async (tx) => {
    const ownership = await lockDomainWorkClaimForCommit({ db: tx, item, ownerToken, fallbackNow, generation });
    if (!ownership.current) return { failed: false, lost: true };
    const authorityNow = ownership.authorityNow;
    const stored = ownership.item;
    const consecutiveFailures = (asBigInt(stored.failureRevision) === asBigInt(item.claimedRevision)
      ? Math.max(0, Number(stored.consecutiveFailures || 0)) : 0) + 1;
    const outcome = domainWorkFailureOutcome({ error, consecutiveFailures });
    // Respect a domain's later retry deadline, but never hot-loop a past one.
    const due = outcome.state === STATE.READY
      ? new Date(Math.max(authorityNow.getTime() + outcome.delayMs, asDate(retryAt)?.getTime() || 0)) : null;
    const baseWhere = claimWhere(item, ownerToken, authorityNow, generation);
    const failed = await tx.domainWorkItem?.updateMany?.({
      where: { ...baseWhere, requestedRevision: asBigInt(item.claimedRevision) },
      data: {
        state: outcome.state, isOutstanding: true, ownerToken: null, leaseUntil: authorityNow,
        ...(due ? { availableAt: due } : {}), nextAttemptAt: due,
        failureRevision: asBigInt(item.claimedRevision), consecutiveFailures, lastFailureAt: authorityNow,
        errorClass: outcome.errorClass, terminalCause: outcome.terminalCause,
        lastError: clean(`${outcome.code}: ${error?.message || error || "DOMAIN_WORK_FAILED"}`, 2000),
      },
    });
    if (Number(failed?.count || 0) === 1) return {
      failed: true, lost: false, retryAt: due, state: outcome.state,
      reconcileRequired: outcome.state === STATE.RECONCILE_REQUIRED, consecutiveFailures,
    };

    // A failure from V1 must never reintroduce V1 backoff/error state after a V2
    // canonical invalidation already reopened this identity. Preserve the new wakeup.
    const reopened = await tx.domainWorkItem?.updateMany?.({
      where: { ...baseWhere, requestedRevision: { gt: asBigInt(item.claimedRevision) } },
      data: {
        state: STATE.READY, ownerToken: null, leaseUntil: authorityNow, availableAt: authorityNow, nextAttemptAt: null,
        errorClass: null, lastError: null, progressCursor: null, terminalCause: null,
        consecutiveFailures: 0, failureRevision: 0n, lastFailureAt: null,
      },
    });
    return Number(reopened?.count || 0) === 1
      ? { failed: false, superseded: true, ready: true, lost: false, retryAt: null }
      : { failed: false, lost: true };
  });
}

async function saveDomainWorkProgress({ db = null, item, ownerToken = null, progressCursor, fallbackNow = new Date(), generation = DOMAIN_WORK_GENERATION } = {}) {
  if (!db) db = require("../prisma");
  if (!item?.id) return { saved: false, lost: true };
  return runDbTransaction(db, async (tx) => {
    const ownership = await lockDomainWorkClaimForCommit({ db: tx, item, ownerToken, fallbackNow, generation });
    if (!ownership.current) return { saved: false, lost: true };
    const authorityNow = ownership.authorityNow;
    const where = claimWhere(item, ownerToken, authorityNow, generation);
    where.requestedRevision = item.claimedRevision; // a new invalidation aborts the old enumeration cursor
    const madeProgress = progressCursor != null && !isDeepStrictEqual(progressCursor, ownership.item.progressCursor);
    const changed = await tx.domainWorkItem?.updateMany?.({ where, data: {
      progressCursor: progressCursor ?? null,
      ...(madeProgress ? { consecutiveFailures: 0, failureRevision: 0n, lastFailureAt: null, errorClass: null, lastError: null, terminalCause: null } : {}),
    } });
    return Number(changed?.count || 0) === 1 ? { saved: true, lost: false } : { saved: false, lost: true };
  });
}

async function yieldDomainWorkClaim({ db = null, item, ownerToken = null, progressCursor = undefined, availableAt = null, fallbackNow = new Date(), generation = DOMAIN_WORK_GENERATION, preserveProgressOnNewerRevision = false } = {}) {
  if (!db) db = require("../prisma");
  if (!item?.id) return { yielded: false, lost: true };
  return runDbTransaction(db, async (tx) => {
    const ownership = await lockDomainWorkClaimForCommit({ db: tx, item, ownerToken, fallbackNow, generation });
    if (!ownership.current) return { yielded: false, lost: true };
    const authorityNow = ownership.authorityNow;
    const due = asDate(availableAt) || authorityNow;
    const baseWhere = claimWhere(item, ownerToken, authorityNow, generation);
    const exactData = { state: STATE.READY, isOutstanding: true, ownerToken: null, leaseUntil: authorityNow, availableAt: due, nextAttemptAt: null, errorClass: null, lastError: null };
    if (progressCursor !== undefined) exactData.progressCursor = progressCursor;
    if (progressCursor != null && !isDeepStrictEqual(progressCursor, ownership.item.progressCursor)) {
      Object.assign(exactData, { consecutiveFailures: 0, failureRevision: 0n, lastFailureAt: null, terminalCause: null });
    }
    const yielded = await tx.domainWorkItem?.updateMany?.({
      where: { ...baseWhere, requestedRevision: asBigInt(item.claimedRevision) },
      data: exactData,
    });
    if (Number(yielded?.count || 0) === 1) return { yielded: true, lost: false, newerRevision: false, availableAt: due };

    // A continuation deadline belongs to the claimed revision only. If V2 arrived,
    // make V2 immediately eligible. Most consumers must discard the V1 cursor, but
    // bounded Team historical repair may explicitly carry a semantic-prefix cursor
    // across a newer live-tail revision. The repair itself revalidates its reply
    // boundary before using that cursor, so a boundary-changing revision rebases.
    const reopenedData = {
      state: STATE.READY, ownerToken: null, leaseUntil: authorityNow, availableAt: authorityNow, nextAttemptAt: null,
      errorClass: null, lastError: null,
      progressCursor: preserveProgressOnNewerRevision === true && progressCursor !== undefined ? progressCursor : null,
    };
    const reopened = await tx.domainWorkItem?.updateMany?.({
      where: { ...baseWhere, requestedRevision: { gt: asBigInt(item.claimedRevision) } },
      data: reopenedData,
    });
    return Number(reopened?.count || 0) === 1
      ? { yielded: true, lost: false, newerRevision: true, availableAt: authorityNow }
      : { yielded: false, lost: true };
  });
}

async function wakeDomainDependencyBatch({ db = null, item, limit = 100, fallbackNow = new Date() } = {}) {
  if (!db) db = require("../prisma");
  const agencyId = String(item?.agencyId || "").trim();
  const dependencyKind = String(item?.dependencyKind || "").trim();
  const dependencyKey = String(item?.dependencyKey || "").trim();
  const dependencyRevision = asBigInt(item?.dependencyRevision, 0n);
  const take = Math.max(1, Math.min(500, Number(limit) || 100));
  if (!agencyId || !dependencyKind || !dependencyKey || dependencyRevision <= 0n) {
    throw Object.assign(new Error("Dependency wake identity is incomplete"), { code: "DOMAIN_DEPENDENCY_WAKE_IDENTITY_REQUIRED" });
  }

  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(
      `SELECT "woken","remaining"
         FROM "phase3_wake_domain_dependency_batch"($1,$2,$3,$4,$5)`,
      agencyId, dependencyKind, dependencyKey, dependencyRevision, take,
    );
    return {
      woken: Number(rows?.[0]?.woken || 0),
      remaining: rows?.[0]?.remaining === true,
    };
  }

  // Test/adapter compatibility preserves the production authority boundary:
  // callers never mutate DomainWorkItem storage themselves. PostgreSQL performs
  // selection, SKIP LOCKED and the bounded mutation atomically in the function.
  const authorityNow = await dbAuthorityNow({ db, fallbackNow });
  const where = {
    agencyId,
    state: STATE.BLOCKED,
    isOutstanding: true,
    dependencyKind,
    dependencyKey,
    dependencyRevision: { lt: dependencyRevision },
  };
  const candidates = await db?.domainWorkItem?.findMany?.({
    where,
    select: { id: true },
    orderBy: [{ dependencyRevision: "asc" }, { id: "asc" }],
    take,
  }) || [];
  if (candidates.length) {
    await db.domainWorkItem.updateMany({
      where: { id: { in: candidates.map((row) => String(row.id)) }, ...where },
      data: {
        state: STATE.READY, isOutstanding: true, availableAt: authorityNow,
        nextAttemptAt: null, ownerToken: null, leaseUntil: authorityNow,
        progressCursor: null, errorClass: null, lastError: null, terminalCause: null,
      },
    });
  }
  const remaining = await db?.domainWorkItem?.findFirst?.({ where, select: { id: true } });
  return { woken: candidates.length, remaining: Boolean(remaining) };
}

async function bumpDomainDependency({ db = null, agencyId, dependencyKind, dependencyKey, fallbackNow = new Date() } = {}) {
  if (!db) db = require("../prisma");
  const a = clean(agencyId, 180); const kind = clean(dependencyKind, 120); const key = clean(dependencyKey, 240);
  if (!a || !kind || !key) throw Object.assign(new Error("Domain dependency identity is required"), { code: "DOMAIN_WORK_DEPENDENCY_REQUIRED" });
  return runDbTransaction(db, async (tx) => {
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    if (typeof tx?.$queryRawUnsafe === "function") {
      const rows = await tx.$queryRawUnsafe(`SELECT "phase2_bump_dependency"($1,$2,$3) AS revision`, a, kind, key);
      return asBigInt(rows?.[0]?.revision, 0n);
    }
    if (!tx?.phase2DependencyState?.upsert) throw Object.assign(new Error("Phase2DependencyState storage is unavailable"), { code: "DOMAIN_WORK_DEPENDENCY_STORAGE_REQUIRED" });
    const where = { agencyId_dependencyKind_dependencyKey: { agencyId: a, dependencyKind: kind, dependencyKey: key } };
    const existing = await tx.phase2DependencyState.findUnique?.({ where });
    const revision = asBigInt(existing?.revision, 0n) + 1n;
    await tx.phase2DependencyState.upsert({
      where,
      create: { id: dependencyId({ agencyId: a, dependencyKind: kind, dependencyKey: key }), agencyId: a, dependencyKind: kind, dependencyKey: key, revision, changedAt: authorityNow },
      update: { revision, changedAt: authorityNow },
    });
    // Production PostgreSQL performs the same publication inside
    // phase2_bump_dependency.  The adapter path must preserve that contract:
    // a producer advances one revision and one coalescing durable wake identity,
    // never synchronously enumerates all BLOCKED work for the dependency.
    await publishDomainWork({
      db: tx,
      agencyId: a,
      workClass: WORK_CLASS.DEPENDENCY_WAKE,
      objectType: DOMAIN_DEPENDENCY_WAKE_OBJECT_TYPE,
      objectId: dependencyId({ agencyId: a, dependencyKind: kind, dependencyKey: key }),
      partitionKey: key,
      dependencyKind: kind,
      dependencyKey: key,
      dependencyRevision: revision,
      availableAt: authorityNow,
    });
    return revision;
  });
}

async function runDomainDependencyWakeSweep({
  db = null,
  now = new Date(),
  claimLimit = 20,
  wakeLimit = 100,
} = {}) {
  if (!db) db = require("../prisma");
  const claim = await claimDomainWorkBatch({
    db,
    workClass: WORK_CLASS.DEPENDENCY_WAKE,
    limit: bounded(claimLimit, 20, MAX_BATCH),
    perAgencyQuantum: 2,
    perPartitionQuantum: 1,
    leaseMs: 2 * 60 * 1000,
    fallbackNow: now,
  });
  const report = {
    ok: true,
    selected: Number(claim?.items?.length || 0),
    woken: 0,
    completed: 0,
    yielded: 0,
    failed: 0,
    lostOwnership: 0,
    skipped: claim?.skipped === true,
    reason: claim?.reason || null,
    bridgeTransitioned: claim?.bridgeTransitioned === true,
  };
  for (const item of claim?.items || []) {
    try {
      if (String(item.objectType) !== DOMAIN_DEPENDENCY_WAKE_OBJECT_TYPE) {
        throw Object.assign(new Error(`Unsupported dependency wake object type: ${String(item.objectType || "")}`), {
          code: "DOMAIN_DEPENDENCY_WAKE_OBJECT_UNSUPPORTED",
        });
      }
      const batch = await wakeDomainDependencyBatch({
        db,
        item,
        limit: Math.max(1, Math.min(500, Number(wakeLimit) || 100)),
        fallbackNow: now,
      });
      report.woken += Number(batch.woken || 0);
      if (batch.remaining) {
        const yielded = await yieldDomainWorkClaim({
          db,
          item,
          ownerToken: claim.ownerToken,
          progressCursor: null,
          availableAt: now,
          fallbackNow: new Date(),
        });
        if (yielded?.lost) report.lostOwnership += 1;
        else report.yielded += 1;
      } else {
        const ack = await ackDomainWorkClaim({
          db,
          item,
          ownerToken: claim.ownerToken,
          fallbackNow: new Date(),
        });
        if (ack?.lost) report.lostOwnership += 1;
        else report.completed += 1;
      }
    } catch (error) {
      const failed = await failDomainWorkClaim({
        db,
        item,
        ownerToken: claim.ownerToken,
        error,
        fallbackNow: new Date(),
      }).catch(() => ({ lost: true }));
      if (failed?.lost) report.lostOwnership += 1;
      else report.failed += 1;
    }
  }
  report.ok = report.failed === 0 && report.lostOwnership === 0;
  return report;
}

async function currentDependencyRevision({ db = null, agencyId, dependencyKind, dependencyKey } = {}) {
  if (!db) db = require("../prisma");
  const row = await db?.phase2DependencyState?.findUnique?.({ where: { agencyId_dependencyKind_dependencyKey: { agencyId: String(agencyId), dependencyKind: String(dependencyKind), dependencyKey: String(dependencyKey) } } });
  return asBigInt(row?.revision, 0n);
}

module.exports = {
  DOMAIN_WORK_GENERATION, DOMAIN_WORK_PROJECTION_VERSION, DEFAULT_LEASE_MS, MAX_BATCH, DOMAIN_WORK_CLAIM_TOPOLOGY_ID,
  DOMAIN_WORK_MEMBER_SCOPE_SHARD_PROBE, DOMAIN_WORK_MEMBER_SCOPE_CREATOR_PROBE,
  DOMAIN_DEPENDENCY_WAKE_OBJECT_TYPE,
  WORK_CLASS, STATE, LEGACY_DRAIN_WORK_CLASSES,
  workId, publishDomainWork, activeDomainWorkGeneration, domainWorkFamilyState, hasOutstandingDomainWork, legacyExecutorDrainStatus, claimDomainWorkBatch, lockDomainWorkClaimForCommit, heartbeatDomainWorkClaim, ackDomainWorkClaim,
  blockDomainWorkClaim, failDomainWorkClaim, saveDomainWorkProgress, yieldDomainWorkClaim, wakeDomainDependencyBatch, bumpDomainDependency, runDomainDependencyWakeSweep, currentDependencyRevision,
  normalizeMemberClaimScope, lockMemberClaimAuthority, reserveMemberScopeCreatorProbe,
};
