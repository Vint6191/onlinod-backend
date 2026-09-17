"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createActionFanObservationToken,
  consumeActionFanObservationToken,
} = require("./fan-observation-token-service");

function source(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

function tokenDb() {
  let row = null;
  let clock = new Date("2026-09-17T00:00:00.000Z");
  return {
    fanObservationToken: {
      async create({ data }) {
        row = { id: 1n, consumedAt: null, ...data };
        return row;
      },
      async findUnique({ where }) {
        return row?.token === where.token ? { ...row } : null;
      },
      async updateMany({ where, data }) {
        const same = row
          && row.token === where.token
          && (row.jobId || null) === (where.jobId || null)
          && (row.deliveryId || null) === (where.deliveryId || null)
          && row.deviceId === where.deviceId
          && row.leaseRevision === where.leaseRevision
          && row.purpose === where.purpose
          && row.scopeHash === where.scopeHash
          && row.consumedAt === null;
        if (!same) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      },
    },
    async $queryRawUnsafe() {
      clock = new Date(clock.getTime() + 1);
      return [{ lastObservedAt: clock }];
    },
    readRow: () => row,
  };
}

test("INT5.5B-1 action USER_PROFILE token is delivery-owned, exact-scope, and one-shot", async () => {
  const db = tokenDb();
  const delivery = { id: "delivery-1", agencyId: "agency-1", creatorId: "creator-1" };
  const issued = await createActionFanObservationToken({
    db,
    delivery,
    deviceId: "device-1",
    leaseRevision: 4,
    purpose: "action_user_profile",
    subjects: ["fan-1"],
  });
  assert.ok(issued.token);
  assert.equal(db.readRow().jobId, null);
  assert.equal(db.readRow().deliveryId, "delivery-1");

  const consumed = await consumeActionFanObservationToken({
    db,
    delivery,
    deviceId: "device-1",
    leaseRevision: 4,
    token: issued.token,
    purpose: "action_user_profile",
    subjects: ["fan-1"],
  });
  assert.equal(consumed.observedAt.toISOString(), issued.observedAt.toISOString());

  await assert.rejects(() => consumeActionFanObservationToken({
    db,
    delivery,
    deviceId: "device-1",
    leaseRevision: 4,
    token: issued.token,
    purpose: "action_user_profile",
    subjects: ["fan-1"],
  }), /FAN_OBSERVATION_TOKEN_INVALID/);
});

test("INT5.5B-1 action USER_PROFILE token cannot cross delivery target scope", async () => {
  const db = tokenDb();
  const delivery = { id: "delivery-1", agencyId: "agency-1", creatorId: "creator-1" };
  const issued = await createActionFanObservationToken({
    db,
    delivery,
    deviceId: "device-1",
    leaseRevision: 2,
    purpose: "action_user_profile",
    subjects: ["fan-1"],
  });
  await assert.rejects(() => consumeActionFanObservationToken({
    db,
    delivery,
    deviceId: "device-1",
    leaseRevision: 2,
    token: issued.token,
    purpose: "action_user_profile",
    subjects: ["fan-2"],
  }), /FAN_OBSERVATION_TOKEN_INVALID/);
});

test("INT5.5B-1 Backend issues action tokens only from a RUNNING profile-observation lease", () => {
  const actions = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  const route = source("routes/automation-control.js");
  assert.match(actions, /async function issueActionProfileObservationToken/);
  assert.match(actions, /delivery\.status !== "RUNNING"/);
  assert.match(actions, /PROFILE_OBSERVATION_ACTION_TYPES\.has/);
  assert.match(actions, /ACTION_PROFILE_OBSERVATION_PURPOSE = "action_user_profile"/);
  assert.match(actions, /subjects:\s*\[targetId\]/);
  assert.match(actions, /profileObservationTokenVersion:\s*1/);
  assert.match(route, /\/worker\/:id\/profile-observation-token/);
  assert.match(route, /workerStartSchema/);
  assert.match(route, /profileObservationTokenVersion:\s*z\.literal\(1\)\.optional\(\)/);
  assert.match(route, /issueActionProfileObservationToken\(/);
});

test("INT5.5B-1 action observation ingest consumes post-read token while preserving explicit legacy rollout fallback", () => {
  const route = source("routes/fan-data.js");
  assert.match(route, /observationTokenRequired = Number\(object\(scope\.delivery\.result\)\.profileObservationTokenVersion \|\| 0\) >= 1/);
  assert.match(route, /if \(observationTokenRequired \|\| observationToken\)/);
  assert.match(route, /consumeActionFanObservationToken\(\{/);
  assert.match(route, /purpose:\s*"action_user_profile"/);
  assert.match(route, /causalObservedAt = consumed\.observedAt/);
  assert.match(route, /let causalObservedAt = scope\.causalObservedAt/);
  assert.match(route, /causalObservedAt,\s*\n\s*\}\);/);
});

test("INT5.5B-1 migration extends one token authority to mutually-exclusive JobInstance or AutomationDelivery owner", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260917010000_phase3_action_profile_observation_token/migration.sql"), "utf8");
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "deliveryId" TEXT/);
  assert.match(migration, /ALTER COLUMN "jobId" DROP NOT NULL/);
  assert.match(migration, /num_nonnulls\("jobId", "deliveryId"\) = 1/);
  assert.match(migration, /NOT VALID/);
  assert.match(migration, /VALIDATE CONSTRAINT/);
  assert.match(schema, /model FanObservationToken[\s\S]*jobId\s+String\?[\s\S]*deliveryId\s+String\?/);
});

test("INT5.5C-3 Backend, not client negotiation, owns the action-profile token cutover for newly-started deliveries", () => {
  const actions = fs.readFileSync(path.join(__dirname, "automation-action-delivery-service.js"), "utf8");
  const start = actions.indexOf("async function startActionDelivery");
  const end = actions.indexOf("\nasync function validateActionDelivery", start);
  assert.ok(start >= 0 && end > start);
  const block = actions.slice(start, end);
  assert.match(block, /PROFILE_OBSERVATION_ACTION_TYPES\.has\(String\(delivery\.actionType \|\| ""\)\) \? \{ profileObservationTokenVersion: 1, profileObservationReadLeaseVersion: 1 \}/);
  assert.doesNotMatch(block, /Number\(input\.profileObservationTokenVersion \|\| 0\) >= 1/);
  assert.match(block, /if \(delivery\.status === "RUNNING"\) return delivery/);
});
