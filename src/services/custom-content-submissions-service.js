"use strict";

const crypto = require("node:crypto");
const { audit } = require("./audit-service");
const { requireCreatorAccess } = require("../middleware/automation-permissions");

const MAX_TELEGRAM_MESSAGES = 50;
const MAX_COMMENT = 4_000;
const MAX_OF_MEDIA_IDS = 200;
const MAX_TELEGRAM_MESSAGE_ID = 2_147_483_647;

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
    receivedAt: new Date(row.receivedAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

async function validateContentOrder({ agencyId, creatorId, customOrderId, db }) {
  if (!customOrderId) return null;
  const row = await db.customOrder.findFirst({
    where: { id: customOrderId, agencyId, creatorId },
    select: { id: true, type: true },
  });
  if (!row) throw fail("CUSTOM_SUBMISSION_ORDER_NOT_FOUND", "Custom order was not found for this creator", 404);
  if (String(row.type || "CONTENT").toUpperCase() !== "CONTENT") {
    throw fail("CUSTOM_SUBMISSION_ORDER_TYPE_INVALID", "Only CONTENT custom orders can have content submissions", 409);
  }
  return row;
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
    throw error;
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

async function assignCustomContentSubmission({ agencyId, member, submissionId, customOrderId, db = null } = {}) {
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
  const updated = await client.customContentSubmission.update({ where: { id: row.id }, data: { customOrderId: normalizedOrderId } });
  await audit({
    agencyId,
    actorUserId: member.userId || null,
    action: "custom_content_submission.assign",
    targetType: "CustomContentSubmission",
    targetId: row.id,
    metadata: { creatorId: row.creatorId, fromCustomOrderId: row.customOrderId || null, toCustomOrderId: normalizedOrderId },
    db: client,
  });
  return { ok: true, unchanged: false, submission: serializeSubmission(updated) };
}

module.exports = {
  MAX_TELEGRAM_MESSAGES,
  assignCustomContentSubmission,
  createCustomContentSubmission,
  deterministicSubmissionId,
  listCustomContentSubmissions,
  sameMessageIds,
  serializeSubmission,
  telegramMessageIds,
};
