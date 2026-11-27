"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";

test("PostgreSQL: exact Bump send receipts survive lost completion, lease turnover, and retirement", { skip: !enabled }, async (t) => {
  const db = require("../prisma");
  const { withFixtureAuthorities, cleanupAgencyFixture } = require("../../scripts/test-support/phase2-postgres-integration-authority");
  const { runDbTransaction } = require("./db-transaction-service");
  const { prepareWriteActionDelivery, completeActionDelivery, failActionDelivery } = require("./automation-action-delivery-service");
  const { AUTHORITY_VERSION, mintActionMessageSettlement, completeActionMessageWithSettlementToken } = require("./automation-message-settlement-service");
  const prefix = "message209-" + randomUUID(), agencyId = prefix, creatorId = prefix + "-creator";
  const userId = prefix + "-user", memberId = prefix + "-member", deviceId = prefix + "-device";
  const remainingOwnerId = prefix + "-remaining-owner", remainingOwnerMemberId = prefix + "-remaining-member";
  let index = 0, server;
  async function makeDelivery(source = "manual") {
    index += 1;
    const fanId = "9920900" + String(index).padStart(3, "0"), at = new Date();
    const fan = await db.creatorFan.create({ data: { agencyId, creatorId, onlyFansUserId: fanId } });
    await db.creatorFanRelationshipCurrent.create({ data: {
      agencyId, creatorId, fanRecordId: fan.id, onlyFansUserId: fanId,
      canReceiveChatMessage: true, canReceiveChatMessageAuthorityVersion: `${at.toISOString()}|0700|USER_PROFILE|fixture`,
      observedAt: at, source: "USER_PROFILE",
    } });
    if (source === "online") await db.automationBumpFanState.create({ data: { agencyId, creatorId, fanId, dialogId: fanId, lastOnlineAt: at } });
    const leaseToken = randomUUID(), id = prefix + "-send-" + index;
    const delivery = await db.automationDelivery.create({ data: {
      id, agencyId, creatorId, actionType: "SEND_MESSAGE", moduleKey: "bumps", originKind: "AUTOMATION",
      idempotencyKey: id + "-operation", fanId, dialogId: fanId, targetId: fanId, status: "RUNNING",
      claimedByDeviceId: deviceId, leaseTokenHash: createHash("sha256").update(leaseToken).digest("hex"),
      leaseRevision: 1, leaseMemberId: memberId, leaseAccessEpoch: 1, claimedAt: at, claimUntil: new Date(+at + 180000),
      payload: { source, template: { id: "receipt-template", text: "fixture", mediaFiles: [] }, timing: { deleteAfterNoReplyMs: 60000 } },
      createdByUserId: userId,
    } });
    return { delivery, lease: { deliveryId: id, userId, deviceId, leaseToken, leaseRevision: 1 } };
  }
  async function prepare(source) {
    const fixture = await makeDelivery(source);
    const grant = await prepareWriteActionDelivery({ ...fixture.lease, messageSettlementVersion: 1 });
    assert.equal(grant.messageSettlementVersion, 1);
    assert.equal(typeof grant.settlementToken, "string");
    assert(grant.settlementToken.length >= 32);
    const row = await db.automationDelivery.findUnique({ where: { id: fixture.delivery.id } });
    assert.equal(row.status, "COMMITTING");
    assert.equal(row.result.messageSettlement.tokenHash, createHash("sha256").update(grant.settlementToken).digest("hex"));
    assert.equal(JSON.stringify(row.result).includes(grant.settlementToken), false);
    return { ...fixture, grant, receipt: {
      authorityVersion: AUTHORITY_VERSION, deliveryId: row.id, deviceId,
      operationId: row.idempotencyKey, writeCommitRevision: grant.writeCommitRevision,
      settlementToken: grant.settlementToken, messageId: "9920910" + String(index).padStart(3, "0"), sentAt: new Date().toISOString(),
    } };
  }
  try {
    await withFixtureAuthorities(db, { team: true, creator: true }, async tx => {
      await tx.agency.create({ data: { id: agencyId, name: "Message receipt regression", trialEndsAt: new Date(Date.now() + 86400000) } });
      await tx.user.create({ data: { id: userId, email: userId + "@example.test", passwordHash: "synthetic" } });
      await tx.agencyMember.create({ data: { id: memberId, agencyId, userId, role: "MANAGER", roleKey: "manager", permissions: { "automation.manage": true }, assignedCreators: "all", accessEpoch: 1 } });
      await tx.user.create({ data: { id: remainingOwnerId, email: remainingOwnerId + "@example.test", passwordHash: "synthetic", emailVerifiedAt: new Date() } });
      await tx.agencyMember.create({ data: { id: remainingOwnerMemberId, agencyId, userId: remainingOwnerId, role: "OWNER", roleKey: "owner", assignedCreators: "all" } });
      await tx.creatorAccount.create({ data: { id: creatorId, agencyId, displayName: "Receipt fixture", status: "READY" } });
      await tx.workerDevice.create({ data: { id: deviceId, agencyId, userId } });
      await tx.automationControlState.create({ data: { agencyId, creatorId, moduleKey: "bumps", scopeKey: `creator:${creatorId}:module:bumps`, enabled: true, settings: { enabled: true } } });
    });

    await t.test("normal and online prepare atomically mint an immutable grant; concurrent repeats finalize once", async () => {
      for (const source of ["manual", "online"]) {
        const f = await prepare(source);
        await assert.rejects(() => prepareWriteActionDelivery({ ...f.lease, messageSettlementVersion: 1 }), { code: "DELIVERY_ALREADY_COMMITTING" });
        for (const patch of [{ deviceId: "other-device" }, { operationId: "other-operation" }, { writeCommitRevision: 2 }, { settlementToken: randomUUID() }]) {
          await assert.rejects(() => completeActionMessageWithSettlementToken({ ...f.receipt, ...patch }), { code: "ACTION_MESSAGE_SETTLEMENT_BINDING_INVALID" });
        }
        const responses = await Promise.all(Array.from({ length: 6 }, () => completeActionMessageWithSettlementToken(f.receipt)));
        assert.equal(responses.filter(row => row.duplicate === false).length, 1);
        const state = await db.automationBumpFanState.findUnique({ where: { creatorId_fanId: { creatorId, fanId: f.delivery.fanId } } });
        assert.equal(state.counters.sent, 1);
        assert.equal(state.pendingMessageId, f.receipt.messageId);
        assert.equal(await db.automationDelivery.count({ where: { agencyId, actionType: "DELETE_MESSAGE", messageId: f.receipt.messageId } }), 1);
        await assert.rejects(() => completeActionMessageWithSettlementToken({ ...f.receipt, messageId: "another-message" }), { code: "ACTION_MESSAGE_SETTLEMENT_CONFLICT" });
      }
    });

    await t.test("a failed settlement and a new reconciliation lease retain the original exact receipt authority", async () => {
      const f = await prepare();
      const failed = await failActionDelivery({ ...f.lease, failureCode: "send_result_unknown", result: { phase: "send", messageSettlement: { tokenHash: "client-cannot-replace-grant" } } });
      assert.equal(failed.delivery.status, "RECONCILE_REQUIRED");
      assert.equal(failed.delivery.result.messageSettlement.tokenHash, createHash("sha256").update(f.receipt.settlementToken).digest("hex"));
      // The original lease has gone. A different device now owns readback;
      // settlement still binds the original physical write, never this lease.
      await db.automationDelivery.update({ where: { id: f.delivery.id }, data: {
        status: "RUNNING", claimedByDeviceId: "another-device", leaseRevision: { increment: 1 }, leaseTokenHash: "replacement-lease", claimUntil: new Date(Date.now() + 60000),
      } });
      assert.equal((await completeActionMessageWithSettlementToken(f.receipt)).duplicate, false);
      const row = await db.automationDelivery.findUnique({ where: { id: f.delivery.id } });
      assert.equal(row.status, "COMPLETED"); assert.equal(row.failureCategory, null); assert.equal(row.leaseTokenHash, null);
    });

    await t.test("legacy lease completion preserves a minted grant for an exact receipt replay", async () => {
      const f = await prepare();
      await completeActionDelivery({ ...f.lease, result: { messageId: f.receipt.messageId, sentAt: f.receipt.sentAt,
        messageOwnership: { kind: "PROVIDER_SEND_ACK", operationId: f.receipt.operationId, messageId: f.receipt.messageId }, messageSettlement: {} } });
      assert.equal((await completeActionMessageWithSettlementToken(f.receipt)).duplicate, true);
    });

    await t.test("an outcome read before prepare cannot overwrite the newer COMMITTING generation", async () => {
      for (const outcome of ["failure", "completion"]) {
        const f = await makeDelivery(), delegate = db.automationDelivery;
        const original = delegate.findUnique;
        let resume, seen, paused = false;
        const gate = new Promise(resolve => { resume = resolve; });
        const loaded = new Promise(resolve => { seen = resolve; });
        delegate.findUnique = async function (...args) {
          const row = await original.apply(this, args);
          if (!paused && args[0]?.where?.id === f.delivery.id && row.status === "RUNNING") {
            paused = true; seen(); await gate;
          }
          return row;
        };
        let pending, grant;
        const messageId = "9920920" + String(index).padStart(3, "0");
        try {
          pending = outcome === "failure"
            ? failActionDelivery({ ...f.lease, failureCode: "send_failed", retryable: true })
            : completeActionDelivery({ ...f.lease, result: { messageId, sentAt: new Date().toISOString(),
              messageOwnership: { kind: "PROVIDER_SEND_ACK", operationId: f.delivery.idempotencyKey, messageId } } });
          // Attach the rejection assertion before releasing the controlled read.
          const rejected = assert.rejects(pending, { code: "DELIVERY_LEASE_STALE" });
          await loaded;
          grant = await prepareWriteActionDelivery({ ...f.lease, messageSettlementVersion: 1 });
          resume(); await rejected;
        } finally { resume(); delegate.findUnique = original; }
        const row = await db.automationDelivery.findUnique({ where: { id: f.delivery.id } });
        assert.equal(row.status, "COMMITTING");
        assert.equal(row.result.messageSettlement.tokenHash, createHash("sha256").update(grant.settlementToken).digest("hex"));
        assert.equal(await db.automationDelivery.count({ where: { agencyId, actionType: "DELETE_MESSAGE", fanId: f.delivery.fanId } }), 0);
        await completeActionMessageWithSettlementToken({ authorityVersion: AUTHORITY_VERSION, deliveryId: row.id, deviceId,
          operationId: row.idempotencyKey, writeCommitRevision: grant.writeCommitRevision,
          settlementToken: grant.settlementToken, messageId, sentAt: new Date().toISOString() });
      }
    });

    await t.test("an aborted commit cannot leave a usable receipt capability", async () => {
      const f = await makeDelivery();
      let token;
      await assert.rejects(() => runDbTransaction(db, async tx => {
        await tx.$executeRawUnsafe("SELECT set_config('onlinod.phase3_fan_consumer_generation',$1,true)", "phase3_fan_consumer_v1_current_bounded");
        const row = await tx.automationDelivery.update({ where: { id: f.delivery.id }, data: { status: "COMMITTING", writeCommitAt: new Date(), writeCommitRevision: { increment: 1 } } });
        token = (await mintActionMessageSettlement({ db: tx, delivery: row, deviceId })).settlementToken;
        throw new Error("fixture rollback");
      }), /fixture rollback/);
      const row = await db.automationDelivery.findUnique({ where: { id: f.delivery.id } });
      assert.equal(row.status, "RUNNING"); assert.equal(row.writeCommitRevision, 0); assert.equal(row.result.messageSettlement, undefined);
      await assert.rejects(() => completeActionMessageWithSettlementToken({ authorityVersion: AUTHORITY_VERSION, deliveryId: row.id,
        deviceId, operationId: row.idempotencyKey, writeCommitRevision: 1, settlementToken: token, messageId: "9920910998", sentAt: new Date().toISOString() }), { code: "ACTION_MESSAGE_SETTLEMENT_BINDING_INVALID" });
      await db.automationDelivery.update({ where: { id: row.id }, data: { status: "CANCELED", claimUntil: null, leaseTokenHash: null } });
    });

    await t.test("HTTP replay needs no current login after the unresolved window and member retirement", async () => {
      const f = await prepare();
      await db.automationDelivery.update({ where: { id: f.delivery.id }, data: { status: "FAILED", failureCode: "outcome_unresolved_do_not_retry",
        failureCategory: "OUTCOME_UNKNOWN_RECONCILE", leaseTokenHash: null, leaseRevision: { increment: 3 },
        result: { ...(await db.automationDelivery.findUnique({ where: { id: f.delivery.id } })).result, outcomeState: "UNRESOLVED_DO_NOT_RETRY" } } });
      const currentMember = await db.agencyMember.findUnique({ where: { id: memberId } });
      const actorMember = await db.agencyMember.findUnique({ where: { id: remainingOwnerMemberId } });
      await require("./team-administration-service").removeMember({ db, agencyId, memberId,
        expectedRevision: currentMember.editRevision, actorMember, actorUserId: remainingOwnerId });
      const retired = await db.agencyMember.findUnique({ where: { id: memberId } });
      assert(retired.deletedAt instanceof Date); assert.equal(retired.accessEpoch, 2);
      const express = require("express"), app = express();
      app.use(express.json()); app.use("/receipt", require("../routes/automation-action-settlement"));
      server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
      const { deliveryId, ...body } = f.receipt;
      const url = `http://127.0.0.1:${server.address().port}/receipt/${deliveryId}/complete`;
      for (const duplicate of [false, true]) {
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(response.status, 200); const value = await response.json();
        assert.equal(value.duplicate, duplicate); assert.equal(value.deliveryId, deliveryId); assert.equal(value.messageId, body.messageId);
      }
      const invalid = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, settlementToken: randomUUID() }) });
      assert.equal(invalid.status, 403);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      await db.automationBumpFanState.deleteMany({ where: { agencyId } });
      await db.bumpDeliveryStat.deleteMany({ where: { agencyId } });
      await db.automationDelivery.deleteMany({ where: { agencyId } });
      await withFixtureAuthorities(db, { creator: true }, tx => tx.creatorAccount.deleteMany({ where: { agencyId } }));
      await db.agencyCreatorCatalogState.deleteMany({ where: { agencyId } });
      await cleanupAgencyFixture(db, { agencyId, userIds: [userId, remainingOwnerId] });
    } finally { await db.$disconnect(); }
  }
});
