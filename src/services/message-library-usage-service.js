"use strict";

const { createHash } = require("node:crypto");
const { runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { lockContentScope, lockMessageLibraryScript, isTrash } = require("./message-library-lifecycle-service");
const { cleanString, optionalString, jsonObject } = require("./server-store-utils");

const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function normalizeUsageInput(body = {}) {
  body = jsonObject(body);
  const eventId = body.eventId;
  // An intent ID is opaque: never truncate it, or generate one on the server.
  if (typeof eventId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]{15,119}$/.test(eventId)) {
    throw fail("MESSAGE_LIBRARY_USAGE_EVENT_ID_REQUIRED", "A stable eventId of 16 to 120 characters is required", 400);
  }
  const creatorId = cleanString(body.creatorId || body.accountId, 100);
  const scriptId = cleanString(body.scriptId || body.collectionId, 120);
  const messageId = cleanString(body.messageId || body.blockId, 120) || null;
  if (!creatorId || !scriptId) throw fail("MESSAGE_LIBRARY_USAGE_KEYS_MISSING", "creatorId and scriptId are required", 400);
  const metadata = jsonObject(body.metadata);
  function amount(value) {
    const result = Number(value || 0);
    if (!Number.isFinite(result)) throw fail("MESSAGE_LIBRARY_USAGE_NUMBER_INVALID", "Usage amounts must be finite", 400);
    return Math.max(0, result);
  }
  // This fixed-order object is the persisted semantic request, not raw input.
  // Unused fields (including raw chat text) cannot enter either the event or hash.
  const data = {
    creatorId,
    fanId: optionalString(body.fanId, 80),
    dialogId: optionalString(body.dialogId, 80),
    eventType: cleanString(body.eventType || body.status || "used", 40) || "used",
    metadata: {
      product: "message_library_script",
      source: cleanString(body.source || metadata.source || "electron-message-library", 100) || "electron-message-library",
      scriptId,
      messageId,
      draftId: optionalString(body.draftId, 120),
      realMessageId: optionalString(body.realMessageId || body.purchaseMessageId, 120),
      amount: amount(body.amount || metadata.amount),
      currency: cleanString(body.currency || metadata.currency || "USD", 10).toUpperCase() || "USD",
      mediaCount: Math.min(100, Math.floor(amount(metadata.mediaCount))),
      price: amount(metadata.price),
      lockedText: metadata.lockedText === true,
    },
  };
  return { eventId, creatorId, scriptId, messageId, data, fingerprint: hash([2, data]) };
}

async function recordMessageLibraryUsage({ db, agencyId, userId, actorMember, input }) {
  if (!agencyId || !userId || !actorMember) throw fail("MESSAGE_LIBRARY_ACTOR_REQUIRED", "Current membership is required", 401);
  const command = normalizeUsageInput(input);
  const { eventId, creatorId, scriptId, messageId, fingerprint, data } = command;
  // The canonical event is its own durable receipt. Its existing primary key
  // gives bounded lookup and uniqueness without a scan/index over old history.
  // Keys are per agency + user, deliberately NOT per script or creator: reusing
  // one key for another target must conflict instead of producing another effect.
  const id = `ml_usage_v2_${hash([agencyId, userId, eventId])}`;
  return runDbTransaction(db, async tx => {
    // Fresh authority precedes receipt lookup, including on a successful replay.
    await lockContentScope({ tx, agencyId, creatorId, actorMember, userId, manager: false });
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", id);
    const prior = await tx.contentUsageEvent.findUnique({ where: { id } });
    if (prior) {
      const receipt = prior.metadata?.usageReceipt;
      if (prior.agencyId !== agencyId || prior.createdByUserId !== userId || prior.creatorId !== creatorId
        || receipt?.version !== 2 || receipt.eventId !== eventId || receipt.fingerprint !== fingerprint) {
        throw fail("MESSAGE_LIBRARY_USAGE_EVENT_CONFLICT", "eventId was already used for different usage data");
      }
      // Script/block trash or cleanup must not undo an already committed event.
      return { event: prior, replayed: true };
    }
    const collection = await lockMessageLibraryScript({ tx, agencyId, creatorId, scriptId });
    if (!collection) throw fail("MESSAGE_LIBRARY_SCRIPT_NOT_FOUND", "Message Library script not found for this creator", 404);
    if (isTrash(collection)) throw fail("MESSAGE_LIBRARY_SCRIPT_TRASHED", "Script is not available");
    const block = messageId ? await tx.contentBlock.findFirst({ where: {
      collectionId: collection.id, OR: [{ clientId: messageId }, { id: messageId, clientId: null }],
    } }) : null;
    if (messageId && !block) throw fail("MESSAGE_LIBRARY_BLOCK_NOT_FOUND", "Message Library block not found", 404);
    if (block && isTrash(block)) throw fail("MESSAGE_LIBRARY_BLOCK_TRASHED", "Message is not available");
    const now = await dbAuthorityNow({ db: tx });
    const event = await tx.contentUsageEvent.create({ data: {
      ...data, id, agencyId, collectionId: collection.id, blockId: block?.id || null,
      createdByUserId: userId, createdAt: now,
      metadata: { ...data.metadata, usageReceipt: { version: 2, eventId, fingerprint } },
    } });
    // One commit owns both effect and audit. A rollback leaves the intent retryable.
    await tx.auditLog.create({ data: {
      agencyId, actorUserId: userId, action: "message_library.usage",
      targetType: "ContentCollection", targetId: collection.id,
      metadata: { creatorId, eventId, usageEventId: id },
    } });
    return { event, replayed: false };
  }, { maxWait: 5000, timeout: 15000 });
}

module.exports = { normalizeUsageInput, recordMessageLibraryUsage };
