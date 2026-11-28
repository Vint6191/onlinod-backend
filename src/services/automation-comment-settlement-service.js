"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { runDbTransaction } = require("./db-transaction-service");
const { isCommitTransaction } = require("./db-commit-kernel");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { lockAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");
const { finalizeSfsSuccess } = require("./sfs-service");

const AUTHORITY_VERSION = "AUTOMATION_COMMENT_RECEIPT_V1";
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const text = (value) => typeof value === "string" ? value.trim() : "";
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

function isCommentDelivery(delivery) {
  return delivery?.originKind === "AUTOMATION" && delivery.moduleKey === "sfs" && delivery.actionType === "SFS_COMMENT_POST";
}

function postIdOf(delivery) {
  const postId = text(object(delivery?.payload).postId);
  return postId && postId === text(delivery?.targetId) ? postId : null;
}

function tokenMatches(token, expected) {
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected) || !text(token)) return false;
  return crypto.timingSafeEqual(Buffer.from(hash(text(token)), "hex"), Buffer.from(expected, "hex"));
}

// A worker result may not invent or erase a capability minted by the commit
// transaction. This also protects the grant from a delayed older worker.
function preserveCommentSettlement(delivery, result) {
  const { commentSettlement: _untrusted, ...rest } = object(result);
  const stored = object(delivery?.result).commentSettlement;
  return stored ? { ...rest, commentSettlement: stored } : rest;
}

async function mintActionCommentSettlement({ db, delivery, deviceId }) {
  const postId = postIdOf(delivery);
  if (!isCommitTransaction(db) || !isCommentDelivery(delivery) || !postId || delivery.status !== "COMMITTING"
      || !delivery.writeCommitAt || !Number.isSafeInteger(delivery.writeCommitRevision) || delivery.writeCommitRevision < 1
      || delivery.claimedByDeviceId !== deviceId) {
    throw fail("ACTION_COMMENT_SETTLEMENT_CONTEXT_REQUIRED", "Comment receipt requires the committed comment transaction", 500);
  }
  if (object(delivery.result).commentSettlement) {
    throw fail("DELIVERY_ALREADY_COMMITTING", "Comment already has a committed receipt capability");
  }
  const settlementToken = crypto.randomBytes(32).toString("base64url");
  const commentSettlement = {
    version: 1, tokenHash: hash(settlementToken), deviceId, postId,
    operationId: delivery.idempotencyKey || delivery.id,
    writeCommitRevision: delivery.writeCommitRevision,
  };
  const changed = await db.automationDelivery.updateMany({
    where: { id: delivery.id, status: "COMMITTING", claimedByDeviceId: deviceId, writeCommitRevision: delivery.writeCommitRevision },
    data: { result: { ...object(delivery.result), commentSettlement } },
  });
  if (!changed.count) throw fail("DELIVERY_COMMIT_PERMIT_STALE", "Comment changed before its receipt was admitted");
  return { commentSettlementVersion: 1, settlementToken, postId };
}

function acknowledgement(delivery, grant, commentId, duplicate) {
  return {
    ok: true, duplicate, authorityVersion: AUTHORITY_VERSION, outcome: "PROVEN_SUCCESS",
    deliveryId: delivery.id, deviceId: grant.deviceId, operationId: grant.operationId,
    writeCommitRevision: grant.writeCommitRevision, postId: grant.postId, commentId,
  };
}

// This route only stores the exact response of an already admitted POST. It
// cannot send a comment, create work, or restore a creator execution lease.
async function completeActionCommentWithSettlementToken(input, db = prisma) {
  const deliveryId = text(input.deliveryId), commentId = text(input.commentId), postId = text(input.postId);
  const deviceId = text(input.deviceId), operationId = text(input.operationId);
  const revision = Number(input.writeCommitRevision), providerStatus = Number(input.providerStatus);
  const commentedAt = typeof input.commentedAt === "string" ? new Date(input.commentedAt) : null;
  if (input.authorityVersion !== AUTHORITY_VERSION || !deliveryId || !commentId || commentId.length > 160
      || !postId || postId.length > 160 || !deviceId || !operationId || !text(input.settlementToken)
      || !Number.isSafeInteger(revision) || revision < 1 || !Number.isInteger(providerStatus) || providerStatus < 200 || providerStatus > 299
      || !commentedAt || !Number.isFinite(commentedAt.getTime())) {
    throw fail("ACTION_COMMENT_RECEIPT_INVALID", "Exact successful comment response is required", 400);
  }
  return runDbTransaction(db, async (tx) => {
    const initial = await tx.automationDelivery.findUnique({ where: { id: deliveryId } });
    if (!initial) throw fail("ACTION_COMMENT_SETTLEMENT_BINDING_INVALID", "Comment receipt capability is invalid", 403);
    await lockAutomationWriteCommitFence({ db: tx, agencyId: initial.agencyId, creatorId: initial.creatorId });
    await tx.$queryRawUnsafe('SELECT "id" FROM "AutomationDelivery" WHERE "id"=$1 FOR UPDATE', deliveryId);
    const delivery = await tx.automationDelivery.findUnique({ where: { id: deliveryId } });
    const result = object(delivery?.result), grant = object(result.commentSettlement);
    if (!isCommentDelivery(delivery) || grant.version !== 1 || !tokenMatches(input.settlementToken, grant.tokenHash)
        || grant.deviceId !== deviceId || grant.operationId !== operationId
        || operationId !== (delivery.idempotencyKey || delivery.id) || grant.writeCommitRevision !== revision
        || delivery.writeCommitRevision !== revision || !delivery.writeCommitAt
        || grant.postId !== postId || postIdOf(delivery) !== postId) {
      throw fail("ACTION_COMMENT_SETTLEMENT_BINDING_INVALID", "Receipt does not match this committed comment", 403);
    }
    if (delivery.status === "COMPLETED") {
      if (result.commentId !== commentId || result.postId !== postId || result.commentOwnership?.kind !== "PROVIDER_COMMENT_ACK") {
        throw fail("ACTION_COMMENT_SETTLEMENT_CONFLICT", "Comment already has a different committed outcome");
      }
      return acknowledgement(delivery, grant, commentId, true);
    }
    const unknown = delivery.failureCategory === "OUTCOME_UNKNOWN_RECONCILE"
      || ["RECONCILE_REQUIRED", "UNRESOLVED_DO_NOT_RETRY"].includes(result.outcomeState);
    if (delivery.status !== "COMMITTING" && delivery.status !== "RECONCILE_REQUIRED" && !unknown) {
      throw fail("ACTION_COMMENT_NOT_SETTLEABLE", "Comment is not awaiting a committed response");
    }
    if (result.commentId && result.commentId !== commentId) {
      throw fail("ACTION_COMMENT_SETTLEMENT_CONFLICT", "Comment already has a different exact response");
    }
    const now = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
    const settledResult = {
      ...result, code: "commented", postId, commentId, commentedAt: commentedAt.toISOString(), providerStatus,
      commentOwnership: { kind: "PROVIDER_COMMENT_ACK", operationId, postId, commentId },
      outcomeState: "PROVEN_SUCCESS", exactResponseProof: true, recoveredByVerification: false, completedAt: now.toISOString(),
    };
    const current = await tx.automationDelivery.update({ where: { id: deliveryId }, data: {
      status: "COMPLETED", result: settledResult, failureCode: null, failureCategory: null,
      reportedFailureCategory: null, lastError: null, finishedAt: now, lastCheckedAt: now,
      claimUntil: null, leaseTokenHash: null, leaseRevision: { increment: 1 },
    } });
    await finalizeSfsSuccess({ db: tx, delivery: current, outcomeCode: "commented", result: settledResult, now });
    return acknowledgement(current, grant, commentId, false);
  }, { timeout: 30_000 });
}

module.exports = { AUTHORITY_VERSION, isCommentDelivery, preserveCommentSettlement, mintActionCommentSettlement, completeActionCommentWithSettlementToken };
