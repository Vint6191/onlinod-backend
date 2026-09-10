"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");

const DOMAIN_WORK_GENERATION = "phase2_domain_work_v1";
const DOMAIN_WORK_PROJECTION_VERSION = "phase2_domain_work_v1";
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
         "requestedRevision","completedRevision","activeGeneration","projectionVersion","state","availableAt",
         "dependencyKind","dependencyKey","dependencyRevision","createdAt","updatedAt"
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,0,$10,$11,'READY',$12,$13,$14,$15,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
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
         "availableAt"=LEAST("DomainWorkItem"."availableAt",EXCLUDED."availableAt"),
         "nextAttemptAt"=NULL,
         "progressCursor"=CASE WHEN "DomainWorkItem"."state"='CLAIMED' THEN "DomainWorkItem"."progressCursor" ELSE NULL END,
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
      create: { ...row, requestedRevision: 1n, completedRevision: 0n, state: STATE.READY, claimedRevision: 0n, claimFence: 0n },
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
      state: String(existing.state) === STATE.CLAIMED ? STATE.CLAIMED : STATE.READY,
      availableAt: asDate(existing.availableAt) && asDate(existing.availableAt) < row.availableAt ? existing.availableAt : row.availableAt,
      nextAttemptAt: null, progressCursor: String(existing.state) === STATE.CLAIMED ? existing.progressCursor ?? null : null,
      errorClass: null, lastError: null, terminalCause: null,
    },
  });
}


async function legacyExecutorDrainStatus({ db, workClass }) {
  const klass = clean(workClass, 120);
  if (!LEGACY_DRAIN_WORK_CLASSES.has(klass)) return { ready: true, lanes: [] };

  if (db?.phase2LegacyExecutorFence?.findMany && db?.maintenanceLaneState?.findMany) {
    const fences = await db.phase2LegacyExecutorFence.findMany({ select: { laneKey: true } });
    const keys = (fences || []).map((row) => clean(row?.laneKey, 180)).filter(Boolean);
    if (!keys.length) return { ready: false, lanes: [], reason: "legacy_executor_fence_uninitialized" };
    const rows = await db.maintenanceLaneState.findMany({
      where: { key: { in: keys }, ownerToken: { not: null } },
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
         ORDER BY m."key" ASC`);
    } catch (error) {
      const wrapped = new Error("Phase2 legacy executor fence is unavailable");
      wrapped.code = "PHASE2_LEGACY_EXECUTOR_FENCE_REQUIRED";
      wrapped.cause = error;
      throw wrapped;
    }
    return { ready: !(rows || []).length, lanes: rows || [], reason: (rows || []).length ? "legacy_executor_drain" : null };
  }

  // Reduced in-memory unit adapters do not model rolling replicas. Production Prisma
  // always has raw SQL support after the additive fence migration.
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
  const drain = await legacyExecutorDrainStatus({ db, workClass: klass });
  if (!drain.ready) {
    return { ownerToken, authorityNow: null, leaseUntil: null, items: [], skipped: true, reason: drain.reason || "legacy_executor_drain", legacyExecutors: drain.lanes || [] };
  }
  return runDbTransaction(db, async (tx) => {
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const leaseUntil = new Date(authorityNow.getTime() + Math.max(30_000, Number(leaseMs) || DEFAULT_LEASE_MS));
    if (typeof tx?.$queryRawUnsafe === "function") {
      const params = [klass, authorityNow, String(generation), quantum, partitionQuantum, take, ownerToken, leaseUntil];
      let filterSql = "";
      if (agencyId) { params.push(String(agencyId)); filterSql += ` AND d."agencyId"=$${params.length}`; }
      if (objectType) { params.push(String(objectType)); filterSql += ` AND d."objectType"=$${params.length}`; }
      const normalizedObjectIds = Array.from(new Set((Array.isArray(objectIds) ? objectIds : []).map((value) => clean(value, 240)).filter(Boolean)));
      if (normalizedObjectIds.length) {
        const placeholders = normalizedObjectIds.map((value) => { params.push(value); return `$${params.length}`; }).join(",");
        filterSql += ` AND d."objectId" IN (${placeholders})`;
      }
      const normalizedCreatorIds = Array.from(new Set((Array.isArray(creatorIds) ? creatorIds : []).map((value) => clean(value, 180)).filter(Boolean)));
      if (Array.isArray(creatorIds) && !normalizedCreatorIds.length) {
        return { ownerToken, authorityNow, leaseUntil, items: [] };
      }
      if (normalizedCreatorIds.length) {
        const placeholders = normalizedCreatorIds.map((value) => { params.push(value); return `$${params.length}`; }).join(",");
        filterSql += ` AND d."creatorId" IN (${placeholders})`;
      }
      const rows = await tx.$queryRawUnsafe(
        `WITH partition_ranked AS (
           SELECT d."id", d."agencyId", d."partitionKey", d."availableAt",
                  row_number() OVER (PARTITION BY d."agencyId",d."partitionKey" ORDER BY d."availableAt",d."id") AS partition_rn
             FROM "DomainWorkItem" d
            WHERE d."workClass"=$1
              AND (d."state"='READY' OR (d."state"='CLAIMED' AND d."leaseUntil" <= $2))
              AND d."availableAt" <= $2
              AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= $2)
              AND d."activeGeneration"=$3${filterSql}
         ), agency_ranked AS (
           SELECT p.*, row_number() OVER (PARTITION BY p."agencyId" ORDER BY p."availableAt",p."id") AS agency_rn
             FROM partition_ranked p WHERE p.partition_rn <= $5
         ), candidates AS (
           SELECT "id","availableAt" FROM agency_ranked WHERE agency_rn <= $4 ORDER BY "availableAt","id" LIMIT $6
         ), locked AS (
           SELECT d."id" FROM "DomainWorkItem" d JOIN candidates c ON c."id"=d."id"
            WHERE (d."state"='READY' OR (d."state"='CLAIMED' AND d."leaseUntil" <= $2))
              AND d."activeGeneration"=$3
            ORDER BY d."availableAt",d."id" FOR UPDATE OF d SKIP LOCKED
         )
         UPDATE "DomainWorkItem" d SET
           "state"='CLAIMED',"ownerToken"=$7,"claimFence"=d."claimFence"+1,
           "claimedRevision"=d."requestedRevision","leaseUntil"=$8,"attempts"=d."attempts"+1,
           "updatedAt"=CURRENT_TIMESTAMP
          FROM locked WHERE d."id"=locked."id"
         RETURNING d.*`, ...params,
      );
      return { ownerToken, authorityNow, leaseUntil, items: rows || [] };
    }
    if (!tx?.domainWorkItem?.findMany || !tx?.domainWorkItem?.updateMany) {
      return { ownerToken, authorityNow, leaseUntil, items: [], skipped: true, reason: "domain_work_storage_unavailable" };
    }
    const discovered = await tx.domainWorkItem.findMany({
      where: {
        workClass: klass,
        OR: [{ state: STATE.READY }, { state: STATE.CLAIMED, leaseUntil: { lte: authorityNow } }],
        activeGeneration: generation,
        availableAt: { lte: authorityNow },
        ...(agencyId ? { agencyId: String(agencyId) } : {}),
        ...(objectType ? { objectType: String(objectType) } : {}),
        ...(Array.isArray(objectIds) ? { objectId: { in: Array.from(new Set(objectIds.map((value) => String(value || "").trim()).filter(Boolean))) } } : {}),
        ...(Array.isArray(creatorIds) ? { creatorId: { in: Array.from(new Set(creatorIds.map((value) => String(value || "").trim()).filter(Boolean))) } } : {}),
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
      data: { completedRevision: asBigInt(item.claimedRevision), state: hasNewer ? STATE.READY : STATE.DONE, availableAt: hasNewer ? authorityNow : current.availableAt, ownerToken: null, leaseUntil: authorityNow, nextAttemptAt: null, errorClass: null, lastError: null, progressCursor: hasNewer ? null : current.progressCursor ?? null },
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
        state: STATE.READY, availableAt: authorityNow, ownerToken: null, leaseUntil: authorityNow,
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
        state: STATE.BLOCKED, ownerToken: null, leaseUntil: authorityNow,
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
        state: STATE.READY, availableAt: authorityNow, ownerToken: null, leaseUntil: authorityNow,
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
        state: STATE.READY, ownerToken: null, leaseUntil: authorityNow, availableAt: due, nextAttemptAt: due,
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

async function yieldDomainWorkClaim({ db = null, item, ownerToken = null, progressCursor = undefined, availableAt = null, fallbackNow = new Date(), generation = DOMAIN_WORK_GENERATION } = {}) {
  if (!db) db = require("../prisma");
  if (!item?.id) return { yielded: false, lost: true };
  return runDbTransaction(db, async (tx) => {
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const due = asDate(availableAt) || authorityNow;
    const baseWhere = claimWhere(item, ownerToken, authorityNow, generation);
    const exactData = { state: STATE.READY, ownerToken: null, leaseUntil: authorityNow, availableAt: due, nextAttemptAt: null, errorClass: null, lastError: null };
    if (progressCursor !== undefined) exactData.progressCursor = progressCursor;
    const yielded = await tx.domainWorkItem?.updateMany?.({
      where: { ...baseWhere, requestedRevision: asBigInt(item.claimedRevision) },
      data: exactData,
    });
    if (Number(yielded?.count || 0) === 1) return { yielded: true, lost: false, newerRevision: false, availableAt: due };

    // A continuation deadline belongs to the claimed revision only. If V2 arrived,
    // discard V1 cursor/delay and make V2 immediately eligible.
    const reopened = await tx.domainWorkItem?.updateMany?.({
      where: { ...baseWhere, requestedRevision: { gt: asBigInt(item.claimedRevision) } },
      data: {
        state: STATE.READY, ownerToken: null, leaseUntil: authorityNow, availableAt: authorityNow, nextAttemptAt: null,
        errorClass: null, lastError: null, progressCursor: null,
      },
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
      data: { state: STATE.READY, availableAt: authorityNow, nextAttemptAt: null, errorClass: null, lastError: null },
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
  workId, publishDomainWork, legacyExecutorDrainStatus, claimDomainWorkBatch, lockDomainWorkClaimForCommit, heartbeatDomainWorkClaim, ackDomainWorkClaim,
  blockDomainWorkClaim, failDomainWorkClaim, saveDomainWorkProgress, yieldDomainWorkClaim, bumpDomainDependency, currentDependencyRevision,
};
