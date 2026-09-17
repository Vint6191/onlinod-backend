"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  acquireFanObservationReadLease,
  completeDeliveryFanObservationReadLease,
  releaseJobFanObservationReadLease,
} = require("./fan-observation-read-lease-service");

function memoryDb() {
  let readLease = null;
  let clock = new Date("2026-09-17T16:00:00.000Z");
  return {
    get readLease() { return readLease; },
    async $queryRawUnsafe(sql, ...args) {
      if (/INSERT INTO "FanObservationReadLease"/.test(sql)) {
        const [creatorId, agencyId, token, requestId, jobId, deliveryId, deviceId, leaseRevision, purpose, ttlMs] = args;
        const now = new Date();
        if (!readLease || readLease.expiresAt.getTime() <= now.getTime()) {
          readLease = { creatorId, agencyId, token, requestId, jobId, deliveryId, deviceId, leaseRevision: Number(leaseRevision), purpose, acquiredAt: now, expiresAt: new Date(now.getTime() + Number(ttlMs)), updatedAt: now };
          return [{ ...readLease }];
        }
        return [];
      }
      if (/FROM "FanObservationReadLease"/.test(sql) && /FOR UPDATE/.test(sql)) {
        return readLease && readLease.creatorId === args[0] && readLease.expiresAt.getTime() > Date.now() ? [{ ...readLease }] : [];
      }
      if (/INSERT INTO "FanObservationCreatorClock"/.test(sql)) {
        clock = new Date(clock.getTime() + 1);
        return [{ lastObservedAt: new Date(clock) }];
      }
      throw new Error(`unexpected raw SQL: ${sql.slice(0, 120)}`);
    },
    fanObservationReadLease: {
      async findUnique({ where }) { return readLease && readLease.creatorId === where.creatorId ? { ...readLease } : null; },
      async deleteMany({ where }) {
        if (!readLease) return { count: 0 };
        for (const [key, expected] of Object.entries(where || {})) {
          if (expected === undefined) continue;
          if ((readLease[key] ?? null) !== expected) return { count: 0 };
        }
        readLease = null;
        return { count: 1 };
      },
    },
    fanObservationToken: {
      async deleteMany() { return { count: 0 }; },
      async create({ data }) { return { id: 1n, ...data, createdAt: new Date() }; },
    },
  };
}

const delivery = { id: "delivery-action", agencyId: "agency-1", creatorId: "creator-1" };
const job = { id: "job-refresh", agencyId: "agency-1", creatorId: "creator-1" };

test("INT5.5D-3 Action USER_PROFILE and readonly jobs share one creator-wide causal read lease", async () => {
  const db = memoryDb();
  const action = await acquireFanObservationReadLease({
    db, deliveryId: delivery.id, agencyId: delivery.agencyId, creatorId: delivery.creatorId,
    deviceId: "device-action", leaseRevision: 7, purpose: "action_user_profile", requestId: "action-stable-request",
  });
  assert.equal(action.acquired, true);

  for (const [purpose, jobId, deviceId] of [
    ["fan_data_point_refresh", "job-refresh", "device-refresh"],
    ["sfs_target_discovery", "job-sfs", "device-sfs"],
    ["subscriber_directory_page", "job-subscriber", "device-subscriber"],
  ]) {
    const blocked = await acquireFanObservationReadLease({
      db, jobId, agencyId: "agency-1", creatorId: "creator-1", deviceId,
      leaseRevision: 1, purpose, requestId: `blocked-${jobId}`,
    });
    assert.equal(blocked.acquired, false, `${purpose} must not read while Action owns the creator fence`);
  }

  const actionToken = await completeDeliveryFanObservationReadLease({
    db, delivery, deviceId: "device-action", leaseRevision: 7, readLeaseToken: action.token,
    purpose: "action_user_profile", subjects: ["fan-1"],
  });
  assert.equal(db.readLease, null);

  const refresh = await acquireFanObservationReadLease({
    db, jobId: job.id, agencyId: job.agencyId, creatorId: job.creatorId,
    deviceId: "device-refresh", leaseRevision: 1, purpose: "fan_data_point_refresh", requestId: "refresh-after-action",
  });
  assert.equal(refresh.acquired, true);
  assert.ok(actionToken.observedAt);
  await releaseJobFanObservationReadLease({ db, job, deviceId: "device-refresh", leaseRevision: 1, readLeaseToken: refresh.token });
});

test("INT5.5D-3 source wiring makes new Action profile reads server-enforced and delivery-lease bound", () => {
  const root = path.resolve(__dirname, "../..");
  const actions = fs.readFileSync(path.join(root, "src/services/automation-action-delivery-service.js"), "utf8");
  const routes = fs.readFileSync(path.join(root, "src/routes/automation-control.js"), "utf8");
  const readLease = fs.readFileSync(path.join(root, "src/services/fan-observation-read-lease-service.js"), "utf8");

  assert.match(actions, /profileObservationTokenVersion: 1, profileObservationReadLeaseVersion: 1/);
  assert.match(actions, /obs-read-action:\$\{delivery\.id\}:\$\{delivery\.leaseRevision\}:\$\{ACTION_PROFILE_OBSERVATION_PURPOSE\}/);
  assert.match(actions, /FOR UPDATE[\s\S]*DELIVERY_LEASE_STALE/);
  assert.match(actions, /profileObservationReadLeaseVersion[\s\S]*FAN_OBSERVATION_READ_LEASE_REQUIRED/);
  assert.match(actions, /fanObservationReadLease\.updateMany[\s\S]*deliveryId: delivery\.id[\s\S]*FAN_OBSERVATION_READ_LEASE_TTL_MS/);
  assert.match(actions, /sweepExpiredAutomationLeases[\s\S]*fanObservationReadLease\?\.deleteMany[\s\S]*deliveryId: row\.id[\s\S]*leaseRevision: row\.leaseRevision/);
  assert.match(routes, /profile-observation-read-lease\/acquire/);
  assert.match(routes, /profile-observation-read-lease\/release/);
  assert.match(routes, /profile-observation-token[\s\S]*workerProfileObservationTokenSchema/);
  assert.match(readLease, /completeDeliveryFanObservationReadLease/);
  assert.match(readLease, /releaseDeliveryFanObservationReadLease/);
});
