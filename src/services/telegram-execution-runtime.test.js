"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RUNTIME_LEASE_MS,
  eligibleTelegramExecutionAccounts,
  assertTelegramMessagingAccess,
  claimTelegramExecutionRuntimes,
  assertTelegramRuntimeLease,
  assertTelegramInboundRuntimeLease,
  releaseTelegramExecutionRuntime,
} = require("./telegram-execution-runtime");

function makeDb({ sourceSubmissions = [], deliveryIntents = [], customOrders = [] } = {}) {
  const creators = [
    { id: "creator-1", agencyId: "agency-1", telegramContact: "@model_a", telegramAccountId: "tg-1", deletedAt: null, displayName: "A", username: "a", status: "READY" },
    { id: "creator-2", agencyId: "agency-1", telegramContact: "@model_b", telegramAccountId: "tg-2", deletedAt: null, displayName: "B", username: "b", status: "READY" },
    { id: "creator-3", agencyId: "agency-1", telegramContact: "@model_c", telegramAccountId: null, deletedAt: null, displayName: "C", username: "c", status: "READY" },
  ];
  const accounts = [
    { id: "tg-1", agencyId: "agency-1", lifecycleState: "ACTIVE", retirementDrainCompletedAt: null, runtimeClaimedByDeviceId: null, runtimeClaimToken: null, runtimeClaimUntil: null, runtimeLeaseUserId: null, runtimeLeaseMemberId: null, runtimeLeaseAccessEpoch: null, runtimeLeaseCreatorId: null, runtimeClaimGeneration: 0, runtimeDrainedGeneration: 0, runtimeClaimInboundEligible: false },
    { id: "tg-2", agencyId: "agency-1", lifecycleState: "ACTIVE", retirementDrainCompletedAt: null, runtimeClaimedByDeviceId: null, runtimeClaimToken: null, runtimeClaimUntil: null, runtimeLeaseUserId: null, runtimeLeaseMemberId: null, runtimeLeaseAccessEpoch: null, runtimeLeaseCreatorId: null, runtimeClaimGeneration: 0, runtimeDrainedGeneration: 0, runtimeClaimInboundEligible: false },
  ];
  const matchCreator = (row, where = {}) => {
    if (where.id && typeof where.id === "string" && row.id !== where.id) return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (where.agencyId && row.agencyId !== where.agencyId) return false;
    if (where.deletedAt === null && row.deletedAt !== null) return false;
    if (where.telegramContact?.not === null && row.telegramContact === null) return false;
    return true;
  };
  const matchAccount = (row, where = {}) => {
    if (where.id && row.id !== where.id) return false;
    if (where.agencyId && row.agencyId !== where.agencyId) return false;
    if (where.lifecycleState && row.lifecycleState !== where.lifecycleState) return false;
    if (where.runtimeLeaseUserId !== undefined && row.runtimeLeaseUserId !== where.runtimeLeaseUserId) return false;
    if (where.runtimeLeaseMemberId !== undefined && row.runtimeLeaseMemberId !== where.runtimeLeaseMemberId) return false;
    if (where.runtimeLeaseAccessEpoch !== undefined && row.runtimeLeaseAccessEpoch !== where.runtimeLeaseAccessEpoch) return false;
    if (Array.isArray(where.OR) && !where.OR.some((candidate) => {
      if (candidate.lifecycleState !== undefined) return candidate.lifecycleState === null ? row.lifecycleState == null : String(row.lifecycleState || "ACTIVE") === String(candidate.lifecycleState);
      if (candidate.runtimeClaimUntil === null) return row.runtimeClaimUntil === null;
      if (candidate.runtimeClaimUntil?.lt) return row.runtimeClaimUntil && new Date(row.runtimeClaimUntil) < new Date(candidate.runtimeClaimUntil.lt);
      if (candidate.runtimeClaimedByDeviceId !== undefined) return row.runtimeClaimedByDeviceId === candidate.runtimeClaimedByDeviceId;
      return false;
    })) return false;
    if (where.runtimeClaimedByDeviceId !== undefined && row.runtimeClaimedByDeviceId !== where.runtimeClaimedByDeviceId) return false;
    if (where.runtimeClaimToken !== undefined && row.runtimeClaimToken !== where.runtimeClaimToken) return false;
    if (where.runtimeClaimGeneration !== undefined && Number(row.runtimeClaimGeneration || 0) !== Number(where.runtimeClaimGeneration)) return false;
    if (where.runtimeDrainedGeneration !== undefined && Number(row.runtimeDrainedGeneration || 0) !== Number(where.runtimeDrainedGeneration)) return false;
    return true;
  };
  const member = { id: "member-1", userId: "user-1", agencyId: "agency-1", role: "OPERATOR", roleKey: "chatter", assignedCreators: ["creator-1"], accessEpoch: 1, deletedAt: null, deactivatedAt: null };
  return {
    _accounts: accounts,
    _creators: creators,
    _member: member,
    agencyMember: { async findFirst({ where }) { return where.id === member.id && where.userId === member.userId && where.agencyId === member.agencyId ? { ...member } : null; } },
    creatorAccount: {
      async findMany({ where }) { return creators.filter((row) => matchCreator(row, where)).map((row) => ({ ...row })); },
      async findFirst({ where }) { return creators.find((row) => matchCreator(row, where)) || null; },
    },
    customOrder: {
      async findMany({ where }) {
        return customOrders.filter((row) => {
          if (where.agencyId && row.agencyId !== where.agencyId) return false;
          if (where.id?.in && !where.id.in.includes(row.id)) return false;
          if (where.status && row.status !== where.status) return false;
          return true;
        }).map((row) => ({ ...row }));
      },
    },
    customContentSubmission: {
      async findMany({ where, take = 1000 }) {
        return sourceSubmissions.filter((row) => {
          if (row.agencyId !== where.agencyId) return false;
          if (where.creatorId?.in && !where.creatorId.in.includes(row.creatorId)) return false;
          if (where.telegramSourceAccountId?.not === null && row.telegramSourceAccountId == null) return false;
          if (where.telegramSourceUserId?.not === null && row.telegramSourceUserId == null) return false;
          return true;
        }).slice(0, take).map((row) => ({ ...row }));
      },
    },
    telegramDeliveryIntent: {
      async findMany({ where, take = 1000 }) {
        return deliveryIntents.filter((row) => {
          if (row.agencyId !== where.agencyId) return false;
          if (where.creatorId?.in && !where.creatorId.in.includes(row.creatorId)) return false;
          if (typeof where.kind === "string" && row.kind !== where.kind) return false;
          if (where.kind?.in && !where.kind.in.includes(row.kind)) return false;
          if (typeof where.state === "string" && row.state !== where.state) return false;
          if (where.state?.in && !where.state.in.includes(row.state)) return false;
          if (where.remoteMessageId?.not === null && row.remoteMessageId == null) return false;
          if (where.remoteRecipientTelegramUserId?.not === null && row.remoteRecipientTelegramUserId == null) return false;
          return true;
        }).slice(0, take).map((row) => ({ ...row }));
      },
    },
    agencyTelegramMtprotoAccount: {
      async findMany({ where }) { return accounts.filter((row) => matchAccount(row, where)).map((row) => ({ ...row })); },
      async findFirst({ where }) { const row = accounts.find((candidate) => matchAccount(candidate, where)); return row ? { ...row } : null; },
      async updateMany({ where, data }) {
        const row = accounts.find((candidate) => matchAccount(candidate, where));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
}

const chatterA = { id: "member-1", userId: "user-1", agencyId: "agency-1", role: "OPERATOR", roleKey: "chatter", assignedCreators: ["creator-1"], accessEpoch: 1 };

test("Telegram runtime eligibility is creator-scoped instead of role-scoped", async () => {
  const db = makeDb();
  const eligible = await eligibleTelegramExecutionAccounts({ agencyId: "agency-1", member: chatterA, db });
  assert.deepEqual(eligible, [{ accountId: "tg-1", anchorCreatorId: "creator-1", messagingEligible: true, inboundEligible: true }]);

  const access = await assertTelegramMessagingAccess({ agencyId: "agency-1", member: chatterA, accountId: "tg-1", creatorId: "creator-1", db });
  assert.equal(access.accountId, "tg-1");
  await assert.rejects(
    () => assertTelegramMessagingAccess({ agencyId: "agency-1", member: chatterA, accountId: "tg-2", creatorId: "creator-1", db }),
    (error) => error?.code === "TELEGRAM_EXECUTION_ACCOUNT_FORBIDDEN" && error?.status === 403,
  );
  await assert.rejects(
    () => assertTelegramMessagingAccess({ agencyId: "agency-1", member: chatterA, accountId: "tg-2", creatorId: "creator-2", db }),
    (error) => error?.code === "CREATOR_ACCESS_FORBIDDEN" && error?.status === 403,
  );
});


test("pending Customs source account remains runtime-eligible after creator Telegram account reassignment without widening send authority", async () => {
  const db = makeDb({ sourceSubmissions: [{
    id: "submission-1", agencyId: "agency-1", creatorId: "creator-1", telegramSourceAccountId: "tg-1", telegramSourceUserId: "987654321012345678",
    telegramMessageIds: [501], ofMediaIds: [],
  }] });
  db._creators[0].telegramAccountId = "tg-2";
  const eligible = await eligibleTelegramExecutionAccounts({ agencyId: "agency-1", member: chatterA, db });
  assert.deepEqual(eligible, [
    { accountId: "tg-2", anchorCreatorId: "creator-1", messagingEligible: true, inboundEligible: true },
    { accountId: "tg-1", anchorCreatorId: "creator-1", messagingEligible: false, inboundEligible: false },
  ]);
  await assert.rejects(
    () => assertTelegramMessagingAccess({ agencyId: "agency-1", member: chatterA, accountId: "tg-1", creatorId: "creator-1", db }),
    (error) => error?.code === "TELEGRAM_EXECUTION_ACCOUNT_FORBIDDEN",
    "historical source-read eligibility must not make the old account valid for normal Telegram messaging writes",
  );
  const claimed = await claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: chatterA, deviceId: "device-source", accountId: "tg-1", limit: 1, now: new Date("2026-08-19T14:00:00.000Z"), db });
  assert.deepEqual(claimed.leases.map((lease) => lease.accountId), ["tg-1"]);
  assert.equal(claimed.leases[0].messagingEligible, false, "historical source account lease must stay explicitly read-only for messaging writes");
  assert.equal(claimed.leases[0].inboundEligible, false, "source-read-only lease must not accept new provider observations");
  await assert.rejects(
    () => assertTelegramInboundRuntimeLease({ agencyId: "agency-1", member: chatterA, accountId: "tg-1", deviceId: "device-source", claimToken: claimed.leases[0].claimToken, now: new Date("2026-08-19T14:00:01.000Z"), db }),
    (error) => error?.code === "TELEGRAM_INBOUND_ACCOUNT_FORBIDDEN" && error?.status === 403,
  );
});

test("confirmed TASK thread and active follow-up keep the old account runtime-eligible without restoring generic messaging or inbound", async () => {
  const db = makeDb({ deliveryIntents: [
    { id: "task-1", agencyId: "agency-1", creatorId: "creator-1", accountId: "tg-1", kind: "TASK", state: "CONFIRMED", remoteMessageId: 501, remoteRecipientTelegramUserId: "1001" },
    { id: "ref-1", agencyId: "agency-1", creatorId: "creator-1", accountId: "tg-1", kind: "REFERENCE", state: "PLANNED" },
  ] });
  db._creators[0].telegramAccountId = "tg-2";
  const eligible = await eligibleTelegramExecutionAccounts({ agencyId: "agency-1", member: chatterA, db });
  assert.deepEqual(eligible, [
    { accountId: "tg-2", anchorCreatorId: "creator-1", messagingEligible: true, inboundEligible: true },
    { accountId: "tg-1", anchorCreatorId: "creator-1", messagingEligible: false, inboundEligible: false },
  ]);
  const claimed = await claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: chatterA, deviceId: "device-followup", accountId: "tg-1", limit: 1, now: new Date("2026-08-19T14:00:00.000Z"), db });
  assert.equal(claimed.leases[0].messagingEligible, false);
  assert.equal(claimed.leases[0].inboundEligible, false);
  await assert.rejects(
    () => assertTelegramMessagingAccess({ agencyId: "agency-1", member: chatterA, accountId: "tg-1", creatorId: "creator-1", db }),
    (error) => error?.code === "TELEGRAM_EXECUTION_ACCOUNT_FORBIDDEN",
  );
  await assert.rejects(
    () => assertTelegramInboundRuntimeLease({ agencyId: "agency-1", member: chatterA, accountId: "tg-1", deviceId: "device-followup", claimToken: claimed.leases[0].claimToken, now: new Date("2026-08-19T14:00:01.000Z"), db }),
    (error) => error?.code === "TELEGRAM_INBOUND_ACCOUNT_FORBIDDEN",
  );
});

test("undrained runtime generation never transfers to another Desktop after TTL; drained release enables a new generation", async () => {
  const db = makeDb();
  const start = new Date("2026-08-19T14:00:00.000Z");
  const first = await claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: chatterA, deviceId: "device-a", now: start, db });
  assert.equal(first.leases.length, 1);
  assert.equal(first.leases[0].accountId, "tg-1");
  assert.equal(first.leases[0].anchorCreatorId, "creator-1");
  assert.equal(first.leases[0].messagingEligible, true);
  assert.equal(db._accounts[0].runtimeClaimGeneration, 1);
  assert.equal(db._accounts[0].runtimeDrainedGeneration, 0);
  assert.equal(new Date(first.leases[0].claimUntil).getTime() - start.getTime(), RUNTIME_LEASE_MS);
  const token = first.leases[0].claimToken;

  const blocked = await claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: chatterA, deviceId: "device-b", now: new Date(start.getTime() + 30_000), db });
  assert.deepEqual(blocked.leases, []);

  const renewed = await claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: chatterA, deviceId: "device-a", now: new Date(start.getTime() + 30_000), db });
  assert.equal(renewed.leases.length, 1);
  assert.equal(renewed.leases[0].claimToken, token, "same device should keep one stable lease token while it remains live");
  assert.equal(db._accounts[0].runtimeClaimGeneration, 1, "renewal must not invent a second ownership generation");

  const afterExpiry = new Date(start.getTime() + 30_000 + RUNTIME_LEASE_MS + 1);
  const stillBlocked = await claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: chatterA, deviceId: "device-b", now: afterExpiry, db });
  assert.deepEqual(stillBlocked.leases, [], "TTL expiry cannot prove the previous Desktop durable outbox was drained");

  const resumed = await claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: chatterA, deviceId: "device-a", now: afterExpiry, db });
  assert.equal(resumed.leases.length, 1);
  assert.equal(resumed.leases[0].claimToken, token, "same signed owner resumes the undrained generation");
  assert.equal(db._accounts[0].runtimeClaimGeneration, 1);
  const drainedAt = new Date(afterExpiry.getTime() + 1_000);
  const drained = await releaseTelegramExecutionRuntime({ agencyId: "agency-1", member: chatterA, accountId: "tg-1", deviceId: "device-a", claimToken: token, drained: true, now: drainedAt, db });
  assert.equal(drained.drained, true);
  assert.equal(db._accounts[0].runtimeDrainedGeneration, 1);
  assert.equal(db._accounts[0].runtimeClaimedByDeviceId, null);

  const failover = await claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: chatterA, deviceId: "device-b", now: new Date(drainedAt.getTime() + 1), db });
  assert.equal(failover.leases.length, 1);
  assert.notEqual(failover.leases[0].claimToken, token);
  assert.equal(db._accounts[0].runtimeClaimGeneration, 2);
  assert.equal(db._accounts[0].runtimeDrainedGeneration, 1);
});

test("runtime release is scoped to the current device/token and cannot release another Desktop lease", async () => {
  const db = makeDb();
  const now = new Date("2026-08-19T14:00:00.000Z");
  const claim = await claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: chatterA, deviceId: "device-a", now, db });
  const lease = claim.leases[0];
  await assert.rejects(
    () => releaseTelegramExecutionRuntime({ agencyId: "agency-1", member: chatterA, accountId: "tg-1", deviceId: "device-b", claimToken: lease.claimToken, now, db }),
    (error) => error?.code === "TELEGRAM_EXECUTION_LEASE_INVALID",
  );
  const right = await releaseTelegramExecutionRuntime({ agencyId: "agency-1", member: chatterA, accountId: "tg-1", deviceId: "device-a", claimToken: lease.claimToken, now, db });
  assert.equal(right.released, true);
  assert.equal(right.drained, false);
  assert.equal(db._accounts[0].runtimeClaimUntil, null);
  assert.equal(db._accounts[0].runtimeClaimedByDeviceId, "device-a", "ordinary release preserves the undrained owner identity");
  assert.equal(db._accounts[0].runtimeClaimGeneration, 1);
  assert.equal(db._accounts[0].runtimeDrainedGeneration, 0);
});

test("Audit16 Telegram runtime lease is rejected after accessEpoch or creator authority changes", async () => {
  const db = makeDb();
  const now = new Date("2026-08-19T14:00:00.000Z");
  const claim = await claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: chatterA, deviceId: "device-a", now, db });
  const lease = claim.leases[0];
  assert.ok(lease?.claimToken);

  db._member.accessEpoch = chatterA.accessEpoch + 1;
  await assert.rejects(
    () => assertTelegramRuntimeLease({ agencyId: "agency-1", member: chatterA, accountId: "tg-1", deviceId: "device-a", claimToken: lease.claimToken, now: new Date(now.getTime() + 1_000), db }),
    (error) => error?.code === "EXECUTION_ACCESS_EPOCH_STALE" && error?.status === 409,
  );

  db._member.accessEpoch = chatterA.accessEpoch;
  db._member.assignedCreators = [];
  await assert.rejects(
    () => assertTelegramRuntimeLease({ agencyId: "agency-1", member: chatterA, accountId: "tg-1", deviceId: "device-a", claimToken: lease.claimToken, now: new Date(now.getTime() + 2_000), db }),
    (error) => error?.code === "EXECUTION_CREATOR_ACCESS_REVOKED" && error?.status === 403,
  );
});

test("Audit16 targeted Telegram claim acquires only the requested eligible account", async () => {
  const db = makeDb();
  const owner = { id: "member-1", userId: "user-1", agencyId: "agency-1", role: "OWNER", roleKey: "owner", assignedCreators: "all", accessEpoch: 1 };
  db._member.role = "OWNER";
  db._member.roleKey = "owner";
  db._member.assignedCreators = "all";
  const now = new Date("2026-08-19T14:00:00.000Z");
  const targeted = await claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: owner, deviceId: "device-a", accountId: "tg-2", limit: 1, now, db });
  assert.deepEqual(targeted.leases.map((lease) => lease.accountId), ["tg-2"]);
  assert.equal(db._accounts[0].runtimeClaimedByDeviceId, null, "targeted claim must not opportunistically take another Telegram account");
  assert.equal(db._accounts[1].runtimeClaimedByDeviceId, "device-a");

  await assert.rejects(
    () => claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: chatterA, deviceId: "device-a", accountId: "tg-2", limit: 1, now, db: makeDb() }),
    (error) => error?.code === "TELEGRAM_EXECUTION_ACCOUNT_FORBIDDEN" && error?.status === 403,
  );
});

test("completed historical TASK without active follow-up or source work does not keep an old Telegram runtime alive", async () => {
  const db = makeDb({
    deliveryIntents: [{ id: "task-old", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-old", accountId: "tg-1", kind: "TASK", state: "CONFIRMED", remoteMessageId: 501, remoteRecipientTelegramUserId: "1001" }],
    customOrders: [{ id: "order-old", agencyId: "agency-1", creatorId: "creator-1", status: "COMPLETED" }],
  });
  db._creators[0].telegramAccountId = "tg-2";
  const eligible = await eligibleTelegramExecutionAccounts({ agencyId: "agency-1", member: chatterA, db });
  assert.deepEqual(eligible, [{ accountId: "tg-2", anchorCreatorId: "creator-1", messagingEligible: true, inboundEligible: true }]);
});

test("pending confirmed TASK thread keeps the old Telegram account runtime-eligible until the Custom thread is terminal", async () => {
  const db = makeDb({
    deliveryIntents: [{ id: "task-live", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-live", accountId: "tg-1", kind: "TASK", state: "CONFIRMED", remoteMessageId: 601, remoteRecipientTelegramUserId: "1001" }],
    customOrders: [{ id: "order-live", agencyId: "agency-1", creatorId: "creator-1", status: "PENDING" }],
  });
  db._creators[0].telegramAccountId = "tg-2";
  const eligible = await eligibleTelegramExecutionAccounts({ agencyId: "agency-1", member: chatterA, db });
  assert.deepEqual(eligible, [
    { accountId: "tg-2", anchorCreatorId: "creator-1", messagingEligible: true, inboundEligible: true },
    { accountId: "tg-1", anchorCreatorId: "creator-1", messagingEligible: false, inboundEligible: true },
  ]);
  const claimed = await claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: chatterA, deviceId: "device-old-thread", accountId: "tg-1", limit: 1, now: new Date("2026-09-05T12:00:00.000Z"), db });
  assert.equal(claimed.leases[0].messagingEligible, false, "old pinned thread must not restore generic outbound messaging authority");
  assert.equal(claimed.leases[0].inboundEligible, true, "old pinned active thread must retain inbound Reply capability");
  const inbound = await assertTelegramInboundRuntimeLease({ agencyId: "agency-1", member: chatterA, accountId: "tg-1", deviceId: "device-old-thread", claimToken: claimed.leases[0].claimToken, now: new Date("2026-09-05T12:00:01.000Z"), db });
  assert.equal(inbound.inboundEligible, true);
});

test("RETIRING runtime can be reclaimed only by the same signed owner and drained release is explicit", async () => {
  const db = makeDb();
  const start = new Date("2026-09-05T12:00:00.000Z");
  const first = await claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: chatterA, deviceId: "device-a", accountId: "tg-1", limit: 1, now: start, db });
  const lease = first.leases[0];
  assert.ok(lease?.claimToken);
  Object.assign(db._accounts[0], { lifecycleState: "RETIRING", retirementDrainCompletedAt: null });
  const afterExpiry = new Date(start.getTime() + RUNTIME_LEASE_MS + 1);
  const other = await claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: chatterA, deviceId: "device-b", accountId: "tg-1", limit: 1, now: afterExpiry, db }).catch((error) => error);
  assert.equal(other?.code, "TELEGRAM_EXECUTION_ACCOUNT_FORBIDDEN", "retirement must never transfer drain ownership to another Desktop");
  const resumed = await claimTelegramExecutionRuntimes({ agencyId: "agency-1", member: chatterA, deviceId: "device-a", accountId: "tg-1", limit: 1, now: afterExpiry, db });
  assert.equal(resumed.leases.length, 1);
  assert.equal(resumed.leases[0].retiring, true);
  assert.equal(resumed.leases[0].claimToken, lease.claimToken);
  const released = await releaseTelegramExecutionRuntime({ agencyId: "agency-1", member: chatterA, accountId: "tg-1", deviceId: "device-a", claimToken: lease.claimToken, drained: true, now: new Date(afterExpiry.getTime() + 1000), db });
  assert.equal(released.retirementDrained, true);
  assert.equal(db._accounts[0].runtimeClaimedByDeviceId, null);
  assert.ok(db._accounts[0].retirementDrainCompletedAt instanceof Date);
});


test("undrained ACTIVE runtime survives loss of normal eligibility only as same-owner drain-only replay capability", async () => {
  const db = makeDb();
  const start = new Date("2026-09-05T16:00:00.000Z");
  const first = await claimTelegramExecutionRuntimes({
    agencyId: "agency-1", member: chatterA, deviceId: "device-a", accountId: "tg-1", limit: 1, now: start, db,
  });
  const token = first.leases[0]?.claimToken;
  assert.ok(token);
  assert.equal(first.leases[0].inboundEligible, true);
  assert.equal(first.leases[0].drainOnly, false);

  // Ordinary shutdown cannot certify the local SQLite outbox as drained.
  const released = await releaseTelegramExecutionRuntime({
    agencyId: "agency-1", member: chatterA, accountId: "tg-1", deviceId: "device-a", claimToken: token,
    drained: false, now: new Date(start.getTime() + 1_000), db,
  });
  assert.equal(released.drained, false);
  assert.equal(db._accounts[0].runtimeClaimGeneration, 1);
  assert.equal(db._accounts[0].runtimeDrainedGeneration, 0);

  // Server-visible business eligibility moves away while a durable provider observation may still
  // exist only in this Desktop's SQLite. The old account must not become generic work again.
  db._creators[0].telegramAccountId = "tg-2";
  const normal = await eligibleTelegramExecutionAccounts({ agencyId: "agency-1", member: chatterA, db });
  assert.deepEqual(normal, [{ accountId: "tg-2", anchorCreatorId: "creator-1", messagingEligible: true, inboundEligible: true }]);

  const other = await claimTelegramExecutionRuntimes({
    agencyId: "agency-1", member: chatterA, deviceId: "device-b", accountId: "tg-1", limit: 1,
    now: new Date(start.getTime() + RUNTIME_LEASE_MS + 2_000), db,
  }).catch((error) => error);
  assert.equal(other?.code, "TELEGRAM_EXECUTION_ACCOUNT_FORBIDDEN", "undrained local durability must never transfer to another Desktop");

  const resumed = await claimTelegramExecutionRuntimes({
    agencyId: "agency-1", member: chatterA, deviceId: "device-a", accountId: "tg-1", limit: 1,
    now: new Date(start.getTime() + RUNTIME_LEASE_MS + 2_000), db,
  });
  assert.equal(resumed.leases.length, 1);
  assert.equal(resumed.leases[0].claimToken, token);
  assert.equal(resumed.leases[0].messagingEligible, false);
  assert.equal(resumed.leases[0].inboundEligible, false, "drain-only recovery cannot accept new helper observations");
  assert.equal(resumed.leases[0].durableReplayEligible, true, "same owner may replay only already-durable inbound observations");
  assert.equal(resumed.leases[0].drainOnly, true);

  const replay = await assertTelegramInboundRuntimeLease({
    agencyId: "agency-1", member: chatterA, accountId: "tg-1", deviceId: "device-a", claimToken: token,
    now: new Date(start.getTime() + RUNTIME_LEASE_MS + 2_001), db,
  });
  assert.equal(replay.inboundEligible, false);
  assert.equal(replay.durableReplayEligible, true);
  assert.equal(replay.drainOnly, true);

  await assert.rejects(
    () => assertTelegramMessagingAccess({ agencyId: "agency-1", member: chatterA, accountId: "tg-1", creatorId: "creator-1", db }),
    (error) => error?.code === "TELEGRAM_EXECUTION_ACCOUNT_FORBIDDEN",
    "drain-only replay must not restore generic outbound messaging authority",
  );

  const drained = await releaseTelegramExecutionRuntime({
    agencyId: "agency-1", member: chatterA, accountId: "tg-1", deviceId: "device-a", claimToken: token,
    drained: true, now: new Date(start.getTime() + RUNTIME_LEASE_MS + 3_000), db,
  });
  assert.equal(drained.drained, true);
  assert.equal(db._accounts[0].runtimeDrainedGeneration, 1);
  assert.equal(db._accounts[0].runtimeClaimedByDeviceId, null);
});
