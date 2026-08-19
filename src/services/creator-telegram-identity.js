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

function normalizeExpectedTelegramContact(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 160 || /[\r\n\t]/.test(text)) {
    const err = new Error("Telegram contact used for identity resolution is invalid");
    err.code = "CREATOR_TELEGRAM_CONTACT_INVALID";
    err.status = 400;
    throw err;
  }
  return text;
}

async function setCreatorTelegramUserId({ agencyId, creatorId, telegramUserId, expectedTelegramContact, db = null }) {
  const client = db || require("../prisma");
  const normalized = normalizeTelegramUserId(telegramUserId);
  const expectedContact = normalizeExpectedTelegramContact(expectedTelegramContact);
  const id = String(creatorId || "");
  const agency = String(agencyId || "");

  // Bind the resolved Telegram identity only if the creator still has exactly the
  // contact that Desktop resolved. updateMany makes the contact check and write
  // atomic, so an edit cannot race an in-flight resolve and attach a stale id.
  const result = await client.creatorAccount.updateMany({
    where: { id, agencyId: agency, deletedAt: null, telegramContact: expectedContact },
    data: { telegramUserId: normalized },
  });
  if (Number(result?.count || 0) !== 1) {
    const current = await client.creatorAccount.findFirst({
      where: { id, agencyId: agency, deletedAt: null },
      select: { id: true, telegramContact: true },
    });
    if (!current) {
      const err = new Error("Creator not found");
      err.code = "CREATOR_NOT_FOUND";
      err.status = 404;
      throw err;
    }
    const err = new Error("Telegram contact changed while its identity was being resolved");
    err.code = "CREATOR_TELEGRAM_CONTACT_CHANGED";
    err.status = 409;
    throw err;
  }

  return client.creatorAccount.findFirst({
    where: { id, agencyId: agency, deletedAt: null },
  });
}

module.exports = {
  normalizeTelegramUserId,
  normalizeExpectedTelegramContact,
  setCreatorTelegramUserId,
};
