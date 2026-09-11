"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");

const DOMAIN_WORK_GENERATION = "phase2_domain_work_v3_actual55";
const DOMAIN_WORK_PROJECTION_VERSION = "phase2_domain_work_v3_actual55";
const DEFAULT_LEASE_MS = 2 * 60 * 1000;
const MAX_BATCH = 100;

const WORK_CLASS = Object.freeze({
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
  DEPENDENCY_FANOUT: "DEPENDENCY_FANOUT",
  HISTORICAL_ENUMERATION: "HISTORICAL_ENUMERATION",
  RETENTION: "RETENTION",
  DESTRUCTIVE_CREATOR_CLEANUP: "DESTRUCTIVE_CREATOR_CLEANUP",
  DESTRUCTIVE_AGENCY_CLEANUP: "DESTRUCTIVE_AGENCY_CLEANUP",
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
  return {
    id: workId({ agencyId, workClass, objectType, objectId }), agencyId, workClass, objectType, objectId,
    parentObjectId: clean(input.parentObjectId, 240),
    partitionKey: clean(input.partitionKey, 240) || agencyId,
    creatorId: clean(input.creatorId, 180), accountId: clean(input.accountId, 180),
    dependencyKind: clean(input.dependencyKind, 120), dependencyKey: clean(input.dependencyKey, 240),
    dependencyRevision: asBigInt(input.dependencyRevision, 0n),
    availableAt: asDate(input.availableAt) || new Date(),
    activeGeneration: clean(input.activeGeneration, 120) || DOMAIN_WORK_GENERATION,
    projectionVersion: clean(input.projectionVersion, 120) || DOMAIN_WORK_PROJECTION_VERSION,
  };
}

async function publishDomainWork({ db = null, ...input } = {}) {
  if (!db) db = require("../prisma");
  const row = normalizePublish(input);
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(
      `INSERT INTO "DomainWorkItem"(
         "id","agencyId","workClass","objectType","objectId","parentObjectId","partitionKey","creatorId","accountId",
         "requestedRevision","completedRevision","activeGeneration","projectionVersion","state","isOutstanding","availableAt",
         "dependencyKind","dependencyKey","dependencyRevision","createdAt","updatedAt"
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,0,$10,$11,'READY',TRUE,$12,$13,$14,$15,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
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
  const existing = await db.domainWorkItem.findUnique?.({ where: identityWhere(row) });
  if (!existing) {
    return db.domainWorkItem.upsert({
      where: identityWhere(row),
      create: { ...row, requestedRevision: 1n, completedRevision: 0n, state: STATE.READY, isOutstanding: true, claimedRevision: 0n, claimFence: 0n },
      update: {},
    });
  }
  return db.domainWorkItem.update({
    where: { id: existing.id },
    data: {
      requestedRevision: { increment: 1 }, parentObjectId: row.parentObjectId || existing.parentObjectId || null, partitionKey: row.partitionKey,
      creatorId: row.creatorId || existing.creatorId || null, accountId: row.accountId || existing.accountId || null,
      dependencyKind: row.dependencyKind, dependencyKey: row.dependencyKey,
      dependencyRevision: row.dependencyRevision > asBigInt(existing.dependencyRevision) ? row.dependencyRevision : asBigInt(existing.dependencyRevision),
      state: String(existing.state) === STATE.CLAIMED ? STATE.CLAIMED : STATE.READY, isOutstanding: true,
      availableAt: asDate(existing.availableAt) && asDate(existing.availableAt) < row.availableAt ? existing.availableAt : row.availableAt,
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
  let row = null;
  if (db?.phase2WorkFamilyState?.findUnique) {
    row = await db.phase2WorkFamilyState.findUnique({
      where: { agencyId_workClass: { agencyId: a, workClass: klass } },
    });
  } else if (typeof db?.$queryRawUnsafe === "function") {
    try {
      const rows = await db.$queryRawUnsafe(
        `SELECT * FROM "Phase2WorkFamilyState" WHERE "agencyId"=$1 AND "workClass"=$2 LIMIT 1`,
        a, klass,
      );
      row = rows?.[0] || null;
    } catch (_) {}
  }

  const activeGeneration = await activeDomainWorkGeneration({ db, workClass: klass, fallback: DOMAIN_WORK_GENERATION });
  if (!row) {
    // Missing family-state is not proof of zero. Probe exactly one physically-current
    // DWI identity; this is bounded and indexed, not a lifetime-history scan.
    const present = await probeCurrentDomainWorkPresence({ db, agencyId: a, workClass: klass, activeGeneration });
    if (present === true) {
      return { fresh: false, outstandingCount: null, hasOutstanding: true, state: "FAMILY_STATE_MISSING", row: null, activeGeneration };
    }
    if (present === false) {
      return { fresh: true, outstandingCount: 0, hasOutstanding: false, state: "NO_LIVE_WORK", row: null, activeGeneration };
    }
    return { fresh: false, outstandingCount: null, hasOutstanding: null, state: "UNKNOWN", row: null, activeGeneration };
  }

  const outstandingCount = Math.max(0, Number(row.outstandingCount || 0));
  const requestedSequence = asBigInt(row.requestedSequence, 0n);
  const convergedSequence = asBigInt(row.convergedSequence, 0n);
  const familyGeneration = clean(row.activeGeneration, 120);

  // Phase2WorkGenerationAuthority is the generation authority. A stale family row is
  // never allowed to certify current work from its old counters.  However, if the
  // physically-current generation proves zero, the stale projection is equivalent to
  // a missing family row and must not create permanent liveness debt after a generation
  // cutover.  Current DWI truth wins in both directions.
  if (familyGeneration && String(familyGeneration) !== String(activeGeneration)) {
    const present = await probeCurrentDomainWorkPresence({ db, agencyId: a, workClass: klass, activeGeneration });
    if (present === false) {
      return {
        fresh: true,
        outstandingCount: 0,
        hasOutstanding: false,
        requestedSequence,
        convergedSequence,
        state: "NO_LIVE_WORK_STALE_FAMILY_PROJECTION",
        row,
        activeGeneration,
        familyGeneration,
      };
    }
    return {
      fresh: false,
      outstandingCount: present === true ? Math.max(1, outstandingCount) : null,
      hasOutstanding: present === true ? true : null,
      requestedSequence,
      convergedSequence,
      state: present === true ? "FAMILY_STATE_GENERATION_STALE" : "FAMILY_STATE_GENERATION_UNPROVEN",
      row,
      activeGeneration,
      familyGeneration,
    };
  }

  const projectedFresh = outstandingCount === 0 && convergedSequence >= requestedSequence;
  if (projectedFresh) {
    // Projection ZERO is a release boundary, so prove it against the physical current
    // DWI workset. This catches a missing/undercounted family row repaired by a scoped
    // ACK and any other projection drift without making hot non-zero reads scan history.
    const present = await probeCurrentDomainWorkPresence({ db, agencyId: a, workClass: klass, activeGeneration });
    if (present === true) {
      return {
        fresh: false, outstandingCount, hasOutstanding: true, requestedSequence, convergedSequence,
        state: "FAMILY_STATE_FALSE_ZERO", row, activeGeneration, familyGeneration: familyGeneration || activeGeneration,
      };
    }
    if (present !== false) {
      return {
        fresh: false, outstandingCount: null, hasOutstanding: null, requestedSequence, convergedSequence,
        state: "FAMILY_STATE_ZERO_UNPROVEN", row, activeGeneration, familyGeneration: familyGeneration || activeGeneration,
      };
    }
  }

  return {
    fresh: projectedFresh, outstandingCount, hasOutstanding: outstandingCount > 0, requestedSequence, convergedSequence,
    state: projectedFresh ? "FRESH" : "STALE", row, activeGeneration, familyGeneration: familyGeneration || activeGeneration,
  };
}

async function hasOutstandingDomainWork({ db = null, agencyId, workClass } = {}) {
  const status = await domainWorkFamilyState({ db, agencyId, workClass });
  if (typeof status.hasOutstanding === "boolean") return status.hasOutstanding;
  return status.outstandingCount == null ? null : status.outstandingCount > 0;
}

async function legacyExecutorDrainStatus({ db, workClass, fallbackNow = new Date() }) {
  const klass = clean(workClass, 120);
  if (!LEGACY_DRAIN_WORK_CLASSES.has(klass)) return { ready: true, lanes: [] };
  const authorityNow = await dbAuthorityNow({ db, fallbackNow });

  if (db?.phase2LegacyExecutorFence?.findMany && db?.maintenanceLaneState?.findMany) {
    const fences = await db.phase2LegacyExecutorFence.findMany({ select: { laneKey: true } });
    const keys = (fences || []).map((row) => clean(row?.laneKey, 180)).filter(Boolean);
    if (!keys.length) return { ready: false, lanes: [], reason: "legacy_executor_fence_uninitialized" };
    const rows = await db.maintenanceLaneState.findMany({
      where: { key: { in: keys }, ownerToken: { not: null }, leaseUntil: { gt: authorityNow } },
      select: { key: true, generation: true, ownerToken: true, leaseUntil: true },
    });
    return { ready: !(rows || []).length, lanes: rows || [], reason: (rows || []).length ? "legacy_executor_drain" : null };
  }

  if (typeof db?.$queryRawUnsafe === "function") {
    let rows;
    try {
      rows = await db.$queryRawUnsafe(`
        SELECT m."key",m."generation",m."ownerToken",m."leaseUntil"
          FROM "MaintenanceLaneState" m
          JOIN "Phase2LegacyExecutorFence" f ON f."laneKey"=m."key"
         WHERE m."ownerToken" IS NOT NULL
           AND m."leaseUntil" > $1
         ORDER BY m."key" ASC`, authorityNow);
    } catch (error) {
      const wrapped = new Error("Phase2 legacy executor fence is unavailable");
      wrapped.code = "PHASE2_LEGACY_EXECUTOR_FENCE_REQUIRED";
      wrapped.cause = error;
      throw wrapped;
    }
    return { ready: !(rows || []).length, lanes: rows || [], reason: (rows || []).length ? "legacy_executor_drain" : null };
  }

  return { ready: true, lanes: [], skipped: true, reason: "legacy_executor_fence_adapter_unavailable" };
}

async function claimDomainWorkBatch({
  db = null, workClass, agencyId = null, objectType = null, objectIds = null, creatorIds = null, ownerToken = randomUUID(), limit = 25,
  perAgencyQuantum = 10, perPartitionQuantum = 2, leaseMs = DEFAULT_LEASE_MS, generation = DOMAIN_WORK_GENERATION, fallbackNow = new Date(),
} = {}) {
  if (!db) db = require("../prisma");
  const klass = clean(workClass, 120);
  if (!klass) throw Object.assign(new Error("workClass is required"), { code: "DOMAIN_WORK_CLASS_REQUIRED" });
  const take = bounded(limit);
  const quantum = bounded(perAgencyQuantum, 10, take);
  const partitionQuantum = bounded(perPartitionQuantum, 2, quantum);
  const normalizedObjectIds = Array.from(new Set((Array.isArray(objectIds) ? objectIds : []).map((value) => clean(value, 240)).filter(Boolean)));
  const normalizedCreatorIds = Array.from(new Set((Array.isArray(creatorIds) ? creatorIds : []).map((value) => clean(value, 180)).filter(Boolean)));
  if (Array.isArray(creatorIds) && !normalizedCreatorIds.length) {
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

  // Actual55 Root A: ready-head rows are no longer execution authority.  They were
  // introduced as a physical admission optimization, but making correctness depend
  // on their mutable MIN created the F55-01/F55-02/F55-05 failure cluster (Prisma
  // VOID decoding, Agency-wide serialization and row/advisory lock inversion).
  // Production admission now starts from physically-current isOutstanding DWI rows.
  // Creator-scoped workers seek their exact creator identities; broad workers first
  // choose a due Agency from the small per-family convergence set, then rank only a
  // bounded current-DWI window for partition fairness.
  if (rawCapable && normalizedCreatorIds.length) {
    const scopedAgencyId = clean(agencyId, 180);
    if (!scopedAgencyId) {
      throw Object.assign(new Error("creator-scoped DomainWork claim requires agencyId"), { code: "DOMAIN_WORK_SCOPED_AGENCY_REQUIRED" });
    }
    return runDbTransaction(db, async (tx) => {
      const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
      const leaseUntil = new Date(authorityNow.getTime() + Math.max(30_000, Number(leaseMs) || DEFAULT_LEASE_MS));
      if (typeof tx?.$queryRawUnsafe !== "function") {
        return { ownerToken, authorityNow, leaseUntil, items: [], skipped: true, reason: "domain_work_raw_storage_unavailable" };
      }
      const params = [klass, authorityNow, String(generation), ownerToken, leaseUntil, partitionQuantum, take];
      const creatorValues = normalizedCreatorIds.map((value) => {
        params.push(value);
        return `($${params.length})`;
      }).join(",");
      params.push(scopedAgencyId);
      let scopedWorkFilter = ` AND d."agencyId"=$${params.length}`;
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
         ), candidates AS (
           SELECT d."id",d."availableAt"
             FROM scoped_creators c
             CROSS JOIN LATERAL (
               SELECT d."id",d."availableAt"
                 FROM "DomainWorkItem" d
                WHERE d."workClass"=$1
                  AND d."activeGeneration"=$3
                  AND d."creatorId"=c."creatorId"
                  AND d."isOutstanding"=TRUE
                  AND (d."state"='READY' OR (d."state"='CLAIMED' AND d."leaseUntil" <= $2))
                  AND d."availableAt" <= $2
                  AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= $2)${scopedWorkFilter}
                ORDER BY d."availableAt",d."id"
                FOR UPDATE OF d SKIP LOCKED
                LIMIT $6
             ) d
            ORDER BY d."availableAt",d."id"
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
    const claimed = [];
    const seenAgencies = [];
    const maxAgencies = agencyId ? 1 : Math.max(1, Math.min(take, 100));
    let firstAuthorityNow = null;
    let lastLeaseUntil = null;
    let recoveryProbeUsed = false;

    for (let attempt = 0; attempt < maxAgencies && claimed.length < take; attempt += 1) {
      const remaining = take - claimed.length;
      const tranche = await runDbTransaction(db, async (tx) => {
        const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
        const leaseUntil = new Date(authorityNow.getTime() + Math.max(30_000, Number(leaseMs) || DEFAULT_LEASE_MS));
        if (typeof tx?.$queryRawUnsafe !== "function") return { agencyId: null, authorityNow, leaseUntil, items: [] };

        let selectedAgency = clean(agencyId, 180);
        let recoveredAgencyNeedsFamilyRebuild = false;
        if (!selectedAgency) {
          let rows = [];
          // INT7 recovery admission is driven by the compact partition catalog, not
          // by a negative scan of the complete physical DWI backlog. This allows a
          // missing/stale/false-zero family projection to compete with healthy Agencies
          // without making every normal broad claim O(all outstanding work). Catalog
          // metadata is never execution truth: a physical due DWI is re-proven with
          // EXISTS before an Agency can be admitted.
          if (!recoveryProbeUsed) {
            recoveryProbeUsed = true;
            const recoveryParams = [klass, authorityNow, String(generation)];
            let recoveryExcluded = "";
            if (seenAgencies.length) {
              const placeholders = seenAgencies.map((value) => { recoveryParams.push(value); return `$${recoveryParams.length}`; }).join(",");
              recoveryExcluded = ` AND f."agencyId" NOT IN (${placeholders})`;
            }
            rows = await tx.$queryRawUnsafe(
              `SELECT f."agencyId"
                 FROM "Phase2WorkBroadClaimPartitionState" f
                 LEFT JOIN "Phase2WorkFamilyState" s
                   ON s."agencyId"=f."agencyId" AND s."workClass"=f."workClass"
                WHERE f."workClass"=$1 AND f."activeGeneration"=$3${recoveryExcluded}
                  AND (s."agencyId" IS NULL OR s."activeGeneration" IS DISTINCT FROM $3 OR s."outstandingCount"<=0)
                  AND EXISTS (
                    SELECT 1 FROM "DomainWorkItem" d
                     WHERE d."agencyId"=f."agencyId" AND d."workClass"=$1 AND d."activeGeneration"=$3
                       AND d."partitionKey"=f."partitionKey" AND d."isOutstanding"=TRUE
                       AND (d."state"='READY' OR (d."state"='CLAIMED' AND d."leaseUntil" <= $2))
                       AND d."availableAt" <= $2 AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= $2)
                     LIMIT 1
                  )
                ORDER BY f."lastClaimedAt" ASC NULLS FIRST,f."agencyId" ASC,f."partitionKey" ASC
                LIMIT 1`, ...recoveryParams,
            );
            selectedAgency = clean(rows?.[0]?.agencyId, 180);
            recoveredAgencyNeedsFamilyRebuild = Boolean(selectedAgency);
          }

          if (!selectedAgency) {
            const agencyParams = [klass, authorityNow, String(generation)];
            let excluded = "";
            if (seenAgencies.length) {
              const placeholders = seenAgencies.map((value) => { agencyParams.push(value); return `$${agencyParams.length}`; }).join(",");
              excluded = ` AND s."agencyId" NOT IN (${placeholders})`;
            }
            rows = await tx.$queryRawUnsafe(
              `SELECT s."agencyId"
                 FROM "Phase2WorkFamilyState" s
                WHERE s."workClass"=$1
                  AND s."activeGeneration"=$3
                  AND s."outstandingCount">0${excluded}
                  AND EXISTS (
                    SELECT 1 FROM "DomainWorkItem" d
                     WHERE d."agencyId"=s."agencyId" AND d."workClass"=$1 AND d."activeGeneration"=$3
                       AND d."isOutstanding"=TRUE
                       AND (d."state"='READY' OR (d."state"='CLAIMED' AND d."leaseUntil" <= $2))
                       AND d."availableAt" <= $2 AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= $2)
                     LIMIT 1
                  )
                ORDER BY s."lastBroadClaimedAt" ASC NULLS FIRST,s."lastRequestedAt" ASC NULLS FIRST,s."agencyId" ASC
                LIMIT 1`, ...agencyParams,
            );
            selectedAgency = clean(rows?.[0]?.agencyId, 180);
          }

          // If both derived projections are absent/corrupt, fail safe but remain
          // self-healing: only after catalog recovery and normal family scheduling
          // find nothing do we admit one earliest physical due Agency. This query does
          // not prove a negative over the backlog; LIMIT 1 can stop at the first due
          // row and the subsequent claim rebuilds both derived projections.
          if (!selectedAgency) {
            const physicalParams = [klass, authorityNow, String(generation)];
            let physicalExcluded = "";
            if (seenAgencies.length) {
              const placeholders = seenAgencies.map((value) => { physicalParams.push(value); return `$${physicalParams.length}`; }).join(",");
              physicalExcluded = ` AND d."agencyId" NOT IN (${placeholders})`;
            }
            rows = await tx.$queryRawUnsafe(
              `SELECT d."agencyId"
                 FROM "DomainWorkItem" d
                WHERE d."workClass"=$1 AND d."activeGeneration"=$3 AND d."isOutstanding"=TRUE${physicalExcluded}
                  AND (d."state"='READY' OR (d."state"='CLAIMED' AND d."leaseUntil" <= $2))
                  AND d."availableAt" <= $2 AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= $2)
                ORDER BY d."availableAt",d."agencyId",d."partitionKey",d."id" LIMIT 1`, ...physicalParams,
            );
            selectedAgency = clean(rows?.[0]?.agencyId, 180);
            recoveredAgencyNeedsFamilyRebuild = Boolean(selectedAgency);
          }
        }
        if (!selectedAgency) return { agencyId: null, authorityNow, leaseUntil, items: [] };



        const agencyTake = Math.max(1, Math.min(remaining, quantum));
        // Select a small rotating set of physical partition heads, then lock only
        // rows from those partitions. The old 4096-row prefix could be monopolized
        // by one hot partition and also locked thousands of rows that would not be
        // claimed. Fairness state is scheduling metadata only; DWI remains work truth.
        const partitionsNeeded = Math.max(1, Math.ceil(agencyTake / partitionQuantum));
        const partitionSelectionCap = Math.min(256, Math.max(partitionsNeeded, partitionsNeeded * 2));
        const params = [klass, authorityNow, String(generation), selectedAgency, partitionSelectionCap, partitionQuantum, agencyTake, ownerToken, leaseUntil];
        let workFilter = "";
        if (objectType) {
          params.push(String(objectType));
          workFilter += ` AND d."objectType"=$${params.length}`;
        }
        if (normalizedObjectIds.length) {
          const placeholders = normalizedObjectIds.map((value) => { params.push(value); return `$${params.length}`; }).join(",");
          workFilter += ` AND d."objectId" IN (${placeholders})`;
        }

        // INT7: broad scheduling starts from the durable partition catalog, not from
        // DISTINCT ON over the complete outstanding DWI workset. The catalog is only
        // admission metadata: every selected partition is re-proven against physical
        // due DWI before any row is locked/claimed. This keeps the hot path bounded by
        // partition metadata + the requested claim quantum rather than by queue depth.
        let rows = await tx.$queryRawUnsafe(
          `WITH selected_partitions AS MATERIALIZED (
             SELECT f."partitionKey"
               FROM "Phase2WorkBroadClaimPartitionState" f
              WHERE f."agencyId"=$4 AND f."workClass"=$1 AND f."activeGeneration"=$3
                AND EXISTS (
                  SELECT 1 FROM "DomainWorkItem" d
                   WHERE d."agencyId"=$4 AND d."workClass"=$1 AND d."activeGeneration"=$3
                     AND d."partitionKey"=f."partitionKey"
                     AND d."isOutstanding"=TRUE
                     AND (d."state"='READY' OR (d."state"='CLAIMED' AND d."leaseUntil" <= $2))
                     AND d."availableAt" <= $2 AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= $2)${workFilter}
                   LIMIT 1
                )
              ORDER BY f."lastClaimedAt" ASC NULLS FIRST,f."partitionKey" ASC
              LIMIT $5
           ), candidates AS MATERIALIZED (
             SELECT picked."id",picked."availableAt",p."partitionKey"
               FROM selected_partitions p
               CROSS JOIN LATERAL (
                 SELECT d."id",d."availableAt"
                   FROM "DomainWorkItem" d
                  WHERE d."agencyId"=$4 AND d."workClass"=$1 AND d."activeGeneration"=$3
                    AND d."partitionKey"=p."partitionKey"
                    AND d."isOutstanding"=TRUE
                    AND (d."state"='READY' OR (d."state"='CLAIMED' AND d."leaseUntil" <= $2))
                    AND d."availableAt" <= $2 AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= $2)${workFilter}
                  ORDER BY d."availableAt",d."id"
                  FOR UPDATE OF d SKIP LOCKED
                  LIMIT $6
               ) picked
              ORDER BY picked."availableAt",picked."id"
              LIMIT $7
           ), claimed AS (
             UPDATE "DomainWorkItem" d SET
               "state"='CLAIMED',"ownerToken"=$8,"claimFence"=d."claimFence"+1,
               "claimedRevision"=d."requestedRevision","leaseUntil"=$9,"attempts"=d."attempts"+1,
               "updatedAt"=CURRENT_TIMESTAMP
              FROM candidates c WHERE d."id"=c."id"
             RETURNING d.*
           ), partition_touch AS (
             UPDATE "Phase2WorkBroadClaimPartitionState" f
                SET "lastClaimedAt"=$2,"updatedAt"=CURRENT_TIMESTAMP
               FROM (SELECT DISTINCT "partitionKey" FROM claimed) c
              WHERE f."agencyId"=$4 AND f."workClass"=$1 AND f."activeGeneration"=$3
                AND f."partitionKey"=c."partitionKey"
             RETURNING 1
           ), family_touch AS (
             UPDATE "Phase2WorkFamilyState" s
                SET "lastBroadClaimedAt"=$2,"updatedAt"=CURRENT_TIMESTAMP
              WHERE s."agencyId"=$4 AND s."workClass"=$1 AND s."activeGeneration"=$3
                AND EXISTS (SELECT 1 FROM claimed)
             RETURNING 1
           )
           SELECT c.* FROM claimed c`, ...params,
        );

        // Corrupt/missing catalog metadata must never hide physical current work.
        // If the bounded catalog lane produced nothing, claim exactly one physical due
        // row directly. The DWI catalog trigger repairs that partition in the same
        // transaction, so this is a self-healing exceptional path rather than a second
        // work authority or an O(all partitions) steady-state scan.
        if (Number(rows?.length || 0) === 0) {
          rows = await tx.$queryRawUnsafe(
            `WITH candidate AS MATERIALIZED (
               SELECT d."id",d."partitionKey",d."availableAt"
                 FROM "DomainWorkItem" d
                WHERE d."agencyId"=$4 AND d."workClass"=$1 AND d."activeGeneration"=$3
                  AND d."isOutstanding"=TRUE
                  AND (d."state"='READY' OR (d."state"='CLAIMED' AND d."leaseUntil" <= $2))
                  AND d."availableAt" <= $2 AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= $2)${workFilter}
                ORDER BY d."availableAt",d."partitionKey",d."id"
                FOR UPDATE OF d SKIP LOCKED
                LIMIT 1
             ), claimed AS (
               UPDATE "DomainWorkItem" d SET
                 "state"='CLAIMED',"ownerToken"=$8,"claimFence"=d."claimFence"+1,
                 "claimedRevision"=d."requestedRevision","leaseUntil"=$9,"attempts"=d."attempts"+1,
                 "updatedAt"=CURRENT_TIMESTAMP
                FROM candidate c WHERE d."id"=c."id"
               RETURNING d.*
             ), partition_touch AS (
               INSERT INTO "Phase2WorkBroadClaimPartitionState"(
                 "id","agencyId","workClass","partitionKey","activeGeneration","lastClaimedAt","createdAt","updatedAt"
               )
               SELECT 'p2wbcps_' || md5($4 || E'\x1f' || $1 || E'\x1f' || c."partitionKey"),
                      $4,$1,c."partitionKey",$3,$2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
                 FROM (SELECT DISTINCT "partitionKey" FROM claimed) c
               ON CONFLICT ("agencyId","workClass","partitionKey") DO UPDATE SET
                 "activeGeneration"=EXCLUDED."activeGeneration",
                 "lastClaimedAt"=EXCLUDED."lastClaimedAt",
                 "updatedAt"=CURRENT_TIMESTAMP
               RETURNING 1
             ), family_touch AS (
               UPDATE "Phase2WorkFamilyState" s
                  SET "lastBroadClaimedAt"=$2,"updatedAt"=CURRENT_TIMESTAMP
                WHERE s."agencyId"=$4 AND s."workClass"=$1 AND s."activeGeneration"=$3
                  AND EXISTS (SELECT 1 FROM claimed)
               RETURNING 1
             )
             SELECT c.* FROM claimed c`, ...params,
          );
        }

        // Recovery must obey the same global lock order as publication/settlement:
        // DWI row first, family projection second. Repairing family-state before the
        // claim would introduce FamilyState -> DWI while normal settlement is
        // DWI -> FamilyState, recreating a deadlock cycle on the exceptional path.
        // The family rebuild is a bounded lower-bound sample (max 1024 current rows),
        // never an all-outstanding COUNT inside the claim transaction. If more work
        // exists, INT6 physical false-zero detection will re-enter this recovery path
        // after the sampled lower bound drains; release still requires physical zero.
        if (recoveredAgencyNeedsFamilyRebuild && Number(rows?.length || 0) > 0) {
          await tx.$queryRawUnsafe(
            `WITH bounded_live AS MATERIALIZED (
               SELECT d."updatedAt"
                 FROM "DomainWorkItem" d
                WHERE d."agencyId"=$1 AND d."workClass"=$2 AND d."activeGeneration"=$3
                  AND d."isOutstanding"=TRUE
                LIMIT 1024
             ), live AS MATERIALIZED (
               SELECT COUNT(*)::integer AS n,MAX("updatedAt") AS "lastRequestedAt"
                 FROM bounded_live
             )
             INSERT INTO "Phase2WorkFamilyState"(
               "id","agencyId","workClass","activeGeneration","outstandingCount",
               "requestedSequence","convergedSequence","lastRequestedAt","lastConvergedAt","createdAt","updatedAt"
             )
             SELECT 'p2wfs_' || md5($1 || E'\x1f' || $2),$1,$2,$3,live.n,1,0,
                    live."lastRequestedAt",NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
               FROM live WHERE live.n>0
             ON CONFLICT ("agencyId","workClass") DO UPDATE SET
               "activeGeneration"=EXCLUDED."activeGeneration",
               "outstandingCount"=EXCLUDED."outstandingCount",
               "requestedSequence"=GREATEST(
                 "Phase2WorkFamilyState"."requestedSequence",
                 "Phase2WorkFamilyState"."convergedSequence"+1
               ),
               "convergedSequence"=LEAST(
                 "Phase2WorkFamilyState"."convergedSequence",
                 GREATEST(
                   "Phase2WorkFamilyState"."requestedSequence",
                   "Phase2WorkFamilyState"."convergedSequence"+1
                 )-1
               ),
               "lastRequestedAt"=COALESCE(EXCLUDED."lastRequestedAt","Phase2WorkFamilyState"."lastRequestedAt"),
               "lastConvergedAt"=NULL,
               "updatedAt"=CURRENT_TIMESTAMP
             RETURNING "agencyId"`,
            selectedAgency, klass, String(generation),
          );
        }
        return { agencyId: selectedAgency, authorityNow, leaseUntil, items: rows || [] };
      });

      if (!firstAuthorityNow) firstAuthorityNow = tranche.authorityNow || null;
      if (tranche.leaseUntil) lastLeaseUntil = tranche.leaseUntil;
      if (!tranche.agencyId) break;
      seenAgencies.push(tranche.agencyId);
      claimed.push(...(tranche.items || []));
      if (agencyId) break;
    }
    return { ownerToken, authorityNow: firstAuthorityNow, leaseUntil: lastLeaseUntil, items: claimed.slice(0, take) };
  }

  // Adapter/unit fallback. Production PostgreSQL uses the raw paths above; keep
  // the bounded in-memory admission model for lightweight storage adapters.
  return runDbTransaction(db, async (tx) => {
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const leaseUntil = new Date(authorityNow.getTime() + Math.max(30_000, Number(leaseMs) || DEFAULT_LEASE_MS));
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
        ...(agencyId ? { agencyId: String(agencyId) } : {}),
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
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
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
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const leaseUntil = new Date(authorityNow.getTime() + Math.max(30_000, Number(leaseMs) || DEFAULT_LEASE_MS));
    const changed = await tx.domainWorkItem?.updateMany?.({ where: claimWhere(item, ownerToken, authorityNow, generation), data: { leaseUntil } });
    if (Number(changed?.count || 0) !== 1) return { renewed: false, lost: true, authorityNow };
    return { renewed: true, lost: false, authorityNow, leaseUntil };
  });
}

async function ackDomainWorkClaim({ db = null, item, ownerToken = null, fallbackNow = new Date(), generation = DOMAIN_WORK_GENERATION } = {}) {
  if (!db) db = require("../prisma");
  if (!item?.id) return { acknowledged: false, lost: true };
  return runDbTransaction(db, async (tx) => {
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    if (typeof tx?.$queryRawUnsafe === "function") {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE "DomainWorkItem" SET
           "completedRevision"=GREATEST("completedRevision",$1),
           "state"=CASE WHEN "requestedRevision">$1 THEN 'READY' ELSE 'DONE' END,
           "isOutstanding"=CASE WHEN "requestedRevision">$1 THEN TRUE ELSE FALSE END,
           "availableAt"=CASE WHEN "requestedRevision">$1 THEN $2 ELSE "availableAt" END,
           "ownerToken"=NULL,"leaseUntil"=$2,"nextAttemptAt"=NULL,"errorClass"=NULL,"lastError"=NULL,
           "progressCursor"=CASE WHEN "requestedRevision">$1 THEN NULL ELSE "progressCursor" END,
           "updatedAt"=CURRENT_TIMESTAMP
         WHERE "id"=$3 AND "state"='CLAIMED' AND "ownerToken"=$4 AND "claimFence"=$5
           AND "claimedRevision"=$1 AND "activeGeneration"=$6 AND "leaseUntil">$2
         RETURNING "requestedRevision","completedRevision","state"`,
        asBigInt(item.claimedRevision),authorityNow,String(item.id),String(ownerToken || item.ownerToken || ""),asBigInt(item.claimFence),String(generation),
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
      data: { completedRevision: asBigInt(item.claimedRevision), state: hasNewer ? STATE.READY : STATE.DONE, isOutstanding: hasNewer, availableAt: hasNewer ? authorityNow : current.availableAt, ownerToken: null, leaseUntil: authorityNow, nextAttemptAt: null, errorClass: null, lastError: null, progressCursor: hasNewer ? null : current.progressCursor ?? null },
    });
    return Number(changed?.count || 0) === 1 ? { acknowledged: true, lost: false, state: hasNewer ? STATE.READY : STATE.DONE } : { acknowledged: false, lost: true };
  });
}

async function blockDomainWorkClaim({ db = null, item, ownerToken = null, dependencyKind, dependencyKey, dependencyRevision = 0n, reason = "DEPENDENCY_BLOCKED", fallbackNow = new Date(), generation = DOMAIN_WORK_GENERATION } = {}) {
  if (!db) db = require("../prisma");
  const depKind = clean(dependencyKind, 120); const depKey = clean(dependencyKey, 240);
  if (!item?.id || !depKind || !depKey) throw Object.assign(new Error("Blocked domain work requires claim and dependency identity"), { code: "DOMAIN_WORK_DEPENDENCY_REQUIRED" });
  return runDbTransaction(db, async (tx) => {
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const observedDependencyRevision = asBigInt(dependencyRevision);
    const currentDependency = await lockDependencyRevisionForBlock(tx, { agencyId: item.agencyId, dependencyKind: depKind, dependencyKey: depKey });
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

async function failDomainWorkClaim({ db = null, item, ownerToken = null, error = null, retryAt = null, fallbackNow = new Date(), generation = DOMAIN_WORK_GENERATION } = {}) {
  if (!db) db = require("../prisma");
  if (!item?.id) return { failed: false, lost: true };
  return runDbTransaction(db, async (tx) => {
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const attempts = Math.max(1, Number(item.attempts || 1));
    const delay = Math.min(15 * 60_000, Math.max(1_000, 2 ** Math.min(10, attempts) * 1_000));
    const due = asDate(retryAt) || new Date(authorityNow.getTime() + delay);
    const baseWhere = claimWhere(item, ownerToken, authorityNow, generation);
    const failed = await tx.domainWorkItem?.updateMany?.({
      where: { ...baseWhere, requestedRevision: asBigInt(item.claimedRevision) },
      data: {
        state: STATE.READY, isOutstanding: true, ownerToken: null, leaseUntil: authorityNow, availableAt: due, nextAttemptAt: due,
        errorClass: clean(error?.code || "TRANSIENT", 120), lastError: clean(error?.message || error || "DOMAIN_WORK_FAILED", 2000),
      },
    });
    if (Number(failed?.count || 0) === 1) return { failed: true, lost: false, retryAt: due };

    // A failure from V1 must never reintroduce V1 backoff/error state after a V2
    // canonical invalidation already reopened this identity. Preserve the new wakeup.
    const reopened = await tx.domainWorkItem?.updateMany?.({
      where: { ...baseWhere, requestedRevision: { gt: asBigInt(item.claimedRevision) } },
      data: {
        state: STATE.READY, ownerToken: null, leaseUntil: authorityNow, availableAt: authorityNow, nextAttemptAt: null,
        errorClass: null, lastError: null, progressCursor: null,
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
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const where = claimWhere(item, ownerToken, authorityNow, generation);
    where.requestedRevision = item.claimedRevision; // a new invalidation aborts the old enumeration cursor
    const changed = await tx.domainWorkItem?.updateMany?.({ where, data: { progressCursor: progressCursor ?? null } });
    return Number(changed?.count || 0) === 1 ? { saved: true, lost: false } : { saved: false, lost: true };
  });
}

async function yieldDomainWorkClaim({ db = null, item, ownerToken = null, progressCursor = undefined, availableAt = null, fallbackNow = new Date(), generation = DOMAIN_WORK_GENERATION, preserveProgressOnNewerRevision = false } = {}) {
  if (!db) db = require("../prisma");
  if (!item?.id) return { yielded: false, lost: true };
  return runDbTransaction(db, async (tx) => {
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const due = asDate(availableAt) || authorityNow;
    const baseWhere = claimWhere(item, ownerToken, authorityNow, generation);
    const exactData = { state: STATE.READY, isOutstanding: true, ownerToken: null, leaseUntil: authorityNow, availableAt: due, nextAttemptAt: null, errorClass: null, lastError: null };
    if (progressCursor !== undefined) exactData.progressCursor = progressCursor;
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
    if (tx?.domainWorkItem?.updateMany) await tx.domainWorkItem.updateMany({
      where: { agencyId: a, state: STATE.BLOCKED, dependencyKind: kind, dependencyKey: key, dependencyRevision: { lt: revision } },
      data: { state: STATE.READY, isOutstanding: true, availableAt: authorityNow, nextAttemptAt: null, errorClass: null, lastError: null },
    });
    return revision;
  });
}

async function currentDependencyRevision({ db = null, agencyId, dependencyKind, dependencyKey } = {}) {
  if (!db) db = require("../prisma");
  const row = await db?.phase2DependencyState?.findUnique?.({ where: { agencyId_dependencyKind_dependencyKey: { agencyId: String(agencyId), dependencyKind: String(dependencyKind), dependencyKey: String(dependencyKey) } } });
  return asBigInt(row?.revision, 0n);
}

module.exports = {
  DOMAIN_WORK_GENERATION, DOMAIN_WORK_PROJECTION_VERSION, DEFAULT_LEASE_MS, MAX_BATCH, WORK_CLASS, STATE, LEGACY_DRAIN_WORK_CLASSES,
  workId, publishDomainWork, activeDomainWorkGeneration, domainWorkFamilyState, hasOutstandingDomainWork, legacyExecutorDrainStatus, claimDomainWorkBatch, lockDomainWorkClaimForCommit, heartbeatDomainWorkClaim, ackDomainWorkClaim,
  blockDomainWorkClaim, failDomainWorkClaim, saveDomainWorkProgress, yieldDomainWorkClaim, bumpDomainDependency, currentDependencyRevision,
};
