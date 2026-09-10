"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
function token(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`; }
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
async function mustStillWait(promise, ms = 75) {
  const marker = Symbol("pending");
  const outcome = await Promise.race([promise.then(() => "settled", () => "settled"), new Promise((resolve) => setTimeout(() => resolve(marker), ms))]);
  assert.equal(outcome, marker, "operation unexpectedly crossed a held advisory authority");
}

async function createFixture(db, ids) {
  const now = new Date("2026-09-10T10:00:00.000Z");
  await db.$executeRawUnsafe(`INSERT INTO "User" ("id","email","passwordHash","createdAt","updatedAt") VALUES ($1,$2,'p2',clock_timestamp(),clock_timestamp())`, ids.userId, `${ids.userId}@phase2.invalid`);
  await db.$executeRawUnsafe(`INSERT INTO "Agency" ("id","name","plan","status","createdAt","updatedAt") VALUES ($1,$2,'trial','TRIAL',clock_timestamp(),clock_timestamp())`, ids.agencyId, `P2 response authority ${ids.agencyId}`);
  await db.$executeRawUnsafe(`INSERT INTO "AgencyMember" ("id","agencyId","userId","role","accessEpoch","createdAt","updatedAt") VALUES ($1,$2,$3,'OWNER',1,clock_timestamp(),clock_timestamp())`, ids.memberId, ids.agencyId, ids.userId);
  await db.$executeRawUnsafe(`INSERT INTO "CreatorAccount" ("id","agencyId","displayName","status","connectionState","connectionGeneration","createdAt","updatedAt") VALUES ($1,$2,$3,'DRAFT','ENROLLMENT_REQUIRED',0,clock_timestamp(),clock_timestamp())`, ids.creatorId, ids.agencyId, ids.creatorId);
  await db.teamActivityEvent.create({ data: {
    id: ids.incomingId, agencyId: ids.agencyId, creatorId: ids.creatorId, dialogId: ids.dialogId, fanId: ids.dialogId,
    type: "fan_message_received", eventKind: "FAN_MESSAGE_RECEIVED", messageId: ids.incomingMessageId, ts: new Date(now.getTime() - 120_000), source: "phase2_pg_test",
  }});
  return db.teamSentMessageLedger.create({ data: {
    id: ids.replyLedgerId, agencyId: ids.agencyId, accountId: ids.accountId, creatorId: ids.creatorId,
    memberId: ids.memberId, dialogId: ids.dialogId, fanId: ids.dialogId, messageId: ids.replyMessageId,
    localSeed: ids.replyLedgerId, sentAt: now, source: "manual",
  }});
}

async function cleanupFixture(db, ids) {
  await db.teamResponseCase.deleteMany({ where: { agencyId: ids.agencyId } }).catch(() => undefined);
  await db.teamCoverageSession.deleteMany({ where: { agencyId: ids.agencyId } }).catch(() => undefined);
  await db.teamSentMessageLedger.deleteMany({ where: { agencyId: ids.agencyId } }).catch(() => undefined);
  await db.teamActivityEvent.deleteMany({ where: { agencyId: ids.agencyId } }).catch(() => undefined);
  await db.agency.delete({ where: { id: ids.agencyId } }).catch(() => undefined);
  await db.user.delete({ where: { id: ids.userId } }).catch(() => undefined);
}

test("A32/A33 PostgreSQL: response and coverage production writers wait for their stable advisory commit authorities", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const { lockDbAdvisoryXact } = require("./db-transaction-service");
  const { deriveResponseCaseForReply, upsertCoverageSession } = require("./team-response-projection-service");
  const db1 = new PrismaClient();
  const db2 = new PrismaClient();
  const ids = {
    agencyId: token("p2_response_agency"), userId: token("p2_response_user"), memberId: token("p2_response_member"),
    creatorId: token("p2_response_creator"), dialogId: token("p2_response_dialog"), accountId: token("p2_response_account"),
    incomingId: token("p2_response_incoming"), incomingMessageId: token("p2_response_incoming_msg"),
    replyLedgerId: token("p2_response_reply_ledger"), replyMessageId: token("p2_response_reply_msg"), coverageId: token("p2_response_coverage"),
  };

  try {
    const reply = await createFixture(db1, ids);

    const responseHeld = deferred(); const releaseResponse = deferred();
    const responseBlocker = db1.$transaction(async (tx) => {
      await lockDbAdvisoryXact({ db: tx, key: `team-response:${ids.agencyId}:${ids.creatorId}:${ids.dialogId}` });
      responseHeld.resolve();
      await releaseResponse.promise;
    }, { maxWait: 10_000, timeout: 30_000 });
    await responseHeld.promise;
    const responseWrite = deriveResponseCaseForReply(reply, db2);
    await mustStillWait(responseWrite);
    releaseResponse.resolve();
    await responseBlocker;
    const response = await responseWrite;
    assert.equal(response?.projectionState, "FULL");
    assert.equal(response?.incomingCount, 1);

    const coverageHeld = deferred(); const releaseCoverage = deferred();
    const coverageBlocker = db1.$transaction(async (tx) => {
      await lockDbAdvisoryXact({ db: tx, key: `team-coverage:${ids.agencyId}:${ids.coverageId}` });
      coverageHeld.resolve();
      await releaseCoverage.promise;
    }, { maxWait: 10_000, timeout: 30_000 });
    await coverageHeld.promise;
    const coverageWrite = upsertCoverageSession({
      agencyId: ids.agencyId, creatorId: ids.creatorId, memberId: ids.memberId, coverageId: ids.coverageId,
      eventKind: "COVERAGE_ENDED", ts: new Date("2026-09-10T11:00:00.000Z"),
      startedAt: new Date("2026-09-10T10:00:00.000Z"), endedAt: new Date("2026-09-10T11:00:00.000Z"),
    }, db2);
    await mustStillWait(coverageWrite);
    releaseCoverage.resolve();
    await coverageBlocker;
    const coverage = await coverageWrite;
    assert.equal(coverage?.endedAt?.toISOString(), "2026-09-10T11:00:00.000Z");
    assert.equal(coverage?.durationSeconds, 3600);
  } finally {
    await cleanupFixture(db1, ids);
    await Promise.allSettled([db1.$disconnect(), db2.$disconnect()]);
  }
});
