"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { projectFanObservationBatch } = require("./fan-data-authority-service");

function fullObservation(index, observedAt = "2026-09-16T18:00:00.000Z") {
  const fanId = `fan-${index}`;
  return {
    onlyFansUserId: fanId,
    identity: {
      source: "USER_PROFILE", observedAt,
      username: `user_${index}`,
      platformDisplayName: `Fan ${index}`,
      avatarUrl: `https://cdn.example/${index}.jpg`,
      headerUrl: `https://cdn.example/${index}-header.jpg`,
      activityObservedAt: observedAt,
    },
    relationship: {
      source: "USER_PROFILE", observedAt,
      fanSubscribesToCreator: true,
      fanSubscriptionActive: true,
      fanSubscriptionType: index % 2 ? "paid" : "free",
      fanSubscriptionExpiresAt: "2026-10-16T00:00:00.000Z",
      creatorFollowsFan: false,
      creatorFollowExpiresAt: null,
      canReceiveChatMessage: true,
      blocked: false,
      restricted: false,
      performer: false,
      lastSeenAt: observedAt,
      subscribePriceCents: index % 2 ? 999 : 0,
    },
    value: {
      source: "USER_PROFILE", observedAt,
      availability: "AVAILABLE",
      totalSpentCents: 1000 + index,
      messagesSpentCents: 100 + index,
      subscriptionsSpentCents: 200 + index,
      tipsSpentCents: 300 + index,
      postsSpentCents: 400 + index,
      streamsSpentCents: 0,
      lastActivityAt: observedAt,
    },
  };
}

function bulkDb() {
  const calls = [];
  const tx = {
    async $executeRawUnsafe(sql, ...args) {
      // Transaction-local budget setup is not a domain mutation/lock.
      if (sql === "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)") return 1;

      calls.push({ sql: String(sql), args });
      return 1;
    },
  };
  return {
    calls,
    async $transaction(work) { return work(tx); },
  };
}


function splitSqlCalls(calls) {
  const locks = calls.filter((call) => /pg_advisory_xact_lock/.test(call.sql));
  const writes = calls.filter((call) => !/pg_advisory_xact_lock/.test(call.sql));
  return { locks, writes };
}

async function projectCount(count) {
  const db = bulkDb();
  const items = Array.from({ length: count }, (_, index) => fullObservation(index));
  const result = await projectFanObservationBatch(db, {
    agencyId: "agency-1",
    creatorId: "creator-1",
    sourceDeviceId: "device-1",
    sourceJobId: "job-1",
    items,
    allowedSources: ["USER_PROFILE"],
    observedAtPolicy: "SERVER_GENERATION",
    causalObservedAt: new Date("2026-09-16T18:00:00.000Z"),
    receivedAt: new Date("2026-09-16T18:00:05.000Z"),
  });
  return { db, result };
}

test("generic FanData full-profile projection has constant bounded SQL topology from 1 through 500 fans", async () => {
  for (const count of [1, 10, 100, 500]) {
    const { db, result } = await projectCount(count);
    assert.equal(result.projected, count);
    const { locks, writes } = splitSqlCalls(db.calls);
    assert.equal(locks.length, 2, `expected constant Campaign -> FanData authority locks for ${count} fans`);
    assert.equal(writes.length, 4, `expected four projection SQL statements for ${count} fans`);
    assert.ok(writes[0].sql.includes('INSERT INTO "CreatorFan"'));
    assert.ok(writes[1].sql.includes('UPDATE "CreatorFan"'));
    assert.ok(writes[2].sql.includes('INSERT INTO "CreatorFanRelationshipCurrent"'));
    assert.ok(writes[3].sql.includes('INSERT INTO "CreatorFanValueCurrent"'));

    const fanRows = JSON.parse(writes[0].args[0]);
    const relationshipRows = JSON.parse(writes[2].args[0]);
    const valueRows = JSON.parse(writes[3].args[0]);
    assert.equal(fanRows.length, count);
    assert.equal(relationshipRows.length, count);
    assert.equal(valueRows.length, count);
  }
});

test("duplicate fan observations are collapsed before SQL and preserve newest per-field authority", async () => {
  const db = bulkDb();
  const older = fullObservation(7, "2026-09-16T18:00:00.000Z");
  older.relationship.creatorFollowsFan = false;
  older.relationship.blocked = false;
  const newer = fullObservation(7, "2026-09-16T18:01:00.000Z");
  newer.relationship.creatorFollowsFan = true;
  delete newer.relationship.blocked; // partial newer observation must not erase older blocked fact.

  const result = await projectFanObservationBatch(db, {
    agencyId: "agency-1", creatorId: "creator-1", items: [older, newer],
    allowedSources: ["USER_PROFILE"], observedAtPolicy: "TRUSTED_INPUT",
  });
  assert.equal(result.projected, 2);
  const { locks, writes } = splitSqlCalls(db.calls);
  assert.equal(locks.length, 2);
  assert.equal(writes.length, 4);

  const relationshipRows = JSON.parse(writes[2].args[0]);
  assert.equal(relationshipRows.length, 1);
  assert.equal(relationshipRows[0].creatorFollowsFan, true);
  assert.equal(relationshipRows[0].blocked, false);
  assert.match(relationshipRows[0].creatorFollowsFanAuthorityVersion, /^2026-09-16T18:01:00\.000Z\|/);
  assert.match(relationshipRows[0].blockedAuthorityVersion, /^2026-09-16T18:00:00\.000Z\|/);
});

test("partial relationship observation remains partial in bulk SQL row", async () => {
  const db = bulkDb();
  const item = {
    onlyFansUserId: "fan-partial",
    relationship: {
      source: "USER_PROFILE",
      observedAt: "2026-09-16T18:00:00.000Z",
      canReceiveChatMessage: false,
    },
  };
  const result = await projectFanObservationBatch(db, {
    agencyId: "agency-1", creatorId: "creator-1", items: [item],
    allowedSources: ["USER_PROFILE"], observedAtPolicy: "TRUSTED_INPUT",
  });
  const { locks, writes } = splitSqlCalls(db.calls);
  assert.equal(locks.length, 1);
  assert.equal(writes.length, 3);
  const relationshipRows = JSON.parse(writes[2].args[0]);
  const row = relationshipRows[0];
  assert.equal(row.canReceiveChatMessage, false);
  assert.ok(row.canReceiveChatMessageAuthorityVersion);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "fanSubscriptionActive"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "fanSubscriptionActiveAuthorityVersion"), false);
});
