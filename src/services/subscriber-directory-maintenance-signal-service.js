"use strict";
const { runDbTransaction } = require("./db-transaction-service");


const crypto = require("node:crypto");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { isTransientDatabaseError, classifyStoredDatabaseFailure, describeDatabaseFailure } = require("./db-retry-policy");

const SUBSCRIBER_MAINTENANCE_KIND = Object.freeze({ RECOVERY: "RECOVERY", RETENTION: "RETENTION", DERIVED_PLANNING: "DERIVED_PLANNING" });
const SUBSCRIBER_MAINTENANCE_CLAIM_MS = 2 * 60 * 1000;
const SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS = 100;
// Pre-v25 workers charged successful continuation against the error budget.
// Only these exact historical yield reasons are eligible for automatic repair.
const LEGACY_YIELD_ERRORS = ["subscriber_recovery_budget_exhausted", "maintenance_budget_exhausted", "publication_debt"];
// Due/lease columns are timestamp-without-time-zone containing UTC. Several
// signal operations run outside a commit-kernel transaction, so SQL must not
// interpret these values using a pool connection's local TimeZone.

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}
function asDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date();
}
function normalizeKind(value) {
  const kind = String(value || "").toUpperCase();
  if (!Object.values(SUBSCRIBER_MAINTENANCE_KIND).includes(kind)) {
    const error = new Error(`Unsupported Subscriber maintenance signal kind ${kind || "<empty>"}`);
    error.code = "SUBSCRIBER_MAINTENANCE_KIND_INVALID";
    throw error;
  }
  return kind;
}

async function signalSubscriberDirectoryMaintenance({
  db,
  agencyId,
  creatorId,
  kind,
  dueAt = null,
  reason = "PUBLICATION_DEBT",
} = {}) {
  const agency = clean(agencyId, 180);
  const creator = clean(creatorId, 180);
  const signalKind = normalizeKind(kind);
  if (!agency || !creator || typeof db?.$queryRawUnsafe !== "function") return { signaled: false, reason: "adapter_unsupported" };
  const authorityNow = await dbAuthorityNow({ db, fallbackNow: new Date() });
  const effectiveDueAt = dueAt == null ? authorityNow : asDate(dueAt);
  const rows = await db.$queryRawUnsafe(`
    INSERT INTO "SubscriberDirectoryMaintenanceSignal" (
      "id","agencyId","creatorId","kind","dueAt","reason","revision","attempts","createdAt","updatedAt"
    ) VALUES (
      $1,$2,$3,$4,$5,$6,1,0,(NOW() AT TIME ZONE 'UTC'),(NOW() AT TIME ZONE 'UTC')
    )
    ON CONFLICT ("creatorId","kind") DO UPDATE SET
      "agencyId"=EXCLUDED."agencyId",
      "dueAt"=LEAST("SubscriberDirectoryMaintenanceSignal"."dueAt",EXCLUDED."dueAt"),
      "reason"=EXCLUDED."reason",
      "revision"="SubscriberDirectoryMaintenanceSignal"."revision"+1,
      "attempts"=0,
      "claimToken"=NULL,
      "claimUntil"=NULL,
      "lastError"=NULL,
      "updatedAt"=(NOW() AT TIME ZONE 'UTC')
    RETURNING "id","agencyId","creatorId","kind","dueAt","revision","claimToken","claimUntil"
  `, `submaint_${crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex")}`, agency, creator, signalKind, effectiveDueAt, clean(reason, 64) || "PUBLICATION_DEBT");
  const signal = Array.isArray(rows) ? rows[0] || null : null;
  return { signaled: Boolean(signal), signal };
}

// Re-observing an unfinished publication is not a new publication revision.
// Repair a missing wake without stealing a healthy worker's claim, resetting
// its backoff or silently clearing a genuine quarantined error.
async function ensureSubscriberDirectoryMaintenance({ db, agencyId, creatorId, kind, reason = "PUBLICATION_DEBT" } = {}) {
  const agency = clean(agencyId, 180);
  const creator = clean(creatorId, 180);
  const signalKind = normalizeKind(kind);
  if (!agency || !creator || typeof db?.$queryRawUnsafe !== "function") return { signaled: false, reason: "adapter_unsupported" };
  const rows = await db.$queryRawUnsafe(`
    INSERT INTO "SubscriberDirectoryMaintenanceSignal" (
      "id","agencyId","creatorId","kind","dueAt","reason","revision","attempts","createdAt","updatedAt"
    ) VALUES ($1,$2,$3,$4,(clock_timestamp() AT TIME ZONE 'UTC'),$5,1,0,(clock_timestamp() AT TIME ZONE 'UTC'),(clock_timestamp() AT TIME ZONE 'UTC'))
    ON CONFLICT ("creatorId","kind") DO NOTHING
    RETURNING "id","agencyId","creatorId","kind","dueAt","revision","claimToken","claimUntil"
  `, `submaint_${crypto.randomUUID()}`, agency, creator, signalKind, clean(reason, 64) || "PUBLICATION_DEBT");
  if (rows.length) return { signaled: true, repaired: false, signal: rows[0] };
  // Older workers charged temporary database outages against their poison
  // budget and persisted only message text. Repair only an exact recognized
  // database diagnostic, scoped to this creator/kind. Revision + lease checks
  // prevent this planning wake from stealing a live owner or newer work.
  const prior = await db.$queryRawUnsafe(`
    SELECT "id","revision","attempts","lastError"
    FROM "SubscriberDirectoryMaintenanceSignal"
    WHERE "agencyId"=$1 AND "creatorId"=$2 AND "kind"=$3
      AND "attempts">=$4
      AND COALESCE("claimUntil",'-infinity'::timestamp)<=(clock_timestamp() AT TIME ZONE 'UTC')
    LIMIT 1
  `, agency, creator, signalKind, SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS);
  const old = prior[0];
  if (!old || !classifyStoredDatabaseFailure({ message: old.lastError })) return { signaled: false, repaired: false, signal: null };
  const repaired = await db.$queryRawUnsafe(`
    UPDATE "SubscriberDirectoryMaintenanceSignal"
    SET "attempts"=0,"lastError"=NULL,"claimToken"=NULL,"claimUntil"=NULL,
      "dueAt"=LEAST("dueAt",(clock_timestamp() AT TIME ZONE 'UTC')),"reason"='TRANSIENT_DATABASE_RECOVERY',
      "revision"="revision"+1,"updatedAt"=(clock_timestamp() AT TIME ZONE 'UTC')
    WHERE "id"=$1 AND "agencyId"=$2 AND "creatorId"=$3 AND "kind"=$4
      AND "revision"=$5 AND "attempts"=$6 AND "lastError" IS NOT DISTINCT FROM $7::text
      AND COALESCE("claimUntil",'-infinity'::timestamp)<=(clock_timestamp() AT TIME ZONE 'UTC')
    RETURNING "id","agencyId","creatorId","kind","dueAt","revision","claimToken","claimUntil"
  `, old.id, agency, creator, signalKind, Number(old.revision), Number(old.attempts), old.lastError);
  return { signaled: repaired.length > 0, repaired: repaired.length > 0, signal: repaired[0] || null };
}

async function claimSubscriberDirectoryMaintenanceSignal({ db, now = new Date(), statementTimeoutMs = 2_000 } = {}) {
  if (typeof db?.$transaction !== "function") return null;
  const fallbackNow = asDate(now);
  const claimToken = `subclaim_${crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex")}`;
  // The pump measures its remaining slice with performance.now(), whose result
  // is fractional. Commit-kernel budgets (and Prisma options) are integer ms.
  const timeoutMs = Math.max(250, Math.min(5_000, Math.floor(Number(statementTimeoutMs) || 2_000)));
  return runDbTransaction(db, async (tx) => {
    if (typeof tx?.$queryRawUnsafe !== "function") return null;
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${Math.floor(timeoutMs)}ms'`);
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const claimUntil = new Date(authorityNow.getTime() + SUBSCRIBER_MAINTENANCE_CLAIM_MS);
    const rows = await tx.$queryRawUnsafe(`
      WITH normal_candidate AS (
        SELECT s."id",s."dueAt",s."creatorId",s."kind"
        FROM "SubscriberDirectoryMaintenanceSignal" s
        WHERE s."dueAt" <= $1
          AND s."attempts" < ${SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS}
          AND COALESCE(s."claimUntil", '-infinity'::timestamp) <= $1
        ORDER BY s."dueAt" ASC, s."creatorId" ASC, s."kind" ASC
        FOR UPDATE OF s SKIP LOCKED
        LIMIT 1
      ), legacy_candidate AS (
        SELECT s."id",s."dueAt",s."creatorId",s."kind"
        FROM "SubscriberDirectoryMaintenanceSignal" s
        WHERE s."dueAt" <= $1
          AND s."attempts" >= ${SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS}
          AND (s."lastError" IS NULL OR s."lastError" IN
            ('subscriber_recovery_budget_exhausted','maintenance_budget_exhausted','publication_debt'))
          AND COALESCE(s."claimUntil", '-infinity'::timestamp) <= $1
        ORDER BY s."dueAt" ASC, s."creatorId" ASC, s."kind" ASC
        FOR UPDATE OF s SKIP LOCKED
        LIMIT 1
      ), structural_candidate AS (
        -- One known pre-repair quarantine. The diagnostic alone is insufficient:
        -- a live scoped publisher and its current generation authority must
        -- independently prove this exact stranded generation. Never adopt an
        -- unknown poison or steal an unexpired maintenance owner.
        SELECT s."id",s."dueAt",s."creatorId",s."kind"
        FROM "SubscriberDirectoryMaintenanceSignal" s
        JOIN "JobInstance" j ON j."agencyId"=s."agencyId" AND j."creatorId"=s."creatorId"
          AND j."jobKey"='subscriber_directory_scan' AND j."status"='PUBLISHING'
        JOIN "SubscriberScanRun" r ON r."id"=j."params"->>'scanRunId' AND r."jobId"=j."id"
          AND r."agencyId"=s."agencyId" AND r."creatorId"=s."creatorId"
        JOIN "SubscriberDirectoryState" d ON d."creatorId"=s."creatorId" AND d."agencyId"=s."agencyId"
        WHERE s."kind"='RECOVERY' AND s."attempts">=${SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS}
          AND s."dueAt" <= $1 AND COALESCE(s."claimUntil",'-infinity'::timestamp) <= $1
          AND s."lastError" ~ '^Subscriber publication generation [0-9]+ is stale behind allocated generation [0-9]+$'
          AND r."publicationGeneration">0 AND r."publicationGeneration"<d."publicationGeneration"
          AND r."hasMore"=false AND r."fanProjectionStatus"='COMPLETE'
          AND r."publicationStatus" IN ('PENDING','CURRENT','PREVIOUS','FINALIZE')
        ORDER BY s."dueAt",s."creatorId",s."kind"
        FOR UPDATE OF s SKIP LOCKED
        LIMIT 1
      ), eligible AS (
        SELECT * FROM normal_candidate UNION ALL SELECT * FROM legacy_candidate
        UNION ALL SELECT * FROM structural_candidate
      ), candidate AS (
        SELECT "id" FROM eligible ORDER BY "dueAt", "creatorId", "kind" LIMIT 1
      )
      UPDATE "SubscriberDirectoryMaintenanceSignal" s
      SET "claimToken"=$2, "claimUntil"=$3, "updatedAt"=(NOW() AT TIME ZONE 'UTC'),
          "attempts"=CASE WHEN s."attempts" >= ${SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS} THEN 0 ELSE s."attempts" END,
          "lastError"=CASE WHEN s."attempts" >= ${SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS} THEN NULL ELSE s."lastError" END
      FROM candidate c
      WHERE s."id"=c."id"
      RETURNING s."id",s."agencyId",s."creatorId",s."kind",s."dueAt",s."reason",s."revision",s."attempts",s."claimToken",s."claimUntil"
    `, authorityNow, claimToken, claimUntil);
    const signal = Array.isArray(rows) ? rows[0] || null : null;
    return signal ? { ...signal, claimedAt: authorityNow } : null;
  // Claim admission has several SQL round trips (kernel setup, statement cap,
  // database clock, then SKIP LOCKED). The pump's soft slice is not a client
  // transaction lifetime; at normal remote latency a 3s transaction could
  // expire before returning any owner and prevent every publication callback.
  }, { maxWait: 5_000, timeout: 15_000, lockTimeoutMs: timeoutMs, statementTimeoutMs: timeoutMs });
}

async function lockSubscriberMaintenanceClaimRow({ db, signal } = {}) {
  if (!signal?.id || !signal?.claimToken || typeof db?.$queryRawUnsafe !== "function") return null;
  const rows = await db.$queryRawUnsafe(`
    SELECT "id","agencyId","creatorId","kind","revision","claimToken","claimUntil",
           clock_timestamp() AS "authorityNow"
    FROM "SubscriberDirectoryMaintenanceSignal"
    WHERE "id"=$1
      AND "claimToken"=$2
      AND "revision"=$3
      AND "claimUntil" > (clock_timestamp() AT TIME ZONE 'UTC')
    FOR UPDATE
  `, signal.id, signal.claimToken, Number(signal.revision || 0));
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function subscriberMaintenanceClaimCurrent({ db, signal } = {}) {
  if (!signal?.id || !signal?.claimToken || typeof db?.$queryRawUnsafe !== "function") return false;
  const rows = await db.$queryRawUnsafe(`
    SELECT "id"
    FROM "SubscriberDirectoryMaintenanceSignal"
    WHERE "id"=$1
      AND "claimToken"=$2
      AND "revision"=$3
      AND "claimUntil" > (clock_timestamp() AT TIME ZONE 'UTC')
    LIMIT 1
  `, signal.id, signal.claimToken, Number(signal.revision || 0));
  return Array.isArray(rows) && rows.length === 1;
}

async function withSubscriberMaintenanceClaimFence({ db, signal, work, maxWaitMs = 5_000, timeoutMs = 30_000 } = {}) {
  if (!signal?.id || !signal?.claimToken || typeof work !== "function" || typeof db?.$transaction !== "function") {
    return { current: false, reason: "claim_fence_unavailable" };
  }
  return runDbTransaction(db, async (tx) => {
    // Standalone helper retained for explicit signal-only operations/tests.
    // Subscriber publication/recovery/retention MUST use publicationTransaction,
    // whose canonical lock order is automation fence -> creator lock -> signal row.
    const current = await lockSubscriberMaintenanceClaimRow({ db: tx, signal });
    if (!current) return { current: false, reason: "claim_stale_or_expired" };
    const result = await work(tx, {
      ...signal,
      claimUntil: current.claimUntil,
      authorityNow: current.authorityNow instanceof Date ? current.authorityNow : new Date(current.authorityNow),
    });
    return { current: true, result };
  }, { maxWait: Math.max(250, Number(maxWaitMs) || 5_000), timeout: Math.max(1_000, Number(timeoutMs) || 30_000) });
}

async function countPoisonedSubscriberMaintenanceSignals({ db } = {}) {
  if (typeof db?.subscriberDirectoryMaintenanceSignal?.count !== "function") return 0;
  return Number(await db.subscriberDirectoryMaintenanceSignal.count({
    where: { attempts: { gte: SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS }, lastError: { not: null, notIn: LEGACY_YIELD_ERRORS } },
  }) || 0);
}

async function listPoisonedSubscriberMaintenanceSignals({ db, limit = 100 } = {}) {
  if (typeof db?.subscriberDirectoryMaintenanceSignal?.findMany !== "function") return [];
  const take = Math.max(1, Math.min(500, Number(limit) || 100));
  return db.subscriberDirectoryMaintenanceSignal.findMany({
    where: { attempts: { gte: SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS }, lastError: { not: null, notIn: LEGACY_YIELD_ERRORS } },
    orderBy: [{ attempts: "desc" }, { dueAt: "asc" }, { creatorId: "asc" }],
    take,
  });
}

async function requeuePoisonedSubscriberMaintenanceSignal({ db, signalId, reason = "OPERATOR_REQUEUE" } = {}) {
  const id = clean(signalId, 180);
  if (!id || typeof db?.$queryRawUnsafe !== "function") return { requeued: false, reason: "signal_missing" };
  const rows = await db.$queryRawUnsafe(`
    UPDATE "SubscriberDirectoryMaintenanceSignal"
    SET "attempts"=0,
        "dueAt"=(clock_timestamp() AT TIME ZONE 'UTC'),
        "claimToken"=NULL,
        "claimUntil"=NULL,
        "lastError"=NULL,
        "reason"=$2,
        "revision"="revision"+1,
        "updatedAt"=(clock_timestamp() AT TIME ZONE 'UTC')
    WHERE "id"=$1 AND "attempts" >= ${SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS}
    RETURNING "id","agencyId","creatorId","kind","dueAt","revision"
  `, id, clean(reason, 64) || "OPERATOR_REQUEUE");
  return { requeued: Array.isArray(rows) && rows.length === 1, signal: rows?.[0] || null };
}

async function ackSubscriberDirectoryMaintenanceSignal({ db, signal } = {}) {
  if (!signal?.id || !signal?.claimToken) return false;
  if (typeof db?.$executeRawUnsafe === "function") {
    const count = await db.$executeRawUnsafe(`
      DELETE FROM "SubscriberDirectoryMaintenanceSignal"
      WHERE "id"=$1
        AND "claimToken"=$2
        AND "revision"=$3
        AND "claimUntil" > (clock_timestamp() AT TIME ZONE 'UTC')
    `, signal.id, signal.claimToken, Number(signal.revision || 0));
    return Number(count || 0) > 0;
  }
  if (typeof db?.subscriberDirectoryMaintenanceSignal?.deleteMany !== "function") return false;
  const deleted = await db.subscriberDirectoryMaintenanceSignal.deleteMany({
    where: {
      id: signal.id,
      claimToken: signal.claimToken,
      revision: Number(signal.revision || 0),
      claimUntil: { gt: new Date() },
    },
  });
  return Number(deleted?.count || 0) > 0;
}

async function releaseSubscriberDirectoryMaintenanceSignal({ db, signal, now = new Date(), error = null, retryMs = 60_000, retryAt = null } = {}) {
  if (!signal?.id || !signal?.claimToken || typeof db?.$executeRawUnsafe !== "function") return false;
  const authorityNow = await dbAuthorityNow({ db, fallbackNow: asDate(now) });
  const target = retryAt == null ? null : new Date(retryAt);
  const delay = target && Number.isFinite(target.getTime()) ? target.getTime() - authorityNow.getTime() : Number(retryMs) || 60_000;
  const retryDueAt = new Date(authorityNow.getTime() + Math.max(1_000, Math.min(15 * 60_000, delay)));
  const count = await db.$executeRawUnsafe(`
    UPDATE "SubscriberDirectoryMaintenanceSignal"
    SET "dueAt"=$3, "claimToken"=NULL, "claimUntil"=NULL,
        "attempts"=CASE WHEN $4::text IS NULL THEN 0 WHEN $6::boolean THEN "attempts" ELSE "attempts"+1 END,
        "lastError"=$4, "updatedAt"=(NOW() AT TIME ZONE 'UTC')
    WHERE "id"=$1 AND "claimToken"=$2 AND "revision"=$5
      AND "claimUntil" > (clock_timestamp() AT TIME ZONE 'UTC')
  `, signal.id, signal.claimToken, retryDueAt, error == null ? null : clean(describeDatabaseFailure(error, 1000), 1000),
    Number(signal.revision || 0), isTransientDatabaseError(error));
  return Number(count || 0) > 0;
}

module.exports = {
  SUBSCRIBER_MAINTENANCE_KIND,
  SUBSCRIBER_MAINTENANCE_CLAIM_MS,
  SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS,
  signalSubscriberDirectoryMaintenance,
  ensureSubscriberDirectoryMaintenance,
  claimSubscriberDirectoryMaintenanceSignal,
  subscriberMaintenanceClaimCurrent,
  lockSubscriberMaintenanceClaimRow,
  withSubscriberMaintenanceClaimFence,
  countPoisonedSubscriberMaintenanceSignals,
  listPoisonedSubscriberMaintenanceSignals,
  requeuePoisonedSubscriberMaintenanceSignal,
  ackSubscriberDirectoryMaintenanceSignal,
  releaseSubscriberDirectoryMaintenanceSignal,
};
