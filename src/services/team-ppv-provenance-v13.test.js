"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaPath = require.resolve("../prisma");
const servicePath = require.resolve("./team-ppv-ledger-service");

function loadService() {
  const rows = [];
  const model = {
    async findFirst({ where }) {
      if (where.messageId) return rows.find((row) => row.agencyId === where.agencyId && row.accountId === where.accountId && row.messageId === where.messageId) || null;
      return null;
    },
    async findUnique({ where }) {
      const key = where.agencyId_accountId_localSeed;
      return rows.find((row) => row.agencyId === key.agencyId && row.accountId === key.accountId && row.localSeed === key.localSeed) || null;
    },
    async create({ data }) {
      const row = { id: `sent-${rows.length + 1}`, ...data };
      rows.push(row);
      return row;
    },
    async update({ where, data }) {
      const row = rows.find((item) => item.id === where.id);
      Object.assign(row, data);
      return row;
    },
  };
  const prisma = { teamSentMessageLedger: model };
  delete require.cache[servicePath];
  delete require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma };
  const service = require(servicePath);
  return { service, rows };
}

test("v13 sent ledger consumes relational provenance fields first", async () => {
  const { service, rows } = loadService();
  const result = await service.upsertSentMessageFromEvent({
    id: "event-1",
    agencyId: "agency-1",
    accountId: "creator-1",
    creatorId: "creator-1",
    memberId: "member-1",
    userId: "user-1",
    deviceId: "device-1",
    eventKind: "MESSAGE_SEND_CONFIRMED",
    actionSource: "MANUAL",
    lifecycle: "CONFIRMED",
    dialogId: "fan-1",
    fanId: "fan-1",
    messageId: "message-1",
    correlationId: "cdp:1:req",
    isPpv: true,
    priceCents: 3500,
    currency: "USD",
    mediaCount: 2,
    ts: new Date("2026-08-11T20:00:00.000Z"),
    localId: "local-1",
    extra: { mediaIds: ["11", "12"] },
  });

  assert.equal(result.id, "sent-1");
  assert.equal(rows[0].memberId, "member-1");
  assert.equal(rows[0].dialogId, "fan-1");
  assert.equal(rows[0].messageId, "message-1");
  assert.equal(rows[0].localSeed, "cdp:1:req");
  assert.equal(rows[0].isPpv, true);
  assert.equal(rows[0].priceCents, 3500);
  assert.equal(rows[0].mediaCount, 2);
  assert.deepEqual(rows[0].mediaIds, ["11", "12"]);
  assert.equal(rows[0].source, "manual");
});

test("v13 automation provenance creates no chatter owner", async () => {
  const { service, rows } = loadService();
  await service.applyLedgerSideEffects({
    id: "event-2",
    agencyId: "agency-1",
    accountId: "creator-1",
    creatorId: "creator-1",
    memberId: null,
    userId: null,
    deviceId: "device-1",
    eventKind: "MESSAGE_SEND_CONFIRMED",
    actionSource: "AUTOMATION",
    lifecycle: "CONFIRMED",
    dialogId: "fan-2",
    fanId: "fan-2",
    messageId: "message-auto",
    automationDeliveryId: "delivery-1",
    correlationId: "delivery-1",
    isPpv: true,
    priceCents: 5000,
    currency: "USD",
    mediaCount: 1,
    ts: new Date("2026-08-11T20:01:00.000Z"),
    localId: "local-2",
    extra: { mediaIds: ["99"] },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].memberId, null);
  assert.equal(rows[0].userId, null);
  assert.equal(rows[0].source, "automation");
  assert.equal(rows[0].messageId, "message-auto");
});
