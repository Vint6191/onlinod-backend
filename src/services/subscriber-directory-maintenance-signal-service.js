"use strict";

const crypto = require("node:crypto");
const { dbAuthorityNow } = require("./db-time-authority-service");

const SUBSCRIBER_MAINTENANCE_KIND = Object.freeze({ RECOVERY: "RECOVERY", RETENTION: "RETENTION" });
const SUBSCRIBER_MAINTENANCE_CLAIM_MS = 2 * 60 * 1000;
const SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS = 100;

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
      $1,$2,$3,$4,$5,$6,1,0,NOW(),NOW()
    )
    ON CONFLICT ("creatorId","kind") DO UPDATE SET
      "agencyId"=EXCLUDED."agencyId",
      "dueAt"=LEAST("SubscriberDirectoryMaintenanceSignal"."dueAt",EXCLUDED."dueAt"),
      "reason"=EXCLUDED."reason",
      "revision"="SubscriberDirectoryMaintenanceSignal"."revision"+1,
      "attempts"=0,
      "lastError"=NULL,
      "updatedAt"=NOW()
    RETURNING "id","agencyId","creatorId","kind","dueAt","revision","claimToken","claimUntil"
  `, `submaint_${crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex")}`, agency, creator, signalKind, effectiveDueAt, clean(reason, 64) || "PUBLICATION_DEBT");
  const signal = Array.isArray(rows) ? rows[0] || null : null;
  return { signaled: Boolean(signal), signal };
}

async function claimSubscriberDirectoryMaintenanceSignal({ db, now = new Date(), statementTimeoutMs = 2_000 } = {}) {
  if (typeof db?.$transaction !== "function") return null;
  const fallbackNow = asDate(now);
  const claimToken = `subclaim_${crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex")}`;
  const timeoutMs = Math.max(250, Math.min(5_000, Number(statementTimeoutMs) || 2_000));
  return db.$transaction(async (tx) => {
    if (typeof tx?.$queryRawUnsafe !== "function") return null;
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${Math.floor(timeoutMs)}ms'`);
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const claimUntil = new Date(authorityNow.getTime() + SUBSCRIBER_MAINTENANCE_CLAIM_MS);
    const rows = await tx.$queryRawUnsafe(`
      WITH candidate AS (
        SELECT s."id"
        FROM "SubscriberDirectoryMaintenanceSignal" s
        WHERE s."dueAt" <= $1
          AND s."attempts" < ${SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS}
          AND COALESCE(s."claimUntil", '-infinity'::timestamp) <= $1
        ORDER BY s."dueAt" ASC, s."creatorId" ASC, s."kind" ASC
        FOR UPDATE OF s SKIP LOCKED
        LIMIT 1
      )
      UPDATE "SubscriberDirectoryMaintenanceSignal" s
      SET "claimToken"=$2, "claimUntil"=$3, "updatedAt"=NOW()
      FROM candidate c
      WHERE s."id"=c."id"
      RETURNING s."id",s."agencyId",s."creatorId",s."kind",s."dueAt",s."reason",s."revision",s."attempts",s."claimToken",s."claimUntil"
    `, authorityNow, claimToken, claimUntil);
    const signal = Array.isArray(rows) ? rows[0] || null : null;
    return signal ? { ...signal, claimedAt: authorityNow } : null;
  }, { maxWait: timeoutMs, timeout: timeoutMs + 1_000 });
}

async function subscriberMaintenanceClaimCurrent({ db, signal } = {}) {
  if (!signal?.id || !signal?.claimToken || typeof db?.subscriberDirectoryMaintenanceSignal?.findFirst !== "function") return false;
  const row = await db.subscriberDirectoryMaintenanceSignal.findFirst({
    where: { id: signal.id, claimToken: signal.claimToken, revision: Number(signal.revision || 0) },
    select: { id: true },
  });
  return Boolean(row);
}

async function ackSubscriberDirectoryMaintenanceSignal({ db, signal } = {}) {
  if (!signal?.id || !signal?.claimToken || typeof db?.subscriberDirectoryMaintenanceSignal?.deleteMany !== "function") return false;
  const deleted = await db.subscriberDirectoryMaintenanceSignal.deleteMany({
    where: { id: signal.id, claimToken: signal.claimToken, revision: Number(signal.revision || 0) },
  });
  if (Number(deleted?.count || 0) > 0) return true;
  if (typeof db?.subscriberDirectoryMaintenanceSignal?.updateMany === "function") {
    await db.subscriberDirectoryMaintenanceSignal.updateMany({
      where: { id: signal.id, claimToken: signal.claimToken },
      data: { claimToken: null, claimUntil: null },
    });
  }
  return false;
}

async function releaseSubscriberDirectoryMaintenanceSignal({ db, signal, now = new Date(), error = null, retryMs = 60_000 } = {}) {
  if (!signal?.id || !signal?.claimToken || typeof db?.$executeRawUnsafe !== "function") return false;
  const authorityNow = await dbAuthorityNow({ db, fallbackNow: asDate(now) });
  const retryDueAt = new Date(authorityNow.getTime() + Math.max(1_000, Math.min(15 * 60_000, Number(retryMs) || 60_000)));
  const count = await db.$executeRawUnsafe(`
    UPDATE "SubscriberDirectoryMaintenanceSignal"
    SET "dueAt"=$3, "claimToken"=NULL, "claimUntil"=NULL,
        "attempts"="attempts"+1, "lastError"=$4, "updatedAt"=NOW()
    WHERE "id"=$1 AND "claimToken"=$2 AND "revision"=$5
  `, signal.id, signal.claimToken, retryDueAt, clean(error?.message || error, 1000), Number(signal.revision || 0));
  if (Number(count || 0) > 0) return true;
  await db.$executeRawUnsafe(`
    UPDATE "SubscriberDirectoryMaintenanceSignal"
    SET "claimToken"=NULL, "claimUntil"=NULL, "updatedAt"=NOW()
    WHERE "id"=$1 AND "claimToken"=$2
  `, signal.id, signal.claimToken);
  return false;
}

module.exports = {
  SUBSCRIBER_MAINTENANCE_KIND,
  SUBSCRIBER_MAINTENANCE_CLAIM_MS,
  SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS,
  signalSubscriberDirectoryMaintenance,
  claimSubscriberDirectoryMaintenanceSignal,
  subscriberMaintenanceClaimCurrent,
  ackSubscriberDirectoryMaintenanceSignal,
  releaseSubscriberDirectoryMaintenanceSignal,
};
