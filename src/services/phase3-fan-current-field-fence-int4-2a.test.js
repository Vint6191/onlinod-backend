"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const prismaModulePath = require.resolve("../prisma");
require.cache[prismaModulePath] = { id: prismaModulePath, filename: prismaModulePath, loaded: true, exports: {} };

const { readFanCurrent } = require("./fan-data-authority-service");
const {
  FAN_CURRENT_FRESHNESS_CLASS,
  classifyRelationshipFreshness,
  buildFanCurrentFieldFence,
  assertFanCurrentFieldFence,
} = require("./fan-current-consumer-service");

function version(at, source, suffix) {
  return `${at}|0700|${source}|${suffix}`;
}

function currentWithFieldAuthority({ activeAt, activeVersion, lastSeenAt, lastSeenVersion }) {
  return {
    creatorId: "creator-1",
    onlyFansUserId: "fan-1",
    relationship: {
      fanSubscriptionActive: false,
      lastSeenAt: new Date(lastSeenAt),
      observedAt: new Date(lastSeenAt),
      source: "USER_PROFILE",
      fieldAuthority: {
        fanSubscriptionActive: {
          authorityVersion: activeVersion,
          observedAt: new Date(activeAt),
          source: "SUBSCRIBER_DIRECTORY",
        },
        lastSeenAt: {
          authorityVersion: lastSeenVersion,
          observedAt: new Date(lastSeenAt),
          source: "USER_PROFILE",
        },
      },
    },
  };
}

test("INT4.2A readFanCurrent exposes exact per-field relationship provenance/version", async () => {
  const activeVersion = version("2026-09-01T10:00:00.000Z", "SUBSCRIBER_DIRECTORY", "active-v1");
  const lastSeenVersion = version("2026-09-16T10:00:00.000Z", "USER_PROFILE", "seen-v2");
  const relationshipCurrent = {
    fanSubscriptionActive: false,
    fanSubscriptionActiveAuthorityVersion: activeVersion,
    lastSeenAt: new Date("2026-09-16T10:00:00.000Z"),
    lastSeenAtAuthorityVersion: lastSeenVersion,
    observedAt: new Date("2026-09-16T10:00:00.000Z"),
    source: "USER_PROFILE",
  };
  const db = {
    creatorFan: {
      async findMany() {
        return [{
          id: "record-1", agencyId: "agency-1", creatorId: "creator-1", onlyFansUserId: "fan-1",
          username: null, displayName: null, avatarUrl: null, headerUrl: null,
          identityObservedAt: null, identitySource: null, identityCompleteness: null,
          relationshipCurrent, valueCurrent: null,
        }];
      },
    },
  };
  const rows = await readFanCurrent(db, { agencyId: "agency-1", creatorId: "creator-1", onlyFansUserIds: ["fan-1"] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].relationship.fieldAuthority.fanSubscriptionActive.authorityVersion, activeVersion);
  assert.equal(rows[0].relationship.fieldAuthority.fanSubscriptionActive.observedAt.toISOString(), "2026-09-01T10:00:00.000Z");
  assert.equal(rows[0].relationship.fieldAuthority.lastSeenAt.authorityVersion, lastSeenVersion);
  assert.equal(rows[0].relationship.fieldAuthority.lastSeenAt.observedAt.toISOString(), "2026-09-16T10:00:00.000Z");
});

test("INT4.2A unrelated fresh relationship field cannot mask stale required field", () => {
  const current = currentWithFieldAuthority({
    activeAt: "2026-09-01T10:00:00.000Z",
    activeVersion: version("2026-09-01T10:00:00.000Z", "SUBSCRIBER_DIRECTORY", "active-v1"),
    lastSeenAt: "2026-09-16T10:00:00.000Z",
    lastSeenVersion: version("2026-09-16T10:00:00.000Z", "USER_PROFILE", "seen-v2"),
  });

  const activeFreshness = classifyRelationshipFreshness(current, {
    now: new Date("2026-09-16T12:00:00.000Z"),
    maxAgeMs: 24 * 60 * 60_000,
    requiredFields: ["fanSubscriptionActive"],
  });
  assert.equal(activeFreshness.freshnessClass, FAN_CURRENT_FRESHNESS_CLASS.POINT_REFRESH_REQUIRED);
  assert.deepEqual(activeFreshness.refreshFields, ["fanSubscriptionActive"]);

  const lastSeenFreshness = classifyRelationshipFreshness(current, {
    now: new Date("2026-09-16T12:00:00.000Z"),
    maxAgeMs: 24 * 60 * 60_000,
    requiredFields: ["lastSeenAt"],
  });
  assert.equal(lastSeenFreshness.freshnessClass, FAN_CURRENT_FRESHNESS_CLASS.FRESH_ENOUGH);
  assert.equal(lastSeenFreshness.refreshRequired, false);
});

test("INT4.2A exact field fence ignores unrelated G2 but rejects required-field G2 before COMMITTING", async () => {
  const activeV1 = version("2026-09-16T10:00:00.000Z", "USER_PROFILE", "active-v1");
  const activeV2 = version("2026-09-16T10:01:00.000Z", "USER_PROFILE", "active-v2");
  const current = {
    creatorId: "creator-1",
    onlyFansUserId: "fan-1",
    relationship: {
      fanSubscriptionActive: false,
      fieldAuthority: {
        fanSubscriptionActive: { authorityVersion: activeV1, observedAt: new Date("2026-09-16T10:00:00.000Z"), source: "USER_PROFILE" },
      },
    },
  };
  const fence = buildFanCurrentFieldFence(current, ["fanSubscriptionActive"]);
  assert.deepEqual(fence.versions, { fanSubscriptionActive: activeV1 });

  let storedActiveVersion = activeV1;
  const sqlCalls = [];
  const db = {
    async $queryRawUnsafe(sql, agencyId, creatorId, fanId) {
      sqlCalls.push({ sql: String(sql), agencyId, creatorId, fanId });
      return [{ fanSubscriptionActiveAuthorityVersion: storedActiveVersion, lastSeenAtAuthorityVersion: "unrelated-g2" }];
    },
  };

  const unrelatedG2 = await assertFanCurrentFieldFence({ db, agencyId: "agency-1", fence });
  assert.equal(unrelatedG2.ok, true);
  assert.match(sqlCalls[0].sql, /"fanSubscriptionActiveAuthorityVersion"/);
  assert.doesNotMatch(sqlCalls[0].sql, /"lastSeenAtAuthorityVersion"/);
  assert.match(sqlCalls[0].sql, /FOR SHARE/);
  assert.equal(sqlCalls[0].fanId, "fan-1");

  storedActiveVersion = activeV2;
  const requiredG2 = await assertFanCurrentFieldFence({ db, agencyId: "agency-1", fence });
  assert.equal(requiredG2.ok, false);
  assert.equal(requiredG2.code, "fan_current_fence_stale");
  assert.deepEqual(requiredG2.changedFields, ["fanSubscriptionActive"]);
});

test("INT4.2A prepare-write binds exact fan field fence before AutomationDelivery COMMITTING update", () => {
  const source = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  const prepare = source.slice(source.indexOf("async function prepareWriteActionDelivery"), source.indexOf("async function projectKnownRelationshipOutcome"));
  const validationAt = prepare.indexOf("validateFollowBackDeliveryCurrent");
  const fenceAt = prepare.indexOf("assertFanCurrentFieldFence");
  const committingUpdateAt = prepare.indexOf("status: \"COMMITTING\"");
  assert.ok(validationAt >= 0, "canonical fan validation must remain in prepare-write");
  assert.ok(fenceAt > validationAt, "exact field fence must run after eligibility read");
  assert.ok(committingUpdateAt > fenceAt, "COMMITTING mutation must happen only after exact field fence");
  assert.match(prepare, /FAN_CURRENT_COMMIT_FENCE_STALE/);
});

test("INT4.2A metrics stop using row-wide observedAt as required-field provenance", () => {
  const followBack = fs.readFileSync(path.join(__dirname, "follow-back-service.js"), "utf8");
  const refollow = fs.readFileSync(path.join(__dirname, "follow-automation-service.js"), "utf8");
  const likes = fs.readFileSync(path.join(__dirname, "likes-service.js"), "utf8");
  assert.match(followBack, /creatorFollowsFanAuthorityVersion/);
  assert.match(followBack, /fanSubscriptionActiveAuthorityVersion/);
  assert.match(refollow, /fanSubscriptionActiveAuthorityVersion[\s\S]*creatorFollowsFanAuthorityVersion[\s\S]*blockedAuthorityVersion/);
  assert.match(likes, /fanSubscriptionActiveAuthorityVersion/);
  assert.doesNotMatch(refollow.slice(refollow.indexOf("async function countCanonicalEligibleRefollowCandidates"), refollow.indexOf("async function listFollowAutomation")), /r\."observedAt" IS NOT NULL/);
});
