"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { eligibleTelegramExecutionAccounts } = require("./telegram-execution-runtime");

function clean(value) { return String(value == null ? "" : value); }
function orderedPage(rows, { where = {}, orderBy = null, take = rows.length, cursor = null, skip = 0 } = {}, match) {
  let out = rows.filter((row) => match(row, where));
  if (orderBy?.id === "asc" || (Array.isArray(orderBy) && orderBy.some((entry) => entry?.id === "asc"))) out = out.slice().sort((a, b) => clean(a.id).localeCompare(clean(b.id)));
  if (cursor?.id) {
    const index = out.findIndex((row) => clean(row.id) === clean(cursor.id));
    out = index >= 0 ? out.slice(index + (skip ? 1 : 0)) : out;
  } else if (skip) out = out.slice(skip);
  return out.slice(0, take).map((row) => ({ ...row }));
}
function idMatch(row, where = {}) {
  if (where.id && typeof where.id === "string" && row.id !== where.id) return false;
  if (where.id?.in && !where.id.in.includes(row.id)) return false;
  return true;
}
function creatorMatch(row, where = {}) {
  if (!idMatch(row, where)) return false;
  if (where.agencyId && row.agencyId !== where.agencyId) return false;
  if (where.deletedAt === null && row.deletedAt !== null) return false;
  if (where.telegramContact?.not === null && row.telegramContact == null) return false;
  return true;
}
function accountMatch(row, where = {}) {
  if (!idMatch(row, where)) return false;
  if (where.agencyId && row.agencyId !== where.agencyId) return false;
  if (where.lifecycleState && row.lifecycleState !== where.lifecycleState) return false;
  if (Array.isArray(where.OR) && !where.OR.some((entry) => {
    if (entry.lifecycleState === null) return row.lifecycleState == null;
    if (entry.lifecycleState) return String(row.lifecycleState || "ACTIVE") === String(entry.lifecycleState);
    return false;
  })) return false;
  return true;
}
function orderMatch(row, where = {}) {
  if (!idMatch(row, where)) return false;
  if (where.agencyId && row.agencyId !== where.agencyId) return false;
  if (where.status && row.status !== where.status) return false;
  if (where.creatorId?.in && !where.creatorId.in.includes(row.creatorId)) return false;
  return true;
}
function intentMatch(row, where = {}) {
  if (!idMatch(row, where)) return false;
  if (where.agencyId && row.agencyId !== where.agencyId) return false;
  if (where.accountId && row.accountId !== where.accountId) return false;
  if (where.creatorId?.in && !where.creatorId.in.includes(row.creatorId)) return false;
  if (where.customOrderId?.in && !where.customOrderId.in.includes(row.customOrderId)) return false;
  if (typeof where.kind === "string" && row.kind !== where.kind) return false;
  if (where.kind?.in && !where.kind.in.includes(row.kind)) return false;
  if (typeof where.state === "string" && row.state !== where.state) return false;
  if (where.state?.in && !where.state.in.includes(row.state)) return false;
  if (where.remoteMessageId?.not === null && row.remoteMessageId == null) return false;
  if (where.remoteRecipientTelegramUserId?.not === null && row.remoteRecipientTelegramUserId == null) return false;
  return true;
}
function sourceMatch(row, where = {}) {
  if (!idMatch(row, where)) return false;
  if (where.agencyId && row.agencyId !== where.agencyId) return false;
  if (where.creatorId?.in && !where.creatorId.in.includes(row.creatorId)) return false;
  if (typeof where.telegramSourceAccountId === "string" && row.telegramSourceAccountId !== where.telegramSourceAccountId) return false;
  if (where.telegramSourceAccountId?.not === null && row.telegramSourceAccountId == null) return false;
  if (where.telegramSourceUserId?.not === null && row.telegramSourceUserId == null) return false;
  return true;
}

function makeRuntimeDb({ creators, accounts, orders = [], intents = [], sources = [] }) {
  const member = { id: "member-1", userId: "user-1", agencyId: "agency-1", role: "OPERATOR", roleKey: "chatter", assignedCreators: creators.map((row) => row.id), accessEpoch: 1 };
  return {
    _member: member,
    creatorAccount: {
      async findMany(args) { return orderedPage(creators, args, creatorMatch); },
      async findFirst({ where }) { return creators.find((row) => creatorMatch(row, where)) || null; },
    },
    agencyTelegramMtprotoAccount: {
      async findMany(args) { return orderedPage(accounts, args, accountMatch); },
      async findFirst({ where }) { return accounts.find((row) => accountMatch(row, where)) || null; },
    },
    customOrder: {
      async findMany(args) { return orderedPage(orders, args, orderMatch); },
      async findFirst({ where }) { return orders.find((row) => orderMatch(row, where)) || null; },
    },
    telegramDeliveryIntent: {
      async findMany(args) { return orderedPage(intents, args, intentMatch); },
      async findFirst({ where }) { return intents.find((row) => intentMatch(row, where)) || null; },
    },
    customContentSubmission: {
      async findMany(args) { return orderedPage(sources, args, sourceMatch); },
    },
  };
}

function creator(id, accountId) { return { id, agencyId: "agency-1", telegramContact: `@${id}`, telegramAccountId: accountId, deletedAt: null }; }
function account(index, lifecycleState = "ACTIVE") { return { id: `tg-${String(index).padStart(3, "0")}`, agencyId: "agency-1", lifecycleState }; }
function order(index, status = "COMPLETED") { return { id: `order-${String(index).padStart(4, "0")}`, agencyId: "agency-1", creatorId: "creator-1", status }; }
function task(index, accountId = "tg-old") { return { id: `task-${String(index).padStart(4, "0")}`, agencyId: "agency-1", creatorId: "creator-1", customOrderId: `order-${String(index).padStart(4, "0")}`, accountId, kind: "TASK", state: "CONFIRMED", remoteMessageId: 10000 + index, remoteRecipientTelegramUserId: "900001" }; }

test("F44 runtime pending TASK discovery is exact beyond 1000 terminal historical TASK rows", async () => {
  const orders = Array.from({ length: 1001 }, (_, i) => order(i + 1, i === 1000 ? "PENDING" : "COMPLETED"));
  const intents = Array.from({ length: 1001 }, (_, i) => task(i + 1, "tg-old"));
  const db = makeRuntimeDb({ creators: [creator("creator-1", "tg-new")], accounts: [{ id: "tg-old", agencyId: "agency-1", lifecycleState: "ACTIVE" }, { id: "tg-new", agencyId: "agency-1", lifecycleState: "ACTIVE" }], orders, intents });
  const eligible = await eligibleTelegramExecutionAccounts({ agencyId: "agency-1", member: db._member, db });
  assert.ok(eligible.some((row) => row.accountId === "tg-old" && row.inboundEligible === true && row.messagingEligible === false));
});

test("F44 runtime pending Telegram source discovery drains past the old first-1000 window", async () => {
  const sources = Array.from({ length: 1001 }, (_, i) => ({
    id: `submission-${String(i + 1).padStart(4, "0")}`, agencyId: "agency-1", creatorId: "creator-1", telegramSourceAccountId: i === 1000 ? "tg-old" : "tg-new", telegramSourceUserId: "900001",
    telegramMessageIds: [i + 1], ofMediaIds: i === 1000 ? [] : [`media-${i + 1}`],
  }));
  const db = makeRuntimeDb({ creators: [creator("creator-1", "tg-new")], accounts: [{ id: "tg-old", agencyId: "agency-1", lifecycleState: "ACTIVE" }, { id: "tg-new", agencyId: "agency-1", lifecycleState: "ACTIVE" }], sources });
  const eligible = await eligibleTelegramExecutionAccounts({ agencyId: "agency-1", member: db._member, db });
  assert.ok(eligible.some((row) => row.accountId === "tg-old" && row.messagingEligible === false));
});

test("F44 runtime active follow-up discovery drains past the old first-1000 window", async () => {
  const intents = Array.from({ length: 1001 }, (_, i) => ({ id: `follow-${String(i + 1).padStart(4, "0")}`, agencyId: "agency-1", creatorId: "creator-1", customOrderId: `order-f-${i + 1}`, accountId: i === 1000 ? "tg-old" : "tg-new", kind: "REFERENCE", state: "PLANNED" }));
  const db = makeRuntimeDb({ creators: [creator("creator-1", "tg-new")], accounts: [{ id: "tg-old", agencyId: "agency-1", lifecycleState: "ACTIVE" }, { id: "tg-new", agencyId: "agency-1", lifecycleState: "ACTIVE" }], intents });
  const eligible = await eligibleTelegramExecutionAccounts({ agencyId: "agency-1", member: db._member, db });
  assert.ok(eligible.some((row) => row.accountId === "tg-old" && row.messagingEligible === false));
});

test("F44 scoped explicit account #101 is discovered without agency-wide first-100 catalog truncation", async () => {
  const accounts = Array.from({ length: 101 }, (_, i) => account(i + 1));
  const db = makeRuntimeDb({ creators: [creator("creator-1", accounts[100].id)], accounts });
  const eligible = await eligibleTelegramExecutionAccounts({ agencyId: "agency-1", member: db._member, db });
  assert.deepEqual(eligible, [{ accountId: accounts[100].id, anchorCreatorId: "creator-1", messagingEligible: true, inboundEligible: true }]);
});

test("F44 Auto uses exact ACTIVE cardinality: 101 ACTIVE is ambiguous, one ACTIVE among history resolves, RETIRING does not count", async () => {
  const many = Array.from({ length: 101 }, (_, i) => account(i + 1));
  let db = makeRuntimeDb({ creators: [creator("creator-1", null)], accounts: many });
  assert.deepEqual(await eligibleTelegramExecutionAccounts({ agencyId: "agency-1", member: db._member, db }), []);

  const oneActive = many.map((row, index) => ({ ...row, lifecycleState: index === 100 ? "ACTIVE" : "RETIRING" }));
  db = makeRuntimeDb({ creators: [creator("creator-1", null)], accounts: oneActive });
  assert.deepEqual(await eligibleTelegramExecutionAccounts({ agencyId: "agency-1", member: db._member, db }), [{ accountId: oneActive[100].id, anchorCreatorId: "creator-1", messagingEligible: true, inboundEligible: true }]);
});
