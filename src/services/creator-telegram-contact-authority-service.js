"use strict";

const { audit } = require("./audit-service");
const { lockActiveTelegramAccountReference } = require("./telegram-account-reference-authority-service");
const { lockAgencyPipelineLifecycle, lockCreatorPipelineLifecycle } = require("./custom-content-pipeline-authority-service");

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }

async function updateCreatorTelegramContact({ agencyId, actorUserId = null, creatorId, telegramContact, telegramAccountId, db }) {
  if (typeof db?.$transaction !== "function") throw fail("CREATOR_TELEGRAM_ACCOUNT_TRANSACTION_REQUIRED", "Telegram account assignment requires transactional storage", 503);
  return db.$transaction(async (tx) => {
    // Current Telegram planning identity is a durable provider reference. Its publication must
    // serialize with both parent/creator retirement and Telegram-account retirement. Keep one
    // global order for every path that needs all three rows: Agency -> Creator -> TelegramAccount.
    // This prevents a stale pre-retirement read from re-attaching an account/contact after the
    // creator or Agency has been retired, and avoids the inverse Creator <-> TelegramAccount edge.
    await lockAgencyPipelineLifecycle({ db: tx, agencyId });
    await lockCreatorPipelineLifecycle({ db: tx, agencyId, creatorId });

    const existing = await tx.creatorAccount.findFirst({
      where: { id: String(creatorId), agencyId, deletedAt: null },
      select: { id: true, telegramContact: true, telegramUserId: true, telegramAccountId: true },
    });
    if (!existing) throw fail("CREATOR_NOT_FOUND", "Creator not found", 404);

    if (telegramAccountId) {
      await lockActiveTelegramAccountReference({
        agencyId,
        accountId: telegramAccountId,
        db: tx,
        notFoundCode: "CREATOR_TELEGRAM_ACCOUNT_INVALID",
        retiringCode: "CREATOR_TELEGRAM_ACCOUNT_RETIRING",
        unavailableCode: "CREATOR_TELEGRAM_ACCOUNT_FENCE_UNAVAILABLE",
        notFoundMessage: "Telegram connection does not belong to this workspace",
        retiringMessage: "Telegram connection is retiring and cannot be assigned to a creator",
      });
    }

    const contactChanged = existing.telegramContact !== telegramContact;
    const creator = await tx.creatorAccount.update({
      where: { id: existing.id },
      data: {
        telegramContact,
        ...(telegramAccountId !== undefined ? { telegramAccountId } : {}),
        ...(contactChanged ? { telegramUserId: null } : {}),
      },
    });
    await audit({
      agencyId,
      actorUserId,
      action: "creator.telegram_contact.updated",
      targetType: "creator",
      targetId: creator.id,
      metadata: {
        hadContact: Boolean(existing.telegramContact),
        hasContact: Boolean(creator.telegramContact),
        telegramAccountAssigned: Boolean(creator.telegramAccountId),
      },
      db: tx,
    });
    return creator;
  }, { isolationLevel: "Serializable" });
}

module.exports = { updateCreatorTelegramContact };
