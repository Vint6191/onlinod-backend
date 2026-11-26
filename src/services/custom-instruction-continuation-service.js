"use strict";
// A legacy continuation is an explicitly reviewed new instruction. The old
// provider receipt remains historical evidence and is never rewritten.
const crypto = require("node:crypto");
const { canUsePermission } = require("./team-access-control");
const { buildInstructionManifest, readInstructionManifest, instructionDeliveryState } = require("./custom-instruction-manifest");
const { taskText } = require("./custom-order-reminders");
const { fenceCustomModelObligationTransition } = require("./custom-model-obligation-authority-service");
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const fail = (code, message, status = 409) => Object.assign(Error(message), { code: `CUSTOM_CONTINUATION_${code}`, status });
const iso = value => value ? new Date(value).toISOString() : null;

function sourceSnapshotHash(source) {
  return hash(JSON.stringify([1, source.id, source.agencyId, source.creatorId, source.customOrderId, source.customSubmissionId,
    source.kind, source.state, source.accountId, source.payloadFingerprint, hash(String(source.payload?.text || "")),
    source.remoteMessageId, source.remoteRecipientTelegramUserId]));
}
function sourceLooksIncomplete(source, order) {
  if (!source || source.instructionManifest || source.state !== "CONFIRMED") return false;
  const text = String(source.payload?.text || "");
  if (source.kind === "TASK") return text.length === 4096 && taskText(order).length > text.length;
  return source.kind === "REVISION_REQUEST" && Boolean(source.payload?.reviewComment)
    && !text.includes(String(source.payload.reviewComment));
}
async function currentLegacySource({ agencyId, order, sourceIntentId = null, db }) {
  if (!order || order.status !== "PENDING") throw fail("NOT_REQUIRED", "Only an active pending order can receive a reviewed continuation");
  const latest = order.type === "CONTENT" && db.customContentSubmission?.findFirst
    ? await db.customContentSubmission.findFirst({ where: { agencyId, creatorId: order.creatorId, customOrderId: order.id },
      orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }] }) : null;
  if (latest && latest.reviewStatus !== "REVISION_REQUESTED") throw fail("NOT_REQUIRED", "The model has already supplied a response to the current instruction");
  const kind = latest ? "REVISION_REQUEST" : "TASK";
  const source = await db.telegramDeliveryIntent.findFirst({ where: { agencyId, creatorId: order.creatorId, customOrderId: order.id, kind,
    ...(latest ? { customSubmissionId: latest.id } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!source || sourceIntentId && source.id !== sourceIntentId || source.instructionManifest || source.state !== "CONFIRMED"
      || !/^\d{1,20}$/.test(String(source.remoteMessageId)) || !/^\d{1,20}$/.test(String(source.remoteRecipientTelegramUserId))) {
    throw fail("SOURCE_CHANGED", "The current legacy provider-confirmed instruction no longer matches the reviewed source");
  }
  if (kind === "REVISION_REQUEST") {
    const decision = await require("./telegram-delivery-authority-service").loadRevisionRequestDecision({ agencyId, customSubmissionId: latest.id, customOrderId: order.id, db });
    if (source.payload?.reviewDecisionFingerprint !== decision.fingerprint) throw fail("SOURCE_CHANGED", "The revision decision changed after this legacy instruction");
  }
  return source;
}
function continuationKey(source) { return `custom-telegram:${source.agencyId}:${source.customOrderId}:INSTRUCTION_CONTINUATION:${source.id}`; }
async function existingContinuation(source, db) {
  return db.telegramDeliveryIntent.findUnique({ where: { logicalKey: continuationKey(source) } });
}
function reviewedFullText(source, order) {
  const body = source.kind === "TASK" ? taskText(order)
    : require("./telegram-delivery-authority-service").revisionRequestText({ revisionNumber: source.payload?.revisionNumber || null, reviewComment: source.payload.reviewComment });
  return `Дополнение: полная инструкция к ранее отправленному заданию.\n\n${body}`;
}
async function previewInstructionContinuation({ agencyId, member, orderId, sourceIntentId = null, db = null }) {
  const client = db || require("../prisma");
  const order = await require("./custom-orders-service").loadOwnedOrder({ agencyId, member, orderId, db: client });
  if (!(await canUsePermission({ member, key: "content.review_customs", db: client }))) throw fail("FORBIDDEN", "content.review_customs permission is required", 403);
  const source = await currentLegacySource({ agencyId, order, sourceIntentId, db: client });
  if (!sourceLooksIncomplete(source, order)) throw fail("NOT_REQUIRED", "This legacy instruction has no identifiable truncation candidate");
  const existing = await existingContinuation(source, client);
  const text = existing?.instructionManifest?.fullText || reviewedFullText(source, order);
  return { ok: true, creatorId: order.creatorId, orderId: order.id, sourceIntentId: source.id, sourceKind: source.kind,
    sourceSnapshotHash: sourceSnapshotHash(source), sourceText: String(source.payload.text), sourceMessageId: String(source.remoteMessageId),
    expectedOrderUpdatedAt: iso(order.updatedAt), reviewedText: text, reviewedTextHash: hash(text),
    parts: buildInstructionManifest(existing?.id || source.id, text).parts.length, existingIntentId: existing?.id || null };
}
async function assertContinuationCurrent({ row, order, db }) {
  const manifest = readInstructionManifest(row);
  if (row.kind !== "INSTRUCTION_CONTINUATION" || !manifest || !row.payload?.sourceIntentId
      || hash(manifest.fullText) !== row.payload.reviewedTextHash) throw fail("PAYLOAD_CHANGED", "The reviewed continuation content is not intact");
  const source = await currentLegacySource({ agencyId: row.agencyId, order, sourceIntentId: row.payload.sourceIntentId, db });
  if (sourceSnapshotHash(source) !== row.payload.sourceSnapshotHash || source.accountId !== row.accountId
      || String(source.remoteMessageId) !== String(row.payload.sourceRemoteMessageId)
      || source.remoteRecipientTelegramUserId !== row.payload.recipientTelegramUserId) {
    throw fail("SOURCE_CHANGED", "The exact historical provider source changed; continuation requires a fresh review");
  }
  const unknown = await db.telegramDeliveryIntent.findFirst({ where: { agencyId: row.agencyId, customOrderId: row.customOrderId,
    id: { not: row.id }, kind: { in: ["TASK", "REVISION_REQUEST", "INSTRUCTION_CONTINUATION", "INSTRUCTION_PART"] },
    state: { in: ["COMMITTING", "RECONCILE_REQUIRED"] } } });
  if (unknown) throw fail("OUTCOME_UNRESOLVED", "An instruction provider outcome must be reconciled before another physical send");
  return { source, accountId: source.accountId, replyToMessageId: String(source.remoteMessageId), recipientTelegramUserId: source.remoteRecipientTelegramUserId };
}
async function createInstructionContinuation({ agencyId, member, creatorId, input, now = new Date(), db }) {
  // Management command authority already owns Agency -> Creator -> Member. The
  // order fence serializes review creation with cancellation and model response.
  const fence = await fenceCustomModelObligationTransition({ agencyId, orderId: input.orderId, now, db });
  const order = await db.customOrder.findFirst({ where: { agencyId, id: input.orderId, creatorId }, include: { creator: true } });
  if (!order || fence.missing) throw fail("SOURCE_CHANGED", "The Custom order no longer exists");
  if (iso(fence.previousUpdatedAt) !== input.expectedOrderUpdatedAt) throw fail("ORDER_CHANGED", "The Custom order changed after review; reload the preview");
  const source = await currentLegacySource({ agencyId, order, sourceIntentId: input.sourceIntentId, db });
  if (typeof db.$queryRawUnsafe === "function") await db.$queryRawUnsafe('SELECT "id" FROM "TelegramDeliveryIntent" WHERE "agencyId"=$1 AND "id"=$2 FOR UPDATE', agencyId, source.id);
  const locked = await db.telegramDeliveryIntent.findFirst({ where: { agencyId, id: source.id } });
  if (!locked || sourceSnapshotHash(locked) !== input.expectedSourceSnapshotHash) throw fail("SOURCE_CHANGED", "The historical instruction changed after review");
  const existing = await existingContinuation(locked, db);
  if (existing) {
    if (existing.payload?.sourceSnapshotHash !== input.expectedSourceSnapshotHash || existing.instructionManifest?.fullText !== input.reviewedText
        || existing.payload?.reviewedTextHash !== input.reviewedTextHash) throw fail("PAYLOAD_CHANGED", "This source already has a different reviewed continuation");
    return continuationResult(existing);
  }
  if (!sourceLooksIncomplete(locked, order)) throw fail("NOT_REQUIRED", "The legacy instruction is not a truncation candidate");
  const text = reviewedFullText(locked, order);
  if (input.reviewedText !== text || input.reviewedTextHash !== hash(text) || input.instructionManifestVersion !== 1) throw fail("PAYLOAD_CHANGED", "Only the exact complete text shown in the current preview can be accepted");
  const unknown = await db.telegramDeliveryIntent.findFirst({ where: { agencyId, customOrderId: order.id,
    kind: { in: ["TASK", "REVISION_REQUEST", "INSTRUCTION_CONTINUATION", "INSTRUCTION_PART"] }, state: { in: ["COMMITTING", "RECONCILE_REQUIRED"] } } });
  if (unknown) throw fail("OUTCOME_UNRESOLVED", "An earlier instruction provider outcome is unresolved");
  const payload = { text, sourceIntentId: locked.id, sourceKind: locked.kind, sourceSnapshotHash: input.expectedSourceSnapshotHash,
    sourcePayloadFingerprint: locked.payloadFingerprint, sourceRemoteMessageId: String(locked.remoteMessageId),
    reviewedTextHash: hash(text), reviewedOrderUpdatedAt: input.expectedOrderUpdatedAt,
    replyToDeliveryId: locked.id, replyToMessageId: String(locked.remoteMessageId), recipientTelegramUserId: locked.remoteRecipientTelegramUserId,
    sourceDecisionFingerprint: locked.payload?.reviewDecisionFingerprint || null };
  const reserved = await require("./telegram-delivery-authority-service").createReviewedContinuationIntent({ agencyId, order, source: locked, payload, now, db });
  return continuationResult(reserved);
}
function continuationResult(row) {
  const manifest = readInstructionManifest(row);
  return { ok: true, creatorId: row.creatorId, orderId: row.customOrderId, sourceIntentId: row.payload.sourceIntentId,
    intentId: row.id, contentHash: manifest.contentHash, parts: manifest.parts.length };
}
async function readInstructionContinuationResult({ agencyId, creatorId, intentId, db }) {
  const row = await db.telegramDeliveryIntent.findFirst({ where: { agencyId, creatorId, id: intentId, kind: "INSTRUCTION_CONTINUATION" } });
  return row ? continuationResult(row) : null;
}
module.exports = { sourceSnapshotHash, sourceLooksIncomplete, currentLegacySource, previewInstructionContinuation,
  createInstructionContinuation, readInstructionContinuationResult, assertContinuationCurrent, continuationResult };
