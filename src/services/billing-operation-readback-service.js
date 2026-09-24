"use strict";

const crypto = require("node:crypto");
const MAX_READBACK_MS = 30 * 60_000;
function invalid() {
  return Object.assign(new Error("Readback requires a live committed operation and its exact read target"), {
    code: "BILLING_READBACK_INVALID", status: 403,
  });
}

// The source/priority label is deliberately not an authority. Targets come
// from the durable operation, and the physical descriptor is checked again by
// Desktop against the registered endpoint immediately before the gate.
function allowsOperationReadback(row, operation, request) {
  if (request?.method !== "GET" || typeof request.path !== "string" || !request.path.startsWith("/api2/v2/")) return false;
  const url = new URL(request.path, "https://onlyfans.com");
  if (url.origin !== "https://onlyfans.com" || url.hash) return false;
  const payload = row.payload || {}, result = row.result || {};
  let pathname = null, keys = [];
  const target = value => encodeURIComponent(String(value || ""));
  if (["FOLLOW_BACK", "FOLLOW_FAN", "UNFOLLOW_FAN", "SFS_FOLLOW_TARGET", "SFS_UNFOLLOW_TARGET"].includes(row.actionType)) {
    if (operation === "users.profile") pathname = `/api2/v2/users/${target(row.targetId || row.fanId)}`;
  } else if (["SEND_MESSAGE", "DELETE_MESSAGE", "VAULT_RELAY_SEND", "CUSTOM_RELAY_SEND", "CUSTOM_MANUAL_SEND"].includes(row.actionType)) {
    const dialog = row.dialogId || result.relayPreflight?.recipientId || payload.recipientId || row.fanId || row.targetId;
    if (operation === "chats.messages" && dialog) {
      pathname = `/api2/v2/chats/${target(dialog)}/messages`;
      keys = ["limit", "offset", "order", "skip_users", "firstId", "lastId"];
    }
  } else if (["SFS_COMMENT_POST", "SFS_LIKE_COMMENT"].includes(row.actionType)) {
    const postId = payload.postId || row.targetId;
    if (operation === "posts.comments" && postId) {
      pathname = `/api2/v2/posts/${target(postId)}/comments`;
      keys = ["limit", "offset", "sort", "format"];
    }
  } else if (row.actionType === "VAULT_CREATE_LIST" && operation === "vault.lists") {
    pathname = "/api2/v2/vault/lists";
    keys = ["view", "offset", "limit"];
  }
  if (!pathname || url.pathname !== pathname) return false;
  for (const key of url.searchParams.keys()) {
    if (!keys.includes(key) || url.searchParams.getAll(key).length !== 1) return false;
  }
  for (const key of ["limit", "offset"]) {
    const value = url.searchParams.get(key);
    if (value !== null && (!/^\d+$/.test(value) || Number(value) > (key === "limit" ? (operation === "vault.lists" ? 200 : 100) : 10000))) return false;
  }
  if (url.searchParams.has("view") && url.searchParams.get("view") !== "main") return false;
  if (url.searchParams.has("order") && url.searchParams.get("order") !== "desc") return false;
  return true;
}

async function assertOperationReadback({ db, agencyId, creatorId, userId, deviceId, member, capability, operation, operationReadback, physicalRequest }) {
  const proof = operationReadback;
  if (capability !== "read" || !proof || typeof proof.deliveryId !== "string" || typeof proof.leaseToken !== "string"
    || !Number.isInteger(proof.leaseRevision) || proof.leaseRevision < 1
    || !Number.isInteger(proof.writeCommitRevision) || proof.writeCommitRevision < 1) throw invalid();
  const rows = await db.$queryRawUnsafe(`SELECT d."actionType",d."targetId",d."fanId",d."dialogId",d."payload",d."result",
      d."claimUntil",d."writeCommitAt",clock_timestamp() AT TIME ZONE 'UTC' AS "authorityNow"
    FROM "AutomationDelivery" d
    JOIN "AgencyMember" m ON m."id"=d."leaseMemberId" AND m."agencyId"=d."agencyId"
    JOIN "User" u ON u."id"=m."userId" AND u."disabledAt" IS NULL
    JOIN "WorkerDevice" w ON w."id"=d."claimedByDeviceId" AND w."userId"=m."userId" AND w."agencyId"=d."agencyId"
    JOIN "CreatorAccount" c ON c."id"=d."creatorId" AND c."agencyId"=d."agencyId" AND c."deletedAt" IS NULL
    JOIN "Agency" a ON a."id"=d."agencyId" AND a."deletedAt" IS NULL
    WHERE d."id"=$1 AND d."agencyId"=$2 AND d."creatorId"=$3 AND d."claimedByDeviceId"=$4
      AND d."leaseTokenHash"=$5 AND d."leaseRevision"=$6 AND d."writeCommitRevision"=$7
      AND d."claimUntil">clock_timestamp() AT TIME ZONE 'UTC'
      AND d."writeCommitAt">clock_timestamp() AT TIME ZONE 'UTC' - interval '30 minutes'
      AND d."writeCommitAt"<=clock_timestamp() AT TIME ZONE 'UTC'
      AND d."status" IN ('CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED')
      AND (d."status" IN ('COMMITTING','RECONCILE_REQUIRED') OR d."failureCategory"='OUTCOME_UNKNOWN_RECONCILE'
        OR d."result"->>'outcomeState'='RECONCILE_REQUIRED')
      AND m."id"=$8 AND m."userId"=$9 AND m."accessEpoch"=$10 AND m."accessEpoch"=d."leaseAccessEpoch"
      AND m."deletedAt" IS NULL AND m."deactivatedAt" IS NULL
      AND ("phase3_member_has_broad_creator_access"(m."role"::text,m."roleKey",m."assignedCreators")
        OR "phase2_scope_allows_creator"(m."assignedCreators",d."creatorId"))`,
    proof.deliveryId, agencyId, creatorId, deviceId, crypto.createHash("sha256").update(proof.leaseToken).digest("hex"),
    proof.leaseRevision, proof.writeCommitRevision, String(member?.id || ""), userId, Number(member?.accessEpoch || 0));
  const row = rows?.[0];
  if (!row || !allowsOperationReadback(row, operation, physicalRequest)) throw invalid();
  return { allowed: false, recovery: true, reason: "OPERATION_READBACK", now: row.authorityNow,
    validUntil: new Date(Math.min(row.claimUntil.getTime(), row.writeCommitAt.getTime() + MAX_READBACK_MS)) };
}
module.exports = { assertOperationReadback, allowsOperationReadback, MAX_READBACK_MS };
