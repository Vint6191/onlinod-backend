"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
function token(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`; }

async function rollbackTx(prisma, fn) {
  const marker = new Error("PHASE2_TEST_ROLLBACK");
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw marker; }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    if (error !== marker) throw error;
  }
}

test("A34/A46 PostgreSQL: Actual52 projection UPSERT/DELETE cannot touch current v2 roots", { skip: !enabled }, async () => {
  const prisma = require("../prisma");
  try {
    await rollbackTx(prisma, async (tx) => {
      const agencyId = token("p2_roll_agency");
      const userId = token("p2_roll_user");
      const memberId = token("p2_roll_member");
      const creatorA = token("p2_roll_creator_a");
      const creatorB = token("p2_roll_creator_b");
      const dialogId = token("p2_roll_dialog");
      const replyId = token("p2_roll_reply");
      const now = new Date("2026-09-10T10:00:00.000Z");

      await tx.$executeRawUnsafe(`INSERT INTO "User" ("id","email","passwordHash","createdAt","updatedAt") VALUES ($1,$2,'p2',clock_timestamp(),clock_timestamp())`, userId, `${userId}@phase2.invalid`);
      await tx.$executeRawUnsafe(`INSERT INTO "Agency" ("id","name","plan","status","createdAt","updatedAt") VALUES ($1,$2,'trial','TRIAL',clock_timestamp(),clock_timestamp())`, agencyId, `P2 rolling ${agencyId}`);
      await tx.$executeRawUnsafe(`INSERT INTO "AgencyMember" ("id","agencyId","userId","role","accessEpoch","createdAt","updatedAt") VALUES ($1,$2,$3,'OWNER',1,clock_timestamp(),clock_timestamp())`, memberId, agencyId, userId);
      for (const creatorId of [creatorA, creatorB]) {
        await tx.$executeRawUnsafe(`INSERT INTO "CreatorAccount" ("id","agencyId","displayName","status","connectionState","connectionGeneration","createdAt","updatedAt") VALUES ($1,$2,$3,'DRAFT','ENROLLMENT_REQUIRED',0,clock_timestamp(),clock_timestamp())`, creatorId, agencyId, creatorId);
      }

      await tx.teamPendingDialogState.create({ data: {
        agencyId, creatorId: creatorA, dialogId, status: "CLEAR", derivationVersion: "team_pending_v2",
        projectionState: "FULL", projectionRevision: 9n,
      }});
      await tx.teamResponseCase.create({ data: {
        agencyId, creatorId: creatorA, memberId, dialogId, replyMessageId: replyId,
        incomingAt: now, lastIncomingAt: now, replyAt: now, classification: "FRESH",
        derivationVersion: "team_response_v2", projectionState: "FULL", projectionRevision: 9n,
      }});
      // A34 remains possible on the current table even while Actual52 compatibility exists.
      await tx.teamResponseCase.create({ data: {
        agencyId, creatorId: creatorB, memberId, dialogId: `${dialogId}_b`, replyMessageId: replyId,
        incomingAt: now, lastIncomingAt: now, replyAt: now, classification: "FRESH",
        derivationVersion: "team_response_v2", projectionState: "FULL", projectionRevision: 1n,
      }});

      // Exact SQL shape used by the old generated Prisma client remains legal, but it
      // targets only the compatibility physical tables.
      await tx.$executeRawUnsafe(`
        INSERT INTO "TeamPendingDialogState" ("id","agencyId","creatorId","dialogId","status","derivationVersion","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,'PENDING','team_pending_v1',clock_timestamp(),clock_timestamp())
        ON CONFLICT ("agencyId","creatorId","dialogId") DO UPDATE SET "status"='PENDING',"derivationVersion"='team_pending_v1',"updatedAt"=clock_timestamp()`,
        token("legacy_pending"), agencyId, creatorA, dialogId,
      );
      await tx.$executeRawUnsafe(`
        INSERT INTO "TeamResponseCase" ("id","agencyId","creatorId","memberId","dialogId","replyMessageId","incomingAt","lastIncomingAt","replyAt","derivationVersion","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$7,'team_response_v1',clock_timestamp(),clock_timestamp())
        ON CONFLICT ("agencyId","replyMessageId") DO UPDATE SET "classification"='UNKNOWN',"derivationVersion"='team_response_v1',"updatedAt"=clock_timestamp()`,
        token("legacy_response"), agencyId, creatorA, memberId, dialogId, replyId, now,
      );
      await tx.$executeRawUnsafe(`DELETE FROM "TeamResponseCase" WHERE "agencyId"=$1 AND "replyMessageId"=$2`, agencyId, replyId);

      const pending = await tx.teamPendingDialogState.findUnique({ where: { agencyId_creatorId_dialogId: { agencyId, creatorId: creatorA, dialogId } } });
      const currentA = await tx.teamResponseCase.findUnique({ where: { agencyId_creatorId_replyMessageId: { agencyId, creatorId: creatorA, replyMessageId: replyId } } });
      const currentB = await tx.teamResponseCase.findUnique({ where: { agencyId_creatorId_replyMessageId: { agencyId, creatorId: creatorB, replyMessageId: replyId } } });
      assert.equal(pending.status, "CLEAR");
      assert.equal(pending.derivationVersion, "team_pending_v2");
      assert.equal(currentA.derivationVersion, "team_response_v2");
      assert.equal(currentA.projectionRevision, 9n);
      assert.equal(currentB.derivationVersion, "team_response_v2");

      const legacyPending = await tx.$queryRawUnsafe(`SELECT "status","derivationVersion" FROM "TeamPendingDialogState" WHERE "agencyId"=$1 AND "creatorId"=$2 AND "dialogId"=$3`, agencyId, creatorA, dialogId);
      const legacyResponses = await tx.$queryRawUnsafe(`SELECT "id" FROM "TeamResponseCase" WHERE "agencyId"=$1 AND "replyMessageId"=$2`, agencyId, replyId);
      assert.equal(legacyPending[0]?.status, "PENDING");
      assert.equal(legacyPending[0]?.derivationVersion, "team_pending_v1");
      assert.equal(legacyResponses.length, 0);
    });
  } finally {
    if (typeof prisma.$disconnect === "function") await prisma.$disconnect();
  }
});
