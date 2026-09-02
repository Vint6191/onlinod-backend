"use strict";

const crypto = require("node:crypto");
const { audit } = require("./audit-service");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const { syncFinalizedSubmissionAssignment } = require("./custom-content-library-service");

const MAX_TELEGRAM_MESSAGES = 50;
const MAX_COMMENT = 4_000;
const MAX_OF_MEDIA_IDS = 200;
const MAX_TELEGRAM_MESSAGE_ID = 2_147_483_647;
const MAX_UPLOAD_WORK = 3;
const MAX_RUNTIME_LEASES = 100;
const REVIEW_WAITING = "WAITING_REVIEW";
const REVIEW_REVISION = "REVISION_REQUESTED";
const REVIEW_APPROVED = "APPROVED";

function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function identifier(value, field, { optional = false, max = 180 } = {}) {
  const text = String(value == null ? "" : value).trim();
  if (!text && optional) return null;
  if (!text) throw fail(`CUSTOM_SUBMISSION_${field.toUpperCase()}_REQUIRED`, `${field} is required`);
  if (text.length > max) throw fail(`CUSTOM_SUBMISSION_${field.toUpperCase()}_TOO_LONG`, `${field} is too long`);
  return text;
}

function commentText(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return null;
  if (text.length > MAX_COMMENT) throw fail("CUSTOM_SUBMISSION_COMMENT_TOO_LONG", `comment is too long (max ${MAX_COMMENT} characters)`);
  return text;
}

function telegramMessageIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail("CUSTOM_SUBMISSION_TELEGRAM_MESSAGES_REQUIRED", "telegramMessageIds must contain at least one message id");
  }
  if (value.length > MAX_TELEGRAM_MESSAGES) {
    throw fail("CUSTOM_SUBMISSION_TELEGRAM_MESSAGES_TOO_MANY", `telegramMessageIds supports at most ${MAX_TELEGRAM_MESSAGES} ids`);
  }
  const seen = new Set();
  const result = [];
  for (const raw of value) {
    const number = Number(raw);
    if (!Number.isInteger(number) || number <= 0 || number > MAX_TELEGRAM_MESSAGE_ID) {
      throw fail("CUSTOM_SUBMISSION_TELEGRAM_MESSAGE_INVALID", "telegramMessageIds must contain positive Telegram message ids");
    }
    if (seen.has(number)) continue;
    seen.add(number);
    result.push(number);
  }
  if (!result.length) throw fail("CUSTOM_SUBMISSION_TELEGRAM_MESSAGES_REQUIRED", "telegramMessageIds must contain at least one message id");
  return result;
}

function ofMediaIds(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const raw of value.slice(0, MAX_OF_MEDIA_IDS)) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function ofMediaId(value) {
  const text = String(value == null ? "" : value).trim();
  if (!/^[1-9]\d{0,39}$/.test(text)) {
    throw fail("CUSTOM_SUBMISSION_OF_MEDIA_ID_INVALID", "ofMediaId must be a positive OnlyFans media id");
  }
  return text;
}

function runtimeLeaseInputs(value) {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const item of raw.slice(0, MAX_RUNTIME_LEASES)) {
    const accountId = String(item?.accountId || "").trim();
    const claimToken = String(item?.claimToken || "").trim();
    if (!accountId || !claimToken || seen.has(accountId)) continue;
    seen.add(accountId);
    result.push({ accountId, claimToken });
  }
  return result;
}

function uploadWorkLimit(value) {
  return Math.max(1, Math.min(MAX_UPLOAD_WORK, Math.floor(Number(value) || 1)));
}

function vaultUploadRecipient(value) {
  const text = String(value == null ? "" : value).trim().replace(/^@+/, "");
  return /^(?:[A-Za-z0-9_]{3,64}|[1-9]\d{0,39})$/.test(text) ? text : "";
}

function nextUploadIndex(row) {
  const telegramIds = Array.isArray(row?.telegramMessageIds) ? row.telegramMessageIds : [];
  const mediaIds = ofMediaIds(row?.ofMediaIds);
  if (mediaIds.length > telegramIds.length) return null;
  return mediaIds.length < telegramIds.length ? mediaIds.length : null;
}

function receivedAt(value, now = new Date()) {
  if (value === undefined || value === null || value === "") return new Date(now);
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw fail("CUSTOM_SUBMISSION_RECEIVED_AT_INVALID", "receivedAt must be a valid date-time");
  return date;
}

function sameMessageIds(a, b) {
  const left = Array.from(new Set((Array.isArray(a) ? a : []).map(Number))).sort((x, y) => x - y);
  const right = Array.from(new Set((Array.isArray(b) ? b : []).map(Number))).sort((x, y) => x - y);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deterministicSubmissionId(agencyId, creatorId, messageIds) {
  const canonical = Array.from(new Set(messageIds.map(Number))).sort((a, b) => a - b).join(",");
  const digest = crypto.createHash("sha256").update(`${agencyId}\n${creatorId}\n${canonical}`).digest("hex");
  return `cs_${digest}`;
}

function serializeSubmission(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    creatorId: String(row.creatorId),
    customOrderId: row.customOrderId == null ? null : String(row.customOrderId),
    telegramMessageIds: Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds.map(String) : [],
    ofMediaIds: ofMediaIds(row.ofMediaIds),
    comment: row.comment || null,
    reviewStatus: String(row.reviewStatus || "WAITING_REVIEW"),
    reviewComment: row.reviewComment || null,
    reviewedByMemberId: row.reviewedByMemberId == null ? null : String(row.reviewedByMemberId),
    reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null,
    receivedAt: new Date(row.receivedAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

async function validateContentOrder({ agencyId, creatorId, customOrderId, db }) {
  if (!customOrderId) return null;
  const row = await db.customOrder.findFirst({
    where: { id: customOrderId, agencyId, creatorId },
    select: { id: true, type: true, status: true, fanDeliveredAt: true },
  });
  if (!row) throw fail("CUSTOM_SUBMISSION_ORDER_NOT_FOUND", "Custom order was not found for this creator", 404);
  if (String(row.type || "CONTENT").toUpperCase() !== "CONTENT") {
    throw fail("CUSTOM_SUBMISSION_ORDER_TYPE_INVALID", "Only CONTENT custom orders can have content submissions", 409);
  }
  if (String(row.status || "PENDING").toUpperCase() !== "PENDING" || row.fanDeliveredAt) {
    throw fail("CUSTOM_SUBMISSION_ORDER_CLOSED", "Completed, delivered, missed or cancelled custom orders cannot receive new content submissions", 409);
  }
  return row;
}

async function validateSubmissionLifecycleTarget({ agencyId, creatorId, customOrderId, excludeSubmissionId = null, db }) {
  if (!customOrderId) return;
  const exclude = excludeSubmissionId ? { id: { not: excludeSubmissionId } } : {};
  const approved = await db.customContentSubmission.findFirst({
    where: { agencyId, creatorId, customOrderId, reviewStatus: REVIEW_APPROVED, ...exclude },
    select: { id: true },
  });
  if (approved) {
    throw fail("CUSTOM_SUBMISSION_ORDER_ALREADY_APPROVED", "This custom order already has an approved content submission", 409);
  }
  const latest = await db.customContentSubmission.findFirst({
    where: { agencyId, creatorId, customOrderId, ...exclude },
    select: { id: true, reviewStatus: true },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  if (!latest) return;
  if (String(latest.reviewStatus || REVIEW_WAITING) !== REVIEW_REVISION) {
    throw fail("CUSTOM_SUBMISSION_ORDER_BUSY", "This custom order already has an active content submission awaiting manager review", 409);
  }
}

async function createCustomContentSubmission({ agencyId, member, input = {}, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const creatorId = identifier(input.creatorId, "creatorId", { max: 100 });
  const customOrderId = identifier(input.customOrderId, "customOrderId", { optional: true, max: 180 });
  const messageIds = telegramMessageIds(input.telegramMessageIds);
  const comment = commentText(input.comment);
  const observedAt = receivedAt(input.receivedAt, now);

  await requireCreatorAccess({ agencyId, member, creatorId, db: client });
  await validateContentOrder({ agencyId, creatorId, customOrderId, db: client });
  const submissionId = deterministicSubmissionId(agencyId, creatorId, messageIds);

  const overlapping = await client.customContentSubmission.findFirst({
    where: { agencyId, creatorId, telegramMessageIds: { hasSome: messageIds } },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
  });
  if (overlapping) {
    if (sameMessageIds(overlapping.telegramMessageIds, messageIds)) {
      return { ok: true, deduped: true, submission: serializeSubmission(overlapping) };
    }
    throw fail("CUSTOM_SUBMISSION_TELEGRAM_MESSAGE_CONFLICT", "One or more Telegram messages already belong to another submission", 409);
  }
  await validateSubmissionLifecycleTarget({ agencyId, creatorId, customOrderId, db: client });

  let row;
  try {
    row = await client.customContentSubmission.create({
      data: {
        id: submissionId,
        agencyId,
        creatorId,
        customOrderId,
        telegramMessageIds: messageIds,
        ofMediaIds: [],
        comment,
        receivedAt: observedAt,
      },
    });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    const raced = await client.customContentSubmission.findFirst({ where: { id: submissionId, agencyId, creatorId } });
    if (raced && sameMessageIds(raced.telegramMessageIds, messageIds)) {
      return { ok: true, deduped: true, submission: serializeSubmission(raced) };
    }
    throw fail("CUSTOM_SUBMISSION_ORDER_BUSY", "Another content submission is already awaiting manager review for this custom order", 409);
  }
  await audit({
    agencyId,
    actorUserId: member.userId || null,
    action: "custom_content_submission.create",
    targetType: "CustomContentSubmission",
    targetId: row.id,
    metadata: { creatorId, customOrderId, telegramMessageCount: messageIds.length },
    db: client,
  });
  return { ok: true, deduped: false, submission: serializeSubmission(row) };
}

async function listCustomContentSubmissions({ agencyId, member, creatorId, customOrderId = undefined, unassigned = false, limit = 100, offset = 0, db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedCreatorId = identifier(creatorId, "creatorId", { max: 100 });
  await requireCreatorAccess({ agencyId, member, creatorId: normalizedCreatorId, db: client });
  const normalizedOrderId = customOrderId === undefined ? undefined : identifier(customOrderId, "customOrderId", { optional: true, max: 180 });
  if (normalizedOrderId) await validateContentOrder({ agencyId, creatorId: normalizedCreatorId, customOrderId: normalizedOrderId, db: client });
  const take = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
  const skip = Math.max(0, Math.floor(Number(offset) || 0));
  const where = {
    agencyId,
    creatorId: normalizedCreatorId,
    ...(unassigned === true ? { customOrderId: null } : normalizedOrderId !== undefined ? { customOrderId: normalizedOrderId } : {}),
  };
  const [rows, count] = await Promise.all([
    client.customContentSubmission.findMany({ where, orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }], take, skip }),
    client.customContentSubmission.count({ where }),
  ]);
  return { ok: true, items: rows.map(serializeSubmission), count, nextOffset: skip + rows.length, hasMore: skip + rows.length < count };
}

async function assignCustomContentSubmission({ agencyId, member, submissionId, customOrderId, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedSubmissionId = identifier(submissionId, "submissionId", { max: 180 });
  const row = await client.customContentSubmission.findFirst({ where: { id: normalizedSubmissionId, agencyId } });
  if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  const normalizedOrderId = identifier(customOrderId, "customOrderId", { optional: true, max: 180 });
  await validateContentOrder({ agencyId, creatorId: row.creatorId, customOrderId: normalizedOrderId, db: client });
  if ((row.customOrderId || null) === normalizedOrderId) {
    return { ok: true, unchanged: true, submission: serializeSubmission(row) };
  }
  if (String(row.reviewStatus || REVIEW_WAITING) !== REVIEW_WAITING) {
    throw fail("CUSTOM_SUBMISSION_REVIEW_LOCKED", "Reviewed submissions cannot be reassigned", 409);
  }
  await validateSubmissionLifecycleTarget({ agencyId, creatorId: row.creatorId, customOrderId: normalizedOrderId, excludeSubmissionId: row.id, db: client });
  let updated;
  try {
    updated = await client.customContentSubmission.update({ where: { id: row.id }, data: { customOrderId: normalizedOrderId } });
  } catch (error) {
    if (error?.code === "P2002") {
      throw fail("CUSTOM_SUBMISSION_ORDER_BUSY", "Another content submission is already awaiting manager review for this custom order", 409);
    }
    throw error;
  }
  await audit({
    agencyId,
    actorUserId: member.userId || null,
    action: "custom_content_submission.assign",
    targetType: "CustomContentSubmission",
    targetId: row.id,
    metadata: { creatorId: row.creatorId, fromCustomOrderId: row.customOrderId || null, toCustomOrderId: normalizedOrderId },
    db: client,
  });
  if (Array.isArray(updated.telegramMessageIds) && updated.telegramMessageIds.length > 0
      && ofMediaIds(updated.ofMediaIds).length === updated.telegramMessageIds.length) {
    // Best-effort immediate provenance refresh for already-finalized submissions.
    // If it cannot run now, pendingFinalizeRows notices the mismatch and the
    // existing Desktop execution loop heals it without losing the assignment.
    await syncFinalizedSubmissionAssignment({ agencyId, member, submissionId: updated.id, now, db: client }).catch(() => undefined);
  }
  return { ok: true, unchanged: false, submission: serializeSubmission(updated) };
}

async function pendingUploadRows({ agencyId, creatorIds, limit, db }) {
  const ids = Array.from(new Set((Array.isArray(creatorIds) ? creatorIds : []).map(String).filter(Boolean)));
  if (!ids.length) return [];
  const take = Math.max(limit, Math.min(50, limit * 4));
  if (typeof db.$queryRawUnsafe === "function") {
    const placeholders = ids.map((_, index) => `$${index + 2}`).join(",");
    return db.$queryRawUnsafe(
      `SELECT "id", "agencyId", "creatorId", "customOrderId", "telegramMessageIds", "ofMediaIds", "comment", "receivedAt", "createdAt", "updatedAt"
       FROM "CustomContentSubmission"
       WHERE "agencyId" = $1
         AND "creatorId" IN (${placeholders})
         AND cardinality("ofMediaIds") < cardinality("telegramMessageIds")
       ORDER BY "receivedAt" ASC, "createdAt" ASC
       LIMIT ${take}`,
      agencyId,
      ...ids,
    );
  }
  const rows = await db.customContentSubmission.findMany({
    where: { agencyId, creatorId: { in: ids } },
    orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }],
    take: Math.max(200, take * 20),
    skip: 0,
  });
  return rows.filter((row) => nextUploadIndex(row) !== null).slice(0, take);
}


async function pendingFinalizeRows({ agencyId, creatorIds, limit, db }) {
  const ids = Array.from(new Set((Array.isArray(creatorIds) ? creatorIds : []).map(String).filter(Boolean)));
  if (!ids.length) return [];
  const take = Math.max(limit, Math.min(50, limit * 4));
  if (typeof db.$queryRawUnsafe === "function") {
    const placeholders = ids.map((_, index) => `$${index + 2}`).join(",");
    return db.$queryRawUnsafe(
      `SELECT submission."id", submission."agencyId", submission."creatorId", submission."customOrderId",
              submission."telegramMessageIds", submission."ofMediaIds", submission."comment",
              submission."receivedAt", submission."createdAt", submission."updatedAt"
       FROM "CustomContentSubmission" AS submission
       LEFT JOIN "CustomOrder" AS custom_order ON custom_order."id" = submission."customOrderId"
       WHERE submission."agencyId" = $1
         AND submission."creatorId" IN (${placeholders})
         AND cardinality(submission."telegramMessageIds") > 0
         AND cardinality(submission."ofMediaIds") = cardinality(submission."telegramMessageIds")
         AND EXISTS (
           SELECT 1
           FROM unnest(submission."ofMediaIds") AS media_id
           WHERE NOT EXISTS (
             SELECT 1
             FROM "CreatorMediaAsset" AS asset
             WHERE asset."agencyId" = submission."agencyId"
               AND asset."creatorId" = submission."creatorId"
               AND asset."mediaId" = media_id
               AND asset."source" = 'CUSTOM'
               AND asset."customSubmissionId" = submission."id"
               AND asset."customOrderId" IS NOT DISTINCT FROM submission."customOrderId"
               AND (
                 (submission."customOrderId" IS NULL AND asset."customFullPriceCents" IS NULL)
                 OR
                 (submission."customOrderId" IS NOT NULL AND asset."customFullPriceCents" = custom_order."priceCents")
               )
           )
         )
       ORDER BY submission."receivedAt" ASC, submission."createdAt" ASC
       LIMIT ${take}`,
      agencyId,
      ...ids,
    );
  }

  const candidates = await db.customContentSubmission.findMany({
    where: { agencyId, creatorId: { in: ids } },
    orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }],
    take: Math.max(200, take * 20),
    skip: 0,
  });
  const out = [];
  for (const row of candidates) {
    const telegramIds = Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds : [];
    const mediaIds = ofMediaIds(row.ofMediaIds);
    if (!telegramIds.length || mediaIds.length !== telegramIds.length) continue;
    let priceCents = null;
    if (row.customOrderId) {
      const order = await db.customOrder.findFirst({ where: { id: row.customOrderId, agencyId, creatorId: row.creatorId }, select: { priceCents: true } });
      priceCents = order ? Math.max(0, Math.round(Number(order.priceCents) || 0)) : null;
    }
    const assets = await db.creatorMediaAsset.findMany({
      where: { agencyId, creatorId: row.creatorId, mediaId: { in: mediaIds }, source: "CUSTOM" },
      take: mediaIds.length,
    });
    const byMediaId = new Map(assets.map((asset) => [String(asset.mediaId), asset]));
    const finalized = mediaIds.every((mediaId) => {
      const asset = byMediaId.get(mediaId);
      if (!asset) return false;
      if ((asset.customSubmissionId || null) !== String(row.id || "")) return false;
      if ((asset.customOrderId || null) !== (row.customOrderId || null)) return false;
      return row.customOrderId
        ? Number(asset.customFullPriceCents) === priceCents
        : asset.customFullPriceCents == null;
    });
    if (!finalized) out.push(row);
    if (out.length >= take) break;
  }
  return out;
}

/**
 * Return upload work only for Telegram accounts whose existing runtime lease is
 * currently owned by this Desktop. The submission row itself stays compact:
 * no extra claim/status/device fields are persisted for upload execution.
 */

async function reserveCustomContentSubmissionRelayWrite({ agencyId, member, deviceId, submissionId, expectedIndex, accessEpoch = null, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id || !member?.userId) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedDeviceId = identifier(deviceId, "deviceId", { max: 180 });
  const id = identifier(submissionId, "submissionId", { max: 180 });
  const index = Number(expectedIndex);
  if (!Number.isInteger(index) || index < 0) throw fail("CUSTOM_SUBMISSION_UPLOAD_INDEX_INVALID", "expectedIndex must be a non-negative integer", 400);
  const row = await client.customContentSubmission.findFirst({ where: { id, agencyId } });
  if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  const nextIndex = nextUploadIndex(row);
  if (nextIndex === null) throw fail("CUSTOM_SUBMISSION_UPLOAD_ALREADY_COMPLETE", "Content submission already has all OnlyFans media ids", 409);
  if (nextIndex !== index) throw fail("CUSTOM_SUBMISSION_UPLOAD_WORK_STALE", `Expected upload index ${nextIndex}, not ${index}`, 409);
  const telegramIds = Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds.map(String) : [];
  const telegramMessageId = String(telegramIds[index] || "").trim();
  if (!telegramMessageId) throw fail("CUSTOM_SUBMISSION_TELEGRAM_MESSAGE_MISSING", "Submission upload index has no Telegram source message", 409);
  const recipientRow = await client.workspaceSetting.findUnique({ where: { agencyId_key: { agencyId, key: "vaultUploadRecipient" } }, select: { value: true } }).catch(() => null);
  const recipient = String(recipientRow?.value || "").trim().replace(/^@+/, "");
  if (!recipient) throw fail("CUSTOM_SUBMISSION_VAULT_RECIPIENT_REQUIRED", "Vault upload recipient is not configured", 409);
  const payloadFingerprint = crypto.createHash("sha256").update(JSON.stringify({
    version: 1, agencyId, creatorId: String(row.creatorId), submissionId: id, expectedIndex: index, telegramMessageId, recipient,
  })).digest("hex");
  const { reserveProgrammaticWrite } = require("./programmatic-of-write-authority-service");
  const authority = await reserveProgrammaticWrite({
    agencyId,
    userId: String(member.userId),
    memberId: String(member.id),
    accessEpoch: Number.isInteger(Number(accessEpoch)) ? Number(accessEpoch) : Number(member.accessEpoch || 0),
    creatorId: String(row.creatorId),
    deviceId: normalizedDeviceId,
    kind: "CUSTOM_RELAY_SEND",
    idempotencyKey: `custom-relay:${id}:${index}`,
    payloadFingerprint,
    payload: { submissionId: id, expectedIndex: index, telegramMessageId, recipient, reservedForCustomUploadAt: new Date(now).toISOString() },
    targetId: `${id}:${index}`,
    permissionKeyOverride: null,
    leaseMs: 10 * 60_000,
    maxAttempts: 20,
  });
  return { ...authority, relayRecipient: recipient, submissionId: id, expectedIndex: index };
}


async function closeCustomContentSubmissionRelayWriteUnresolved({ agencyId, member, deviceId, submissionId, expectedIndex, writeId, leaseToken, leaseRevision, accessEpoch = null, reason = null, db = null } = {}) {
  if (!agencyId || !member?.id || !member?.userId) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedDeviceId = identifier(deviceId, "deviceId", { max: 180 });
  const id = identifier(submissionId, "submissionId", { max: 180 });
  const normalizedWriteId = identifier(writeId, "writeId", { max: 180 });
  const index = Number(expectedIndex);
  if (!Number.isInteger(index) || index < 0) throw fail("CUSTOM_SUBMISSION_UPLOAD_INDEX_INVALID", "expectedIndex must be a non-negative integer", 400);
  const row = await client.customContentSubmission.findFirst({ where: { id, agencyId } });
  if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  const { closeProgrammaticWriteUnresolved } = require("./programmatic-of-write-authority-service");
  return closeProgrammaticWriteUnresolved({
    agencyId,
    userId: String(member.userId),
    memberId: String(member.id),
    accessEpoch: Number.isInteger(Number(accessEpoch)) ? Number(accessEpoch) : Number(member.accessEpoch || 0),
    creatorId: String(row.creatorId),
    deviceId: normalizedDeviceId,
    writeId: normalizedWriteId,
    leaseToken: identifier(leaseToken, "leaseToken", { max: 500 }),
    leaseRevision: Number(leaseRevision),
    kind: "CUSTOM_RELAY_SEND",
    permissionKey: null,
    reason,
    expectedIdempotencyKey: `custom-relay:${id}:${index}`,
  });
}

async function resolveCustomContentSubmissionRelayWriteMatched({ agencyId, member, deviceId, submissionId, expectedIndex, writeId, mediaId, messageId = null, accessEpoch = null, db = null } = {}) {
  if (!agencyId || !member?.id || !member?.userId) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedDeviceId = identifier(deviceId, "deviceId", { max: 180 });
  const id = identifier(submissionId, "submissionId", { max: 180 });
  const normalizedWriteId = identifier(writeId, "writeId", { max: 180 });
  const normalizedMediaId = identifier(mediaId, "mediaId", { max: 180 });
  const index = Number(expectedIndex);
  if (!Number.isInteger(index) || index < 0) throw fail("CUSTOM_SUBMISSION_UPLOAD_INDEX_INVALID", "expectedIndex must be a non-negative integer", 400);
  const row = await client.customContentSubmission.findFirst({ where: { id, agencyId } });
  if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  const { resolveProgrammaticWriteUnresolvedMatched } = require("./programmatic-of-write-authority-service");
  return resolveProgrammaticWriteUnresolvedMatched({
    agencyId, userId: String(member.userId), memberId: String(member.id),
    accessEpoch: Number.isInteger(Number(accessEpoch)) ? Number(accessEpoch) : Number(member.accessEpoch || 0),
    creatorId: String(row.creatorId), deviceId: normalizedDeviceId, writeId: normalizedWriteId,
    kind: "CUSTOM_RELAY_SEND", permissionKey: null,
    result: { mediaId: normalizedMediaId, ...(messageId ? { messageId: identifier(messageId, "messageId", { max: 180 }) } : {}) },
    expectedIdempotencyKey: `custom-relay:${id}:${index}`,
  });
}

async function claimCustomContentSubmissionUploadWork({ agencyId, member, deviceId, leases, limit = 1, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedDeviceId = identifier(deviceId, "deviceId", { max: 180 });
  const requestedLeases = runtimeLeaseInputs(leases);
  const take = uploadWorkLimit(limit);
  if (!requestedLeases.length) return { ok: true, items: [], blocked: null, serverNow: new Date(now).toISOString() };

  const requestedByAccount = new Map(requestedLeases.map((row) => [row.accountId, row.claimToken]));
  const [scope, leasedRows, accountRows, recipientRow] = await Promise.all([
    allowedCreatorScope({ agencyId, member, db: client }),
    client.agencyTelegramMtprotoAccount.findMany({
      where: {
        agencyId,
        id: { in: [...requestedByAccount.keys()] },
        runtimeClaimedByDeviceId: normalizedDeviceId,
        runtimeClaimUntil: { gt: now },
      },
      select: {
        id: true,
        runtimeClaimToken: true,
        runtimeLeaseUserId: true,
        runtimeLeaseMemberId: true,
        runtimeLeaseAccessEpoch: true,
        runtimeLeaseCreatorId: true,
      },
      take: MAX_RUNTIME_LEASES,
    }),
    client.agencyTelegramMtprotoAccount.findMany({ where: { agencyId }, select: { id: true }, orderBy: { id: "asc" }, take: 2 }),
    client.workspaceSetting.findUnique({ where: { agencyId_key: { agencyId, key: "vaultUploadRecipient" } }, select: { value: true } }).catch(() => null),
  ]);
  const currentUserId = String(member.userId || "");
  const currentMemberId = String(member.id || "");
  const currentAccessEpoch = Number(member.accessEpoch);
  const scopedCreatorIds = new Set(scope.creatorIds || []);
  const validAccountIds = new Set(
    leasedRows
      .filter((row) => {
        const anchorCreatorId = String(row.runtimeLeaseCreatorId || "");
        return requestedByAccount.get(String(row.id)) === String(row.runtimeClaimToken || "")
          && String(row.runtimeLeaseUserId || "") === currentUserId
          && String(row.runtimeLeaseMemberId || "") === currentMemberId
          && Number.isInteger(currentAccessEpoch)
          && Number(row.runtimeLeaseAccessEpoch) === currentAccessEpoch
          && Boolean(anchorCreatorId)
          && (scope.broad || scopedCreatorIds.has(anchorCreatorId));
      })
      .map((row) => String(row.id)),
  );
  if (!validAccountIds.size) return { ok: true, items: [], blocked: null, serverNow: new Date(now).toISOString() };

  /* The upload queue borrows the Telegram runtime lease rather than creating a
     second claim generation. Treat every actor field on that lease as
     authority: a stale member/accessEpoch/creator anchor cannot expose new OF
     upload work even while device/token/TTL still match. */

  const recipient = vaultUploadRecipient(recipientRow?.value);
  if (!recipient) {
    return {
      ok: true,
      items: [],
      blocked: { code: "CUSTOM_SUBMISSION_VAULT_RELAY_REQUIRED", message: "Set Vault upload relay in Settings → Workspace." },
      serverNow: new Date(now).toISOString(),
    };
  }

  const singleAccountId = accountRows.length === 1 ? String(accountRows[0].id) : null;
  const singleAccountOwned = Boolean(singleAccountId && validAccountIds.has(singleAccountId));
  const creatorWhere = {
    agencyId,
    deletedAt: null,
    telegramContact: { not: null },
    customsVaultFolderId: { not: null },
    ...(scope.broad ? {} : { id: { in: scope.creatorIds.length ? scope.creatorIds : ["__none__"] } }),
    ...(singleAccountOwned ? {} : { telegramAccountId: { in: [...validAccountIds] } }),
  };
  const creators = await client.creatorAccount.findMany({
    where: creatorWhere,
    select: { id: true, username: true, telegramAccountId: true, customsVaultFolderId: true },
    take: 10_000,
  });
  if (!creators.length) return { ok: true, items: [], blocked: null, serverNow: new Date(now).toISOString() };

  const creatorById = new Map();
  for (const creator of creators) {
    const accountId = singleAccountOwned ? singleAccountId : String(creator.telegramAccountId || "").trim();
    if (!accountId || !validAccountIds.has(accountId)) continue;
    creatorById.set(String(creator.id), { ...creator, accountId });
  }
  if (!creatorById.size) return { ok: true, items: [], blocked: null, serverNow: new Date(now).toISOString() };

  const uploadRows = await pendingUploadRows({ agencyId, creatorIds: [...creatorById.keys()], limit: take, db: client });
  const items = [];
  for (const row of uploadRows) {
    if (items.length >= take) break;
    const creator = creatorById.get(String(row.creatorId));
    const index = nextUploadIndex(row);
    if (!creator || index === null) continue;
    const messageId = Number(row.telegramMessageIds?.[index]);
    if (!Number.isInteger(messageId) || messageId <= 0) continue;
    items.push({
      kind: "UPLOAD_MEDIA",
      submission: serializeSubmission(row),
      creatorId: String(row.creatorId),
      accountId: creator.accountId,
      creatorUsername: creator.username || null,
      folderId: String(creator.customsVaultFolderId),
      recipient,
      expectedIndex: index,
      telegramMessageId: String(messageId),
    });
  }

  if (items.length < take) {
    const finalizeRows = await pendingFinalizeRows({ agencyId, creatorIds: [...creatorById.keys()], limit: take - items.length, db: client });
    for (const row of finalizeRows) {
      if (items.length >= take) break;
      const creator = creatorById.get(String(row.creatorId));
      if (!creator) continue;
      items.push({
        kind: "FINALIZE_LIBRARY",
        submission: serializeSubmission(row),
        creatorId: String(row.creatorId),
        accountId: creator.accountId,
        creatorUsername: creator.username || null,
        folderId: String(creator.customsVaultFolderId),
        recipient,
        expectedIndex: null,
        telegramMessageId: null,
      });
    }
  }
  return { ok: true, items, blocked: null, serverNow: new Date(now).toISOString() };
}

async function commitCustomContentSubmissionMedia({ agencyId, member, submissionId, expectedIndex, mediaId, db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_SUBMISSION_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const normalizedSubmissionId = identifier(submissionId, "submissionId", { max: 180 });
  const index = Number(expectedIndex);
  if (!Number.isInteger(index) || index < 0 || index >= MAX_TELEGRAM_MESSAGES) {
    throw fail("CUSTOM_SUBMISSION_MEDIA_INDEX_INVALID", "expectedIndex must be a valid zero-based Telegram media index");
  }
  const normalizedMediaId = ofMediaId(mediaId);
  const row = await client.customContentSubmission.findFirst({ where: { id: normalizedSubmissionId, agencyId } });
  if (!row) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission was not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  const telegramIds = Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds : [];
  const current = ofMediaIds(row.ofMediaIds);
  if (current.length > telegramIds.length) throw fail("CUSTOM_SUBMISSION_MEDIA_STATE_INVALID", "Submission has more OnlyFans media ids than Telegram source messages", 409);
  if (index >= telegramIds.length) throw fail("CUSTOM_SUBMISSION_MEDIA_INDEX_INVALID", "expectedIndex is outside this submission", 409);
  if (index < current.length) {
    if (current[index] === normalizedMediaId) {
      return { ok: true, idempotent: true, completed: current.length === telegramIds.length, submission: serializeSubmission(row) };
    }
    throw fail("CUSTOM_SUBMISSION_MEDIA_COMMIT_CONFLICT", "This submission position is already committed to a different OnlyFans media id", 409);
  }
  if (index !== current.length) {
    throw fail("CUSTOM_SUBMISSION_MEDIA_COMMIT_OUT_OF_ORDER", "OnlyFans media ids must be committed in Telegram message order", 409);
  }
  if (current.includes(normalizedMediaId)) {
    throw fail("CUSTOM_SUBMISSION_MEDIA_ID_DUPLICATE", "This OnlyFans media id is already committed to another position in the submission", 409);
  }
  const next = [...current, normalizedMediaId];
  const changed = await client.customContentSubmission.updateMany({
    where: { id: row.id, agencyId, updatedAt: row.updatedAt },
    data: { ofMediaIds: next },
  });
  if (Number(changed?.count || 0) !== 1) {
    const raced = await client.customContentSubmission.findFirst({ where: { id: row.id, agencyId } });
    const racedIds = ofMediaIds(raced?.ofMediaIds);
    if (raced && racedIds[index] === normalizedMediaId) {
      return { ok: true, idempotent: true, completed: racedIds.length === telegramIds.length, submission: serializeSubmission(raced) };
    }
    throw fail("CUSTOM_SUBMISSION_MEDIA_COMMIT_CONFLICT", "Submission changed while the OnlyFans media id was being committed", 409);
  }
  const updated = await client.customContentSubmission.findFirst({ where: { id: row.id, agencyId } });
  if (!updated) throw fail("CUSTOM_SUBMISSION_NOT_FOUND", "Content submission disappeared after media commit", 404);
  const completed = ofMediaIds(updated.ofMediaIds).length === telegramIds.length;
  if (completed) {
    await audit({
      agencyId,
      actorUserId: member.userId || null,
      action: "custom_content_submission.of_upload_complete",
      targetType: "CustomContentSubmission",
      targetId: updated.id,
      metadata: { creatorId: updated.creatorId, customOrderId: updated.customOrderId || null, mediaCount: telegramIds.length },
      db: client,
    });
  }
  return { ok: true, idempotent: false, completed, submission: serializeSubmission(updated) };
}

module.exports = {
  MAX_TELEGRAM_MESSAGES,
  assignCustomContentSubmission,
  claimCustomContentSubmissionUploadWork,
  commitCustomContentSubmissionMedia,
  createCustomContentSubmission,
  deterministicSubmissionId,
  listCustomContentSubmissions,
  nextUploadIndex,
  pendingFinalizeRows,
  reserveCustomContentSubmissionRelayWrite,
  closeCustomContentSubmissionRelayWriteUnresolved,
  resolveCustomContentSubmissionRelayWriteMatched,
  sameMessageIds,
  serializeSubmission,
  telegramMessageIds,
};
