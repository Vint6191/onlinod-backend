"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { runDbTransaction } = require("./db-transaction-service");
const { isCommitTransaction } = require("./db-commit-kernel");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { lockAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");
const { finalizeBumpSend } = require("./bump-service");

const AUTHORITY_VERSION = "AUTOMATION_MESSAGE_RECEIPT_V1";
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const text = (value) => typeof value === "string" ? value.trim() : "";
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function fail(code, message, status = 409) { return Object.assign(new Error(message), { code, status }); }
function isMessageDelivery(delivery) {
  return delivery?.originKind === "AUTOMATION" && delivery.moduleKey === "bumps" && delivery.actionType === "SEND_MESSAGE";
}
function tokenMatches(token, expected) {
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected) || !text(token)) return false;
  return crypto.timingSafeEqual(Buffer.from(hash(text(token)), "hex"), Buffer.from(expected, "hex"));
}

// Only the database-owned capability survives client result replacement. A
// normal completion/failure may neither invent nor erase a post-commit receipt.
function preserveMessageSettlement(delivery, result) {
  const { messageSettlement: _clientCapability, ...rest } = object(result);
  const stored = object(delivery?.result).messageSettlement;
  return stored ? { ...rest, messageSettlement: stored } : rest;
}

async function mintActionMessageSettlement({ db, delivery, deviceId }) {
  if (!isCommitTransaction(db) || !isMessageDelivery(delivery) || delivery.status !== "COMMITTING"
      || !delivery.writeCommitAt || !Number.isSafeInteger(delivery.writeCommitRevision) || delivery.writeCommitRevision < 1
      || delivery.claimedByDeviceId !== deviceId) {
    throw fail("ACTION_MESSAGE_SETTLEMENT_CONTEXT_REQUIRED", "Message receipt capability requires the committed send transaction", 500);
  }
  // A duplicate prepare response is never another physical-send permit. The
  // first grant is minted in the same transaction that crosses COMMITTING.
  if (object(delivery.result).messageSettlement) {
    throw fail("DELIVERY_ALREADY_COMMITTING", "Message send already has a committed receipt capability");
  }
  const settlementToken = crypto.randomBytes(32).toString("base64url");
  const messageSettlement = {
    version: 1, tokenHash: hash(settlementToken), deviceId,
    operationId: delivery.idempotencyKey || delivery.id,
    writeCommitRevision: delivery.writeCommitRevision,
  };
  const changed = await db.automationDelivery.updateMany({
    where: { id: delivery.id, status: "COMMITTING", claimedByDeviceId: deviceId, writeCommitRevision: delivery.writeCommitRevision },
    data: { result: { ...object(delivery.result), messageSettlement } },
  });
  if (!changed.count) throw fail("DELIVERY_COMMIT_PERMIT_STALE", "Send changed before its receipt capability was stored");
  return { messageSettlementVersion: 1, settlementToken };
}

// This capability only records the exact ACK of a previously admitted send. It
// cannot issue provider requests, reopen an execution lease, or mint new work.
// Logout, a lost lease, and creator/member retirement do not erase that ACK.
async function completeActionMessageWithSettlementToken(input, db = prisma) {
  const deliveryId = text(input.deliveryId), messageId = text(input.messageId);
  const deviceId = text(input.deviceId), operationId = text(input.operationId);
  const revision = Number(input.writeCommitRevision);
  const sentAt = typeof input.sentAt === "string" ? new Date(input.sentAt) : null;
  if (input.authorityVersion !== AUTHORITY_VERSION || !deliveryId || !messageId || messageId.length > 160
      || !deviceId || !operationId || !text(input.settlementToken) || !Number.isSafeInteger(revision) || revision < 1
      || !sentAt || !Number.isFinite(sentAt.getTime())) {
    throw fail("ACTION_MESSAGE_RECEIPT_INVALID", "Exact committed message response is required", 400);
  }
  return runDbTransaction(db, async (tx) => {
    const initial = await tx.automationDelivery.findUnique({ where: { id: deliveryId } });
    if (!initial) throw fail("ACTION_MESSAGE_SETTLEMENT_BINDING_INVALID", "Message receipt capability is invalid", 403);
    await lockAutomationWriteCommitFence({ db: tx, agencyId: initial.agencyId, creatorId: initial.creatorId });
    // Lease sweeps/worker completions also mutate this row. Lock before reading
    // so concurrent receipt replays finalize counters and cleanup exactly once.
    await tx.$queryRawUnsafe('SELECT "id" FROM "AutomationDelivery" WHERE "id"=$1 FOR UPDATE', deliveryId);
    const delivery = await tx.automationDelivery.findUnique({ where: { id: deliveryId } });
    const result = object(delivery?.result), grant = object(result.messageSettlement);
    if (!isMessageDelivery(delivery) || grant.version !== 1 || !tokenMatches(input.settlementToken, grant.tokenHash)
        || grant.deviceId !== deviceId || grant.operationId !== operationId
        || operationId !== (delivery.idempotencyKey || delivery.id) || grant.writeCommitRevision !== revision
        || delivery.writeCommitRevision !== revision || !delivery.writeCommitAt) {
      throw fail("ACTION_MESSAGE_SETTLEMENT_BINDING_INVALID", "Message receipt capability does not match this committed send", 403);
    }
    if (delivery.status === "COMPLETED") {
      if (delivery.messageId !== messageId) throw fail("ACTION_MESSAGE_SETTLEMENT_CONFLICT", "Send already has a different exact message response");
      return { ok: true, duplicate: true, deliveryId, messageId };
    }
    const unknown = delivery.failureCategory === "OUTCOME_UNKNOWN_RECONCILE"
      || ["RECONCILE_REQUIRED", "UNRESOLVED_DO_NOT_RETRY"].includes(result.outcomeState);
    if (delivery.status !== "COMMITTING" && delivery.status !== "RECONCILE_REQUIRED" && !unknown) {
      throw fail("ACTION_MESSAGE_NOT_SETTLEABLE", "Send is not awaiting a committed response");
    }
    if (delivery.messageId && delivery.messageId !== messageId) {
      throw fail("ACTION_MESSAGE_SETTLEMENT_CONFLICT", "Send already has a different exact message response");
    }
    const now = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
    const settledResult = {
      ...result, code: "message_sent", messageId, sentAt: sentAt.toISOString(),
      messageOwnership: { kind: "PROVIDER_SEND_ACK", operationId, messageId },
      outcomeState: "PROVEN_SUCCESS", exactResponseProof: true, completedAt: now.toISOString(),
    };
    const current = await tx.automationDelivery.update({ where: { id: deliveryId }, data: {
      status: "COMPLETED", messageId, sentAt, result: settledResult,
      failureCode: null, failureCategory: null, reportedFailureCategory: null, lastError: null,
      finishedAt: now, lastCheckedAt: now, claimUntil: null, leaseTokenHash: null,
      leaseRevision: { increment: 1 },
    } });
    const finalized = await finalizeBumpSend({ db: tx, delivery: current, result: settledResult });
    if (finalized) await tx.automationDelivery.update({ where: { id: deliveryId }, data: {
      messageId: finalized.messageId, sentAt: finalized.sentAt, cancelAt: finalized.cancelAt,
    } });
    return { ok: true, duplicate: false, deliveryId, messageId };
  }, { timeout: 30_000 });
}

module.exports = { AUTHORITY_VERSION, isMessageDelivery, preserveMessageSettlement, mintActionMessageSettlement, completeActionMessageWithSettlementToken };
