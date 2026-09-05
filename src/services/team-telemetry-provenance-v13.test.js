"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaPath = require.resolve("../prisma");
const ledgerPath = require.resolve("./team-ppv-ledger-service");
const projectionPath = require.resolve("./team-response-projection-service");
const servicePath = require.resolve("./telemetry-ingest-service");

function loadService({ failSideEffects = 0, failCreatorLookup = false, assignedCreators = undefined } = {}) {
  const created = [];
  const rows = [];
  const sideEffects = [];
  const projections = [];
  const sideEffectState = { failuresRemaining: failSideEffects };
  const authority = { accessEpoch: 1, assignedCreators, afterCommit: null, transactions: 0 };
  const prisma = {
    async $transaction(work) {
      const snapshot = rows.map((row) => ({ ...row }));
      try {
        const result = await work(prisma);
        authority.transactions += 1;
        if (typeof authority.afterCommit === "function") authority.afterCommit(authority.transactions);
        return result;
      } catch (error) {
        rows.splice(0, rows.length, ...snapshot);
        throw error;
      }
    },
    workerDevice: {
      async findFirst({ where }) { return ["device-1", "device-2"].includes(where.id) ? { id: where.id } : null; },
    },
    creatorAccount: {
      async findFirst({ where }) {
        if (failCreatorLookup) throw new Error("synthetic creator lookup failure");
        if (where.agencyId !== "agency-1") return null;
        if (where.id === "creator-1") return { id: "creator-1", username: "creator", remoteId: "123" };
        return null;
      },
    },
    agencyMember: {
      async findFirst({ where }) {
        if (where.agencyId !== "agency-1") return null;
        if (where.id === "member-1" && (!where.userId || where.userId === "user-1")) return {
          id: "member-1", userId: "user-1", agencyId: "agency-1", accessEpoch: authority.accessEpoch,
          role: "CHATTER", roleKey: "chatter", assignedCreators: authority.assignedCreators, permissions: {},
        };
        if (where.userId === "user-1") return {
          id: "member-1", userId: "user-1", agencyId: "agency-1", accessEpoch: authority.accessEpoch,
          role: "CHATTER", roleKey: "chatter", assignedCreators: authority.assignedCreators, permissions: {},
        };
        return null;
      },
    },
    teamActivityEvent: {
      async findFirst({ where }) {
        return rows.find((row) => row.agencyId === where.agencyId
          && (where.deviceId === undefined || row.deviceId === where.deviceId)
          && row.localId === where.localId) || null;
      },
      async create({ data }) {
        const row = { id: `event-${rows.length + 1}`, ...data };
        rows.push(row);
        created.push(row);
        return row;
      },
    },
  };

  delete require.cache[servicePath];
  delete require.cache[prismaPath];
  delete require.cache[ledgerPath];
  delete require.cache[projectionPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma };
  require.cache[ledgerPath] = {
    id: ledgerPath,
    filename: ledgerPath,
    loaded: true,
    exports: { async applyLedgerSideEffects(row) {
      sideEffects.push(row);
      if (sideEffectState.failuresRemaining > 0) {
        sideEffectState.failuresRemaining -= 1;
        throw new Error("synthetic ledger failure");
      }
    } },
  };
  require.cache[projectionPath] = {
    id: projectionPath,
    filename: projectionPath,
    loaded: true,
    exports: { async applyTeamResponseProjection(row) { projections.push(row); } },
  };
  const service = require(servicePath);
  return { service, rows, created, sideEffects, projections, sideEffectState, authority };
}

function canonical(overrides = {}) {
  return {
    telemetryVersion: "team_v13_provenance",
    source: "electron_team_v13",
    eventKind: "MESSAGE_SEND_CONFIRMED",
    actionSource: "MANUAL",
    lifecycle: "CONFIRMED",
    creatorId: "creator-1",
    accountId: "creator-1",
    dialogId: "fan-1",
    fanId: "fan-1",
    messageId: "message-1",
    occurredAt: "2026-08-11T20:00:00.000Z",
    localId: "local-1",
    actorMemberId: "member-1",
    actorUserId: "user-1",
    ...overrides,
  };
}

async function ingest(service, events, overrides = {}) {
  return service.ingestTeamEvents({
    agencyId: "agency-1",
    deviceId: "device-1",
    userId: "user-1",
    memberId: "member-1",
    admittedAccessEpoch: 1,
    events,
    ...overrides,
  });
}

test("v13 manual confirmed send uses authenticated actor and relational provenance", async () => {
  const { service, rows, sideEffects } = loadService();
  const result = await ingest(service, [canonical({
    priceCents: 2500,
    currency: "USD",
    isPpv: true,
    mediaCount: 2,
    correlationId: "cdp:1:request-1",
  })]);

  assert.equal(result.inserted, 1);
  assert.equal(result.skipped, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].memberId, "member-1");
  assert.equal(rows[0].userId, "user-1");
  assert.equal(rows[0].eventKind, "MESSAGE_SEND_CONFIRMED");
  assert.equal(rows[0].actionSource, "MANUAL");
  assert.equal(rows[0].lifecycle, "CONFIRMED");
  assert.equal(rows[0].messageId, "message-1");
  assert.equal(rows[0].dialogId, "fan-1");
  assert.equal(rows[0].priceCents, 2500);
  assert.equal(rows[0].isPpv, true);
  assert.equal(rows[0].source, "electron_team_v13");
  assert.equal(sideEffects.length, 1);
});

test("v13 fan incoming is global and never inherits authenticated chatter", async () => {
  const { service, rows } = loadService();
  const result = await ingest(service, [canonical({
    eventKind: "FAN_MESSAGE_RECEIVED",
    actionSource: "SYSTEM",
    lifecycle: "OBSERVED",
    localId: "incoming-1",
    actorMemberId: null,
    actorUserId: null,
  })]);

  assert.equal(result.inserted, 1);
  assert.equal(rows[0].memberId, null);
  assert.equal(rows[0].userId, null);
  assert.equal(rows[0].eventKind, "FAN_MESSAGE_RECEIVED");
});

test("v13 automation send keeps authenticated observer out of human ownership", async () => {
  const { service, rows } = loadService();
  const result = await ingest(service, [canonical({
    actionSource: "AUTOMATION",
    localId: "automation-1",
    automationDeliveryId: "delivery-1",
    messageId: "message-auto-1",
    actorMemberId: null,
    actorUserId: null,
  })]);

  assert.equal(result.inserted, 1);
  assert.equal(rows[0].memberId, null);
  assert.equal(rows[0].userId, null);
  assert.equal(rows[0].automationDeliveryId, "delivery-1");
  assert.equal(rows[0].actionSource, "AUTOMATION");
});


test("v13 rejects actor contamination on non-human incoming/automation facts", async () => {
  const { service, rows } = loadService();
  const result = await ingest(service, [canonical({
    eventKind: "FAN_MESSAGE_RECEIVED",
    actionSource: "SYSTEM",
    lifecycle: "OBSERVED",
    localId: "incoming-contaminated",
  })]);

  assert.equal(result.inserted, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.rejectedByReason.nonhuman_actor_forbidden, 1);
  assert.equal(rows.length, 0);
});

test("v13 rejects an unknown creator instead of storing tenant-orphan provenance", async () => {
  const { service, rows } = loadService();
  const result = await ingest(service, [canonical({
    creatorId: "creator-unknown",
    accountId: "creator-unknown",
    localId: "unknown-creator",
  })]);

  assert.equal(result.inserted, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.rejectedByReason.creator_not_found, 1);
  assert.equal(rows.length, 0);
});

test("v13 creator lookup DB failure propagates so the desktop outbox retries", async () => {
  const { service, rows } = loadService({ failCreatorLookup: true });
  await assert.rejects(
    () => ingest(service, [canonical({ localId: "creator-lookup-retry" })]),
    /synthetic creator lookup failure/
  );
  assert.equal(rows.length, 0);
});

test("v13 rejects spoofed actor instead of attributing another member", async () => {
  const { service, rows } = loadService();
  const result = await ingest(service, [canonical({
    actorMemberId: "member-other",
    localId: "spoof-1",
  })]);

  assert.equal(result.inserted, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.rejectedByReason.human_actor_mismatch, 1);
  assert.equal(rows.length, 0);
});

test("v13 localId replay is idempotent", async () => {
  const { service, rows, sideEffects } = loadService();
  const first = await ingest(service, [canonical({ localId: "same-local" })]);
  const second = await ingest(service, [canonical({ localId: "same-local" })]);

  assert.equal(first.inserted, 1);
  assert.equal(second.inserted, 0);
  assert.equal(second.duplicated, 1);
  assert.equal(rows.length, 1);
  assert.equal(sideEffects.length, 2, "ledger side effect is deliberately replay-safe");
});


test("v13 localId replay projects only the stored durable payload, never mutated replay fields", async () => {
  const { service, rows, sideEffects } = loadService();
  await ingest(service, [canonical({ localId: "immutable-local", messageId: "message-original", priceCents: 1200 })]);
  const replay = await ingest(service, [canonical({ localId: "immutable-local", messageId: "message-mutated", priceCents: 9900 })]);
  assert.equal(replay.duplicated, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageId, "message-original");
  assert.equal(rows[0].priceCents, 1200);
  assert.equal(sideEffects.length, 2);
  assert.equal(sideEffects[1].messageId, "message-original");
  assert.equal(sideEffects[1].priceCents, 1200);
});

test("v13 localId idempotency is device-scoped and does not alias another workstation", async () => {
  const { service, rows } = loadService();
  await ingest(service, [canonical({ localId: "shared-local", messageId: "device-one-message" })]);
  const second = await ingest(service, [canonical({ localId: "shared-local", messageId: "device-two-message" })], { deviceId: "device-2" });
  assert.equal(second.inserted, 1);
  assert.equal(second.duplicated, 0);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.deviceId, row.messageId]), [["device-1", "device-one-message"], ["device-2", "device-two-message"]]);
});

test("v13 event and ownership projections roll back atomically when a side effect fails", async () => {
  const { service, rows, sideEffects } = loadService({ failSideEffects: 1 });

  await assert.rejects(
    () => ingest(service, [canonical({ localId: "retry-side-effect" })]),
    /synthetic ledger failure/
  );
  assert.equal(rows.length, 0, "failed projection rolls back the raw activity event too");

  const retry = await ingest(service, [canonical({ localId: "retry-side-effect" })]);
  assert.equal(retry.inserted, 1);
  assert.equal(retry.duplicated, 0);
  assert.equal(rows.length, 1);
  assert.equal(sideEffects.length, 2, "retry replays the projection only after live authority is revalidated");
});

test("v13 mixed batch returns exact per-row acknowledgement identities", async () => {
  const { service, rows } = loadService();
  const result = await ingest(service, [
    canonical({ localId: "ack-good-1", messageId: "message-good-1" }),
    canonical({ localId: "ack-bad-1", messageId: "message-bad-1", actorMemberId: "member-other" }),
    canonical({ localId: "ack-good-2", messageId: "message-good-2" }),
  ]);

  assert.equal(result.inserted, 2);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.acknowledgedLocalIds.sort(), ["ack-good-1", "ack-good-2"]);
  assert.deepEqual(result.rejectedEvents, [{ localId: "ack-bad-1", reason: "human_actor_mismatch" }]);
  assert.equal(rows.length, 2);
});


test("Audit15 rejects legacy telemetry before durable event or ownership side effects", async () => {
  const { service, rows, sideEffects } = loadService();
  const result = await ingest(service, [{
    type: "ppv_purchase_attributed",
    creatorId: "creator-1",
    memberId: "member-1",
    amountCents: 999_00,
    localId: "legacy-fake-money",
  }]);
  assert.equal(result.inserted, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.rejectedByReason.legacy_telemetry_disabled, 1);
  assert.equal(rows.length, 0);
  assert.equal(sideEffects.length, 0);
});

test("Audit15 rejects v13 provenance for an unassigned creator before durable side effects", async () => {
  const { service, rows, sideEffects } = loadService({ assignedCreators: [] });
  const result = await ingest(service, [canonical({ localId: "unassigned-creator" })]);
  assert.equal(result.inserted, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.rejectedByReason.creator_access_forbidden, 1);
  assert.equal(rows.length, 0);
  assert.equal(sideEffects.length, 0);
});

test("Audit15 accessEpoch change between batch events fences remaining stale telemetry", async () => {
  const { service, rows, authority } = loadService({ assignedCreators: ["creator-1"] });
  authority.afterCommit = (count) => {
    if (count === 1) authority.accessEpoch = 2;
  };
  await assert.rejects(
    () => ingest(service, [
      canonical({ localId: "epoch-first", messageId: "epoch-message-1" }),
      canonical({ localId: "epoch-second", messageId: "epoch-message-2" }),
    ]),
    (error) => error?.code === "TELEMETRY_ACCESS_EPOCH_STALE"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].localId, "epoch-first");
});
