"use strict";
const { createHash } = require("node:crypto");
const { isCommitTransaction } = require("./db-commit-kernel");
function onlineObservationWindow(observedAt, ttlMs) {
  const observed = observedAt instanceof Date ? observedAt : observedAt ? new Date(observedAt) : null;
  const ttl = Number(ttlMs);
  if (!observed || !Number.isFinite(observed.getTime()) || !Number.isSafeInteger(ttl) || ttl <= 0) return null;
  const expiresAt = new Date(observed.getTime() + ttl);
  return Number.isFinite(expiresAt.getTime()) ? { observedAt: observed, expiresAt } : null;
}
function onlineObservationFresh(observedAt, ttlMs, now) {
  const window = onlineObservationWindow(observedAt, ttlMs);
  return Boolean(window && now instanceof Date && window.observedAt <= now && window.expiresAt > now);
}
function isOnlineBumpSend(delivery) {
  return delivery?.moduleKey === "bumps" && delivery.actionType === "SEND_MESSAGE" && delivery.payload?.source === "online";
}
async function commitOnlineBumpWrite({ db, delivery, deviceId, leaseToken, leaseRevision, ttlMs }) {
  if (!isCommitTransaction(db) || !isOnlineBumpSend(delivery)) throw Object.assign(new Error("BUMP_WRITE_WINDOW_CONTEXT_REQUIRED"), { code: "BUMP_WRITE_WINDOW_CONTEXT_REQUIRED" });
  // Wait for the delivery and trigger row BEFORE sampling the permit clock.
  // The caller already holds lifecycle/access and the creator commit fence.
  const tokenHash = createHash("sha256").update(String(leaseToken)).digest("hex");
  const locked = await db.$queryRawUnsafe(`SELECT "id" FROM "AutomationDelivery"
    WHERE "id"=$1 AND "agencyId"=$2 AND "creatorId"=$3 AND "status"='RUNNING'
      AND "claimedByDeviceId"=$4 AND "leaseTokenHash"=$5 AND "leaseRevision"=$6
    FOR UPDATE`, delivery.id, delivery.agencyId, delivery.creatorId, deviceId, tokenHash, leaseRevision);
  if (!locked.length) return null;
  const states = await db.$queryRawUnsafe(`SELECT "lastOnlineAt" FROM "AutomationBumpFanState"
    WHERE "agencyId"=$1 AND "creatorId"=$2 AND "fanId"=$3 FOR UPDATE`, delivery.agencyId, delivery.creatorId, delivery.fanId);
  const window = onlineObservationWindow(states[0]?.lastOnlineAt, ttlMs);
  const rows = await db.$queryRawUnsafe(`WITH instant AS MATERIALIZED (
      SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at
    ), decision AS MATERIALIZED (
      SELECT at, COALESCE($5::timestamp <= at AND $6::timestamp > at, FALSE) AS fresh FROM instant
    )
    UPDATE "AutomationDelivery" d SET
      "status"=CASE WHEN w.fresh THEN 'COMMITTING' ELSE 'SKIPPED' END,
      "writeCommitRevision"=d."writeCommitRevision"+CASE WHEN w.fresh THEN 1 ELSE 0 END,
      "writeCommitAt"=CASE WHEN w.fresh THEN w.at ELSE d."writeCommitAt" END,
      "lastCheckedAt"=w.at, "updatedAt"=w.at,
      "failureCode"=CASE WHEN w.fresh THEN d."failureCode" ELSE 'stale_candidate' END,
      "lastError"=CASE WHEN w.fresh THEN d."lastError" ELSE 'stale_candidate' END,
      "finishedAt"=CASE WHEN w.fresh THEN d."finishedAt" ELSE w.at END,
      "claimedByDeviceId"=CASE WHEN w.fresh THEN d."claimedByDeviceId" ELSE NULL END,
      "claimedAt"=CASE WHEN w.fresh THEN d."claimedAt" ELSE NULL END,
      "claimUntil"=CASE WHEN w.fresh THEN d."claimUntil" ELSE NULL END,
      "leaseTokenHash"=CASE WHEN w.fresh THEN d."leaseTokenHash" ELSE NULL END,
      "leaseRevision"=d."leaseRevision"+CASE WHEN w.fresh THEN 0 ELSE 1 END,
      "result"=COALESCE(d."result",'{}'::jsonb) || CASE WHEN w.fresh
        THEN jsonb_build_object('writeCommitGrantedAt',to_char(w.at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'writeCommitLeaseRevision',d."leaseRevision",'onlineObservedAt',$5::timestamp,'onlineExpiresAt',$6::timestamp)
        ELSE jsonb_build_object('validationCode','stale_candidate','onlineWindowExpired',true) END
    FROM decision w WHERE d."id"=$1 AND d."status"='RUNNING'
      AND d."claimedByDeviceId"=$2 AND d."leaseTokenHash"=$3 AND d."leaseRevision"=$4
      AND d."claimUntil">w.at
    RETURNING d.*`, delivery.id, deviceId, tokenHash, leaseRevision, window?.observedAt || null, window?.expiresAt || null);
  return rows[0] || null;
}
module.exports = { onlineObservationWindow, onlineObservationFresh, isOnlineBumpSend, commitOnlineBumpWrite };
