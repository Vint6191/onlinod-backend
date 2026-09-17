"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  acquireFanObservationReadLease,
  completeJobFanObservationReadLease,
  releaseJobFanObservationReadLease,
} = require("./fan-observation-read-lease-service");

function memoryDb() {
  let readLease = null;
  let clock = new Date("2026-09-17T12:00:00.000Z");
  const observationTokens = [];
  return {
    get readLease() { return readLease; },
    observationTokens,
    async $queryRawUnsafe(sql, ...args) {
      if (/INSERT INTO "FanObservationReadLease"/.test(sql)) {
        const [creatorId, agencyId, token, requestId, jobId, deliveryId, deviceId, leaseRevision, purpose, ttlMs] = args;
        const now = new Date();
        if (!readLease || readLease.expiresAt.getTime() <= now.getTime()) {
          readLease = {
            creatorId, agencyId, token, requestId, jobId, deliveryId, deviceId,
            leaseRevision: Number(leaseRevision), purpose,
            acquiredAt: now, expiresAt: new Date(now.getTime() + Number(ttlMs)), updatedAt: now,
          };
          return [{ ...readLease }];
        }
        return [];
      }
      if (/FROM "FanObservationReadLease"/.test(sql) && /FOR UPDATE/.test(sql)) {
        const [creatorId] = args;
        return readLease && readLease.creatorId === creatorId && readLease.expiresAt.getTime() > Date.now()
          ? [{ ...readLease }]
          : [];
      }
      if (/UPDATE "FanObservationClock"/.test(sql)) {
        clock = new Date(clock.getTime() + 1);
        return [{ lastObservedAt: new Date(clock) }];
      }
      throw new Error(`unexpected raw SQL: ${sql.slice(0, 120)}`);
    },
    fanObservationReadLease: {
      async findUnique({ where }) {
        return readLease && readLease.creatorId === where.creatorId ? { ...readLease } : null;
      },
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
      async create({ data }) {
        const row = { id: BigInt(observationTokens.length + 1), ...data, createdAt: new Date() };
        observationTokens.push(row);
        return row;
      },
    },
  };
}

function job(id, device = "device-a") {
  return { id, agencyId: "agency-1", creatorId: "creator-1", claimedByDeviceId: device };
}

test("INT5.5D-1 cross-device creator read lease prevents a second provider read until the first completion token commits", async () => {
  const db = memoryDb();
  const first = await acquireFanObservationReadLease({
    db, jobId: "job-a", agencyId: "agency-1", creatorId: "creator-1",
    deviceId: "device-a", leaseRevision: 3, purpose: "fan_data_point_refresh", requestId: "request-a-00000001",
  });
  assert.equal(first.acquired, true);

  const blocked = await acquireFanObservationReadLease({
    db, jobId: "job-b", agencyId: "agency-1", creatorId: "creator-1",
    deviceId: "device-b", leaseRevision: 4, purpose: "fan_data_point_refresh", requestId: "request-b-00000001",
  });
  assert.equal(blocked.acquired, false, "device B must not start an OF read while device A owns the creator fence");

  const tokenA = await completeJobFanObservationReadLease({
    db, job: job("job-a"), deviceId: "device-a", leaseRevision: 3,
    readLeaseToken: first.token, purpose: "fan_data_point_refresh", subjects: ["fan-1"],
  });
  assert.equal(db.readLease, null, "completion must release the creator fence only after token issuance");

  const second = await acquireFanObservationReadLease({
    db, jobId: "job-b", agencyId: "agency-1", creatorId: "creator-1",
    deviceId: "device-b", leaseRevision: 4, purpose: "fan_data_point_refresh", requestId: "request-b-00000002",
  });
  assert.equal(second.acquired, true);
  const tokenB = await completeJobFanObservationReadLease({
    db, job: job("job-b", "device-b"), deviceId: "device-b", leaseRevision: 4,
    readLeaseToken: second.token, purpose: "fan_data_point_refresh", subjects: ["fan-1"],
  });
  assert.ok(new Date(tokenB.observedAt).getTime() > new Date(tokenA.observedAt).getTime(), "token chronology must follow the serialized provider-read order");
});

test("INT5.5D-1 read lease is idempotent for one acquire request and fenced by device/revision", async () => {
  const db = memoryDb();
  const input = {
    db, jobId: "job-a", agencyId: "agency-1", creatorId: "creator-1",
    deviceId: "device-a", leaseRevision: 9, purpose: "fan_data_point_refresh", requestId: "same-request-000001",
  };
  const first = await acquireFanObservationReadLease(input);
  const replay = await acquireFanObservationReadLease(input);
  assert.equal(replay.acquired, true);
  assert.equal(replay.token, first.token, "lost acquire response can be retried without rotating ownership");

  await assert.rejects(() => completeJobFanObservationReadLease({
    db, job: job("job-a"), deviceId: "device-b", leaseRevision: 9,
    readLeaseToken: first.token, purpose: "fan_data_point_refresh", subjects: ["fan-1"],
  }), /missing, expired or belongs to another execution/);
  assert.ok(db.readLease, "wrong-device completion must not release the fence");

  const released = await releaseJobFanObservationReadLease({
    db, job: job("job-a"), deviceId: "device-a", leaseRevision: 9, readLeaseToken: first.token,
  });
  assert.equal(released.released, true);
});



test("INT5.5D-2 creator fence is shared across Point Refresh, SFS and Subscriber producer families", async () => {
  const db = memoryDb();
  const sfs = await acquireFanObservationReadLease({
    db, jobId: "job-sfs", agencyId: "agency-1", creatorId: "creator-1",
    deviceId: "device-a", leaseRevision: 1, purpose: "sfs_target_discovery", requestId: "sfs-request-000001",
  });
  assert.equal(sfs.acquired, true);

  const subscriberBlocked = await acquireFanObservationReadLease({
    db, jobId: "job-subscriber", agencyId: "agency-1", creatorId: "creator-1",
    deviceId: "device-b", leaseRevision: 1, purpose: "subscriber_directory_page", requestId: "subscriber-request-1",
  });
  const refreshBlocked = await acquireFanObservationReadLease({
    db, jobId: "job-refresh", agencyId: "agency-1", creatorId: "creator-1",
    deviceId: "device-c", leaseRevision: 1, purpose: "fan_data_point_refresh", requestId: "refresh-request-0001",
  });
  assert.equal(subscriberBlocked.acquired, false);
  assert.equal(refreshBlocked.acquired, false);

  await releaseJobFanObservationReadLease({
    db, job: job("job-sfs"), deviceId: "device-a", leaseRevision: 1, readLeaseToken: sfs.token,
  });
  const subscriber = await acquireFanObservationReadLease({
    db, jobId: "job-subscriber", agencyId: "agency-1", creatorId: "creator-1",
    deviceId: "device-b", leaseRevision: 1, purpose: "subscriber_directory_page", requestId: "subscriber-request-2",
  });
  assert.equal(subscriber.acquired, true);
});

test("INT5.5D-1 source wiring makes new point-refresh jobs read-lease required and keeps old jobs rollout-compatible", () => {
  const root = path.resolve(__dirname, "../..");
  const authority = fs.readFileSync(path.join(root, "src/services/fan-data-authority-service.js"), "utf8");
  const jobs = fs.readFileSync(path.join(root, "src/services/job-lease-service.js"), "utf8");
  const routes = fs.readFileSync(path.join(root, "src/routes/jobs.js"), "utf8");
  const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(root, "prisma/migrations/20260917150000_phase3_fan_observation_read_lease/migration.sql"), "utf8");

  assert.match(authority, /observationTokenVersion: 1, observationReadLeaseVersion: 1/);
  assert.match(jobs, /FAN_OBSERVATION_READ_LEASE_JOB_KEYS\.has\(String\(candidate\.jobKey[\s\S]*observationTokenVersion: 1, observationReadLeaseVersion: 1/, "first claim after cutover must upgrade all causal-read jobs before execution");
  assert.match(jobs, /readLeaseRequired = Number\(job\?\.params\?\.observationReadLeaseVersion \|\| 0\) >= 1/);
  assert.match(jobs, /FAN_OBSERVATION_READ_LEASE_REQUIRED/);
  assert.match(jobs, /fanObservationReadLease\.updateMany\([\s\S]*expiresAt: new Date\(now\.getTime\(\) \+ FAN_OBSERVATION_READ_LEASE_TTL_MS\)/, "normal job keepalive must extend an in-flight causal read fence");
  assert.match(jobs, /sweepExpiredLeases[\s\S]*fanObservationReadLease\?\.deleteMany[\s\S]*jobId: job\.id[\s\S]*leaseRevision: job\.leaseRevision/, "expired job lease must release its creator causal fence in the same transaction");
  assert.match(jobs, /return createFanObservationToken\(\{ db: tx, job, deviceId, leaseRevision, purpose, subjects \}\)/, "legacy jobs must retain the pre-cutover token path");
  assert.match(routes, /observation-read-lease\/acquire/);
  assert.match(routes, /observation-read-lease\/release/);
  assert.match(schema, /model FanObservationReadLease[\s\S]*creatorId\s+String\s+@id/);
  assert.match(migration, /PRIMARY KEY \("creatorId"\)/);
  assert.match(migration, /num_nonnulls\("jobId", "deliveryId"\) = 1/);
});
