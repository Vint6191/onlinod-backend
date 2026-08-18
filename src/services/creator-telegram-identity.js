"use strict";

function normalizeTelegramUserId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,20}$/.test(text)) {
    const err = new Error("Telegram user id must be a positive integer string");
    err.code = "CREATOR_TELEGRAM_USER_ID_INVALID";
    err.status = 400;
    throw err;
  }
  const normalized = BigInt(text);
  if (normalized <= 0n || normalized > 9223372036854775807n) {
    const err = new Error("Telegram user id is outside the supported 64-bit range");
    err.code = "CREATOR_TELEGRAM_USER_ID_INVALID";
    err.status = 400;
    throw err;
  }
  return normalized.toString(10);
}

async function setCreatorTelegramUserId({ agencyId, creatorId, telegramUserId, db = null }) {
  const client = db || require("../prisma");
  const normalized = normalizeTelegramUserId(telegramUserId);
  const creator = await client.creatorAccount.findFirst({
    where: { id: String(creatorId || ""), agencyId: String(agencyId || ""), deletedAt: null },
    select: { id: true, telegramContact: true },
  });
  if (!creator) {
    const err = new Error("Creator not found");
    err.code = "CREATOR_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  if (!String(creator.telegramContact || "").trim()) {
    const err = new Error("Telegram contact must be set before resolving Telegram identity");
    err.code = "CREATOR_TELEGRAM_CONTACT_REQUIRED";
    err.status = 409;
    throw err;
  }
  return client.creatorAccount.update({
    where: { id: creator.id },
    data: { telegramUserId: normalized },
  });
}

module.exports = {
  normalizeTelegramUserId,
  setCreatorTelegramUserId,
};
