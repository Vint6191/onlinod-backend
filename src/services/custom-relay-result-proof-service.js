"use strict";

function fail(code, message, status = 409) { return Object.assign(new Error(message), { code, status }); }
function clean(value, max = 500) { const text = String(value == null ? "" : value).trim(); return text ? text.slice(0, max) : ""; }
function mediaId(value) { const text = clean(value, 80); return /^[1-9]\d{0,39}$/.test(text) ? text : null; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }

async function confirmedRelayResult({ agencyId, creatorId, submissionId, expectedIndex, expectedTelegramSourceAccountId, expectedTelegramSourceUserId, expectedTelegramMessageId, db }) {
  const index = Number(expectedIndex);
  if (!Number.isInteger(index) || index < 0) throw fail("CUSTOM_RELAY_PROOF_INDEX_INVALID", "expectedIndex must be a non-negative integer", 400);
  const expectedSourceAccountId = clean(expectedTelegramSourceAccountId, 180);
  const expectedSourceUserId = clean(expectedTelegramSourceUserId, 40);
  const expectedSourceId = clean(expectedTelegramMessageId, 40);
  if (!expectedSourceAccountId || !/^\d{1,20}$/.test(expectedSourceUserId) || !/^[1-9]\d{0,9}$/.test(expectedSourceId)) {
    throw fail("CUSTOM_RELAY_PROOF_SOURCE_REQUIRED", "Telegram source account, provider user and message id are required for relay proof verification", 400);
  }
  const normalizedSubmissionId = clean(submissionId, 180);
  const key = `custom-relay:${normalizedSubmissionId}:${index}`;
  const row = await db.automationDelivery.findFirst({
    where: { agencyId, creatorId, actionType: "CUSTOM_RELAY_SEND", idempotencyKey: key, status: "COMPLETED" },
    select: { id: true, idempotencyKey: true, actionType: true, status: true, payload: true, result: true, messageId: true, finishedAt: true },
  });
  const result = object(row?.result);
  const payload = object(row?.payload);
  const provenKind = clean(result.programmaticWriteKind, 80).toUpperCase();
  const provenMediaId = mediaId(result.mediaId);
  const boundSubmissionId = clean(payload.submissionId, 180);
  const boundIndex = Number(payload.expectedIndex);
  const boundTelegramSourceAccountId = clean(payload.telegramSourceAccountId, 180);
  const boundTelegramSourceUserId = clean(payload.telegramSourceUserId, 40);
  const boundTelegramMessageId = clean(payload.telegramMessageId, 40);
  if (!row || provenKind !== "CUSTOM_RELAY_SEND" || !provenMediaId) {
    throw fail("CUSTOM_SUBMISSION_RELAY_PROOF_REQUIRED", `No confirmed CUSTOM_RELAY_SEND proof exists for submission ${submissionId} index ${index}`, 409);
  }
  if (boundSubmissionId !== normalizedSubmissionId || boundIndex !== index
      || boundTelegramSourceAccountId !== expectedSourceAccountId
      || boundTelegramSourceUserId !== expectedSourceUserId
      || boundTelegramMessageId !== expectedSourceId) {
    throw fail("CUSTOM_SUBMISSION_RELAY_PROOF_SOURCE_MISMATCH", `Confirmed CUSTOM_RELAY_SEND proof is not bound to Telegram source ${expectedSourceAccountId}/${expectedSourceUserId}/${expectedSourceId} for submission ${normalizedSubmissionId} index ${index}`, 409);
  }
  return { writeId: String(row.id), idempotencyKey: key, mediaId: provenMediaId, telegramSourceAccountId: boundTelegramSourceAccountId, telegramSourceUserId: boundTelegramSourceUserId, telegramMessageId: boundTelegramMessageId, messageId: clean(result.messageId || row.messageId, 180) || null, finishedAt: row.finishedAt || null };
}

async function confirmedRelaySequence({ agencyId, creatorId, submissionId, expectedTelegramSourceAccountId, expectedTelegramSourceUserId, expectedTelegramMessageIds, db }) {
  const sourceIds = Array.isArray(expectedTelegramMessageIds) ? expectedTelegramMessageIds.map((value) => clean(value, 40)) : [];
  if (sourceIds.length > 200) throw fail("CUSTOM_RELAY_PROOF_COUNT_INVALID", "Relay proof count is invalid", 400);
  if (sourceIds.some((value) => !/^[1-9]\d{0,9}$/.test(value))) throw fail("CUSTOM_RELAY_PROOF_SOURCE_REQUIRED", "Every relay proof requires its Telegram source message id", 400);
  const results = [];
  for (let index = 0; index < sourceIds.length; index += 1) {
    results.push(await confirmedRelayResult({ agencyId, creatorId, submissionId, expectedIndex: index,
      expectedTelegramSourceAccountId, expectedTelegramSourceUserId, expectedTelegramMessageId: sourceIds[index], db }));
  }
  const seen = new Set();
  for (const result of results) {
    if (seen.has(result.mediaId)) throw fail("CUSTOM_RELAY_PROOF_DUPLICATE_MEDIA", "Confirmed relay results contain a duplicate OnlyFans media id", 409);
    seen.add(result.mediaId);
  }
  return results;
}

module.exports = { confirmedRelayResult, confirmedRelaySequence };
