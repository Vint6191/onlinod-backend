"use strict";

const { assertManagementCommitAuthority } = require("./management-commit-authority-service");
const { lockAgencyPipelineLifecycle, lockCreatorPipelineLifecycle } = require("./custom-content-pipeline-authority-service");
const { authorizeCreatorAccountWrite } = require("./phase2-release-compatibility-authority-service");

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

async function setCreatorTelegramUserId({ agencyId, actorMember, creatorId, telegramUserId, expectedTelegramContact, db = null }) {
  const client = db || require("../prisma");
  const normalized = normalizeTelegramUserId(telegramUserId);
  const expectedContact = normalizeExpectedTelegramContact(expectedTelegramContact);
  const id = String(creatorId || "");
  const agency = String(agencyId || "");
  if (typeof client?.$transaction !== "function") {
    const err = new Error("Creator Telegram identity mutation requires transactional storage");
    err.code = "CREATOR_TELEGRAM_IDENTITY_TRANSACTION_REQUIRED";
    err.status = 503;
    throw err;
  }

  return client.$transaction(async (tx) => {
    await lockAgencyPipelineLifecycle({ db: tx, agencyId: agency });
    await lockCreatorPipelineLifecycle({ db: tx, agencyId: agency, creatorId: id });
    await assertManagementCommitAuthority({
      tx,
      agencyId: agency,
      actorMember,
      permissionKey: "creators.manage",
      creatorIds: [id],
      agencyAlreadyLocked: true,
      creatorRowsAlreadyLocked: true,
    });

    await authorizeCreatorAccountWrite(tx);

    // Bind the resolved Telegram identity only if the creator still has exactly the
    // contact that Desktop resolved. The commit-time management guard above and
    // this CAS solve different races and are both required.
    const result = await tx.creatorAccount.updateMany({
      where: { id, agencyId: agency, deletedAt: null, telegramContact: expectedContact },
      data: { telegramUserId: normalized },
    });
    if (Number(result?.count || 0) !== 1) {
      const current = await tx.creatorAccount.findFirst({
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

    return tx.creatorAccount.findFirst({
      where: { id, agencyId: agency, deletedAt: null },
    });
  }, { isolationLevel: "Serializable" });
}

module.exports = {
  normalizeTelegramUserId,
  normalizeExpectedTelegramContact,
  setCreatorTelegramUserId,
};
