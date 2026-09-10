"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";

function token(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function rollbackTx(prisma, work, sentinel) {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '4s'");
      await work(tx);
      throw new Error(sentinel);
    }, { timeout: 20_000 });
    throw new Error(`${sentinel}: transaction unexpectedly committed`);
  } catch (err) {
    if (err?.message !== sentinel) throw err;
  }
}

async function orderDirty(tx, orderId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT "providerOperationalDirty" FROM "CustomOrder" WHERE "id" = $1 LIMIT 1`,
    orderId,
  );
  return rows?.[0]?.providerOperationalDirty === true;
}

async function clearOrderDirty(tx, orderId) {
  await tx.$executeRawUnsafe(
    `UPDATE "CustomOrder"
        SET "providerOperationalDirty" = FALSE,
            "providerOperationalProjectedAt" = clock_timestamp(),
            "providerOperationalProjectionVersion" = 'provider_operational_debt_v1'
      WHERE "id" = $1`,
    orderId,
  );
  assert.equal(await orderDirty(tx, orderId), false);
}

test("Phase2 PostgreSQL provider current-work triggers preserve exact dirty/debt recovery", { skip: !enabled }, async (t) => {
  const prisma = require("../prisma");
  try {
    await rollbackTx(prisma, async (tx) => {
      const agency = { id: token("phase2_agency") };
      const user = { id: token("phase2_user") };
      const member = { id: token("phase2_member") };
      const creator = { id: token("phase2_creator") };
      await tx.$executeRawUnsafe(
        `INSERT INTO "User" ("id","email","passwordHash","createdAt","updatedAt")
         VALUES ($1,$2,'phase2_pg',clock_timestamp(),clock_timestamp())`,
        user.id, `${user.id}@phase2.invalid`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "Agency" ("id","name","plan","status","createdAt","updatedAt")
         VALUES ($1,$2,'trial','TRIAL',clock_timestamp(),clock_timestamp())`,
        agency.id, `Phase2 provider PG ${agency.id}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "AgencyMember" ("id","agencyId","userId","role","accessEpoch","createdAt","updatedAt")
         VALUES ($1,$2,$3,'OWNER',1,clock_timestamp(),clock_timestamp())`,
        member.id, agency.id, user.id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "CreatorAccount" ("id","agencyId","displayName","status","connectionState","connectionGeneration","createdAt","updatedAt")
         VALUES ($1,$2,$3,'DRAFT','ENROLLMENT_REQUIRED',0,clock_timestamp(),clock_timestamp())`,
        creator.id, agency.id, `Phase2 creator ${creator.id}`,
      );
      const accountId = token("phase2_mtproto");
      const orderId = token("phase2_custom");
      const intentId = token("phase2_intent");
      const submissionId = token("phase2_submission");
      const deliveryId = token("phase2_relay");
      const mediaId = token("phase2_media");

      await tx.$executeRawUnsafe(
        `INSERT INTO "AgencyTelegramMtprotoAccount"
          ("id","agencyId","apiId","encryptedPayload","iv","tag","lifecycleState")
         VALUES ($1,$2,1,'phase2_pg_ciphertext','phase2_pg_iv','phase2_pg_tag','ACTIVE')`,
        accountId, agency.id,
      );

      await tx.$executeRawUnsafe(
        `UPDATE "CreatorAccount" SET "telegramAccountId" = $1 WHERE "id" = $2 AND "agencyId" = $3`,
        accountId, creator.id, agency.id,
      );

      await tx.$executeRawUnsafe(
        `INSERT INTO "CustomOrder"
          ("id","agencyId","creatorId","dialogId","createdByMemberId","scenario","type","status","providerOperationalDirty")
         VALUES ($1,$2,$3,$4,$5,'phase2_pg','CONTENT','PENDING',FALSE)`,
        orderId, agency.id, creator.id, token("dialog"), member.id,
      );
      assert.equal(await orderDirty(tx, orderId), false);

      await tx.$executeRawUnsafe(
        `INSERT INTO "TelegramDeliveryIntent"
          ("id","agencyId","creatorId","customOrderId","accountId","kind","logicalKey","payloadFingerprint","state")
         VALUES ($1,$2,$3,$4,$5,'TASK',$6,'phase2_pg_fp','PLANNED')`,
        intentId, agency.id, creator.id, orderId, accountId, token("logical"),
      );
      assert.equal(await orderDirty(tx, orderId), true, "Telegram intent transition must re-open its exact Custom order");

      await clearOrderDirty(tx, orderId);
      await tx.$executeRawUnsafe(
        `INSERT INTO "CustomContentSubmission"
          ("id","agencyId","creatorId","customOrderId","telegramSourceAccountId","sourceAuthority")
         VALUES ($1,$2,$3,$4,$5,'TELEGRAM')`,
        submissionId, agency.id, creator.id, orderId, accountId,
      );
      assert.equal(await orderDirty(tx, orderId), true, "Custom submission transition must re-open its exact order");

      await clearOrderDirty(tx, orderId);
      await tx.$executeRawUnsafe(
        `UPDATE "CreatorAccount" SET "telegramContact" = $1 WHERE "id" = $2 AND "agencyId" = $3`,
        token("contact"), creator.id, agency.id,
      );
      assert.equal(await orderDirty(tx, orderId), true, "Creator Telegram binding change must re-open affected pending CONTENT work");

      await clearOrderDirty(tx, orderId);
      await tx.$executeRawUnsafe(
        `UPDATE "AgencyTelegramMtprotoAccount" SET "lifecycleState" = 'RETIRING' WHERE "id" = $1`,
        accountId,
      );
      assert.equal(await orderDirty(tx, orderId), true, "Provider lifecycle change must re-open bound creator work");

      await clearOrderDirty(tx, orderId);
      const payload = JSON.stringify({ submissionId, customOrderId: orderId, telegramSourceAccountId: accountId });
      const result = JSON.stringify({ mediaId });
      await tx.$executeRawUnsafe(
        `INSERT INTO "AutomationDelivery"
          ("id","agencyId","creatorId","actionType","targetId","status","payload","result")
         VALUES ($1,$2,$3,'CUSTOM_RELAY_SEND',$4,'COMPLETED',$5::jsonb,$6::jsonb)`,
        deliveryId, agency.id, creator.id, `${submissionId}:phase2`, payload, result,
      );

      let debt = await tx.$queryRawUnsafe(
        `SELECT "accountId","debtClass","objectType","objectId","customOrderId","customSubmissionId"
           FROM "ProviderOperationalDebt"
          WHERE "id" = $1`,
        `pod_external_${deliveryId}`,
      );
      assert.equal(debt.length, 1);
      assert.equal(debt[0].accountId, accountId);
      assert.equal(debt[0].debtClass, "CUSTOM_EXTERNAL_PROJECTION_DEBT");
      assert.equal(debt[0].objectType, "AutomationDelivery");
      assert.equal(debt[0].objectId, deliveryId);
      assert.equal(debt[0].customOrderId, orderId);
      assert.equal(debt[0].customSubmissionId, submissionId);

      await tx.$executeRawUnsafe(
        `UPDATE "AutomationDelivery" SET "status" = 'FAILED' WHERE "id" = $1`,
        deliveryId,
      );
      debt = await tx.$queryRawUnsafe(
        `SELECT "id" FROM "ProviderOperationalDebt" WHERE "id" = $1`,
        `pod_external_${deliveryId}`,
      );
      assert.equal(debt.length, 0, "non-completed relay must not leave stale external projection debt");
    }, "PHASE2_PROVIDER_CURRENT_WORK_TRIGGER_ROLLBACK");
  } finally {
    if (typeof prisma.$disconnect === "function") await prisma.$disconnect();
  }
});
