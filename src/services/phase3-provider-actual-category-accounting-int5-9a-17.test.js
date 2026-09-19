"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  acknowledgeDurableProviderStarted,
} = require("./provider-request-credit-authority-service");
const {
  deriveProviderCapacityDebtSnapshot,
} = require("./provider-capacity-debt-authority-service");

function gateDb({ priority = "background", category = "fan_data", windowStartedAt = new Date("2026-09-19T00:00:00.000Z"), now = new Date("2026-09-19T00:10:00.000Z") } = {}) {
  let accountingSql = null;
  let accountingArgs = null;
  const tx = {
    async $queryRawUnsafe(sql, ...args) {
      if (sql.includes('INSERT INTO "OfProviderRequestGateState"')) return [];
      if (sql.includes('FROM "OfProviderRequestGateState" s') && sql.includes('FOR UPDATE')) {
        return [{
          id: "of-global",
          activePermitId: "p1",
          activeOwnerInstanceId: "b1",
          activeAgencyId: "a1",
          activeCreatorId: "c1",
          activeDeviceId: "d1",
          activeCapability: "read",
          activePriority: priority,
          activeCategory: category,
          activeIntervalMs: 700,
          activeGrantedAt: new Date(now.getTime() - 5),
          activeExpiresAt: new Date(now.getTime() + 15_000),
          nextAllowedAt: null,
          revision: 7n,
          usageWindowStartedAt: windowStartedAt,
          usageTotalStarts: 4n,
          usageCriticalWriteStarts: 0n,
          usageInteractiveStarts: 0n,
          usageRealtimeStarts: 0n,
          usageNormalStarts: 0n,
          usageCampaignDirectoryStarts: 0n,
          usageCampaignFrontierStarts: 0n,
          usageFanDataStarts: 4n,
          usageBackgroundOtherStarts: 0n,
          usageUnclassifiedStarts: 0n,
          priorityCursor: 0,
          backgroundCategoryCursor: 0,
          fairnessGeneration: "phase3_provider_gate_fairness_v2_a14",
          fairnessActivationState: "ACTIVE",
          legacyPermitCount: 0n,
          authorityNow: now,
        }];
      }
      if (sql.includes('"usageTotalStarts" = CASE')) {
        accountingSql = sql;
        accountingArgs = args;
        return [{ revision: 8n, usageWindowStartedAt: windowStartedAt, usageTotalStarts: 5n, usageUnclassifiedStarts: 0n }];
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 100)}`);
    },
  };
  return {
    db: {
      $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx),
      async $transaction(fn) { return fn(tx); },
    },
    getAccounting: () => ({ sql: accountingSql, args: accountingArgs }),
  };
}

test("A17 /started atomically accounts the frozen granted category in the singleton update", async () => {
  const mock = gateDb();
  const result = await acknowledgeDurableProviderStarted({
    db: mock.db,
    permitId: "p1",
    agencyId: "a1",
    creatorId: "c1",
    deviceId: "d1",
    capability: "read",
  });
  assert.equal(result.usageTotalStarts, 5);
  const { sql, args } = mock.getAccounting();
  assert.ok(sql.includes('"usageFanDataStarts"'));
  assert.ok(sql.includes('"activeCategory" = NULL'));
  assert.equal(args[5], "background");
  assert.equal(args[6], "fan_data");
  assert.equal(args[7], false);
});

test("A17 /started resets the accounting window after one hour", async () => {
  const now = new Date("2026-09-19T02:00:00.000Z");
  const mock = gateDb({ now, windowStartedAt: new Date("2026-09-19T00:00:00.000Z") });
  await acknowledgeDurableProviderStarted({ db: mock.db, permitId: "p1", agencyId: "a1", creatorId: "c1", deviceId: "d1", capability: "read" });
  assert.equal(mock.getAccounting().args[7], true);
});

test("A17 capacity projection persists actual other/unclassified starts instead of hiding them", () => {
  const snapshot = deriveProviderCapacityDebtSnapshot({
    now: new Date("2026-09-19T00:20:00.000Z"),
    campaignDirectory: {},
    fanData: {},
    actualUsage: {
      windowStartedAt: new Date("2026-09-19T00:00:00.000Z"),
      totalStarts: 9n,
      campaignDirectoryStarts: 1n,
      campaignFrontierStarts: 2n,
      fanDataStarts: 2n,
      backgroundOtherStarts: 3n,
      unclassifiedStarts: 1n,
    },
  });
  assert.equal(snapshot.actualUsageTotalStarts, 9n);
  assert.equal(snapshot.actualUsageBackgroundOtherStarts, 3n);
  assert.equal(snapshot.actualUsageUnclassifiedStarts, 1n);
  assert.equal(snapshot.actualUsageAccountingComplete, false);
  assert.equal(snapshot.status, "UNKNOWN");
  assert.match(snapshot.overloadReason, /ACTUAL_USAGE_ACCOUNTING_INCOMPLETE/);
});

test("A17 schema/migration are additive and freeze category on the active permit", () => {
  const root = path.join(__dirname, "..", "..");
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(root, "prisma", "migrations", "20260919051500_phase3_provider_actual_category_accounting_v1", "migration.sql"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "provider-request-credit-authority-service.js"), "utf8");
  assert.match(schema, /activePriority\s+String\?/);
  assert.match(schema, /actualUsageBackgroundOtherStarts\s+BigInt/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "usageTotalStarts"/);
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);
  assert.match(source, /"activePriority" = \$13/);
  assert.match(source, /"activeCategory" = \$14/);
  assert.match(source, /"usageBackgroundOtherStarts"/);
});
