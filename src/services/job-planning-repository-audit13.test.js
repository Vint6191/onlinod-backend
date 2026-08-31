"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };

const controlEventsPath = require.resolve("./desktop-control-events");
const published = [];
require.cache[controlEventsPath] = {
  id: controlEventsPath,
  filename: controlEventsPath,
  loaded: true,
  exports: { publishDesktopControlEvent: (event) => { published.push(event); return event; } },
};

const {
  scheduledResetData,
  ensurePlannedJob,
  reschedulePlannedJob,
  updatePlannedJobDemand,
} = require("./job-planning-repository");

function makeDb(seed = []) {
  const rows = new Map(seed.map((row) => [row.id, { leaseRevision: 0, ...row }]));
  return {
    rows,
    jobInstance: {
      async findUnique({ where }) {
        if (where.id) return rows.get(where.id) || null;
        if (where.idempotencyKey) return [...rows.values()].find((row) => row.idempotencyKey === where.idempotencyKey) || null;
        return null;
      },
      async createMany({ data }) {
        const row = data[0];
        if ([...rows.values()].some((item) => item.idempotencyKey === row.idempotencyKey)) return { count: 0 };
        const stored = { id: `job-${rows.size + 1}`, leaseRevision: 0, attempts: 0, ...row };
        rows.set(stored.id, stored);
        return { count: 1 };
      },
      async updateMany({ where, data }) {
        const row = rows.get(where.id);
        if (!row) return { count: 0 };
        if (where.leaseRevision !== undefined && Number(row.leaseRevision) !== Number(where.leaseRevision)) return { count: 0 };
        if (where.status?.notIn?.includes(row.status)) return { count: 0 };
        const next = { ...row };
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "increment")) {
            next[key] = Number(next[key] || 0) + Number(value.increment || 0);
          } else {
            next[key] = value;
          }
        }
        rows.set(row.id, next);
        return { count: 1 };
      },
    },
  };
}

test("planning reset clears every lease/access/execution field and bumps leaseRevision", () => {
  const data = scheduledResetData({ params: { x: 1 }, priority: 9, scheduledAt: new Date("2026-08-31T00:00:00Z") });
  assert.equal(data.status, "SCHEDULED");
  assert.deepEqual(data.leaseRevision, { increment: 1 });
  for (const field of ["claimedAt", "claimedByDeviceId", "leaseUntil", "leaseTokenHash", "leaseMemberId", "leaseAccessEpoch", "workId", "lastProgressAt", "startedAt", "completedAt", "lastError", "result"]) {
    assert.equal(data[field], null, field);
  }
  assert.equal(data.attempts, 0);
});

test("idempotent plan creates once and publishes one wakeup", async () => {
  published.length = 0;
  const db = makeDb();
  const input = { db, jobKey: "x", creatorId: "c1", agencyId: "a1", idempotencyKey: "k1", params: {}, priority: 5 };
  const a = await ensurePlannedJob(input);
  const b = await ensurePlannedJob(input);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.job.id, b.job.id);
  assert.equal(published.length, 1);
  assert.equal(published[0].type, "JOB_AVAILABLE");
});

test("reschedule invalidates an old lease generation instead of silently reusing it", async () => {
  published.length = 0;
  const db = makeDb([{ id: "j1", idempotencyKey: "k1", jobKey: "x", creatorId: "c1", agencyId: "a1", status: "FAILED", leaseRevision: 7, leaseMemberId: "m1", leaseAccessEpoch: 4, attempts: 3, params: {} }]);
  const result = await ensurePlannedJob({
    db, jobKey: "x", creatorId: "c1", agencyId: "a1", idempotencyKey: "k1", params: { fresh: true }, priority: 10,
    resetExisting: true,
  });
  assert.equal(result.rescheduled, true);
  assert.equal(result.job.status, "SCHEDULED");
  assert.equal(result.job.leaseRevision, 8);
  assert.equal(result.job.leaseMemberId, null);
  assert.equal(result.job.leaseAccessEpoch, null);
  assert.equal(result.job.attempts, 0);
  assert.deepEqual(result.job.params, { fresh: true });
  assert.equal(published.length, 1);
});

test("claimed execution ownership is fail-closed against planner reset", async () => {
  const db = makeDb([{ id: "j1", idempotencyKey: "k1", jobKey: "x", creatorId: "c1", agencyId: "a1", status: "CLAIMED", leaseRevision: 5, params: {} }]);
  const result = await ensurePlannedJob({
    db, jobKey: "x", creatorId: "c1", agencyId: "a1", idempotencyKey: "k1", params: { newer: true }, resetExisting: true,
  });
  assert.equal(result.rescheduled, false);
  assert.equal(result.reason, "protected_claimed");
  assert.equal(result.job.status, "CLAIMED");
  assert.equal(result.job.leaseRevision, 5);
});

test("leaseRevision CAS prevents a stale planner reset from winning", async () => {
  const db = makeDb([{ id: "j1", jobKey: "x", creatorId: "c1", agencyId: "a1", status: "FAILED", leaseRevision: 2, params: {} }]);
  const stale = { ...(await db.jobInstance.findUnique({ where: { id: "j1" } })) };
  db.rows.set("j1", { ...db.rows.get("j1"), leaseRevision: 3, status: "CLAIMED" });
  const result = await reschedulePlannedJob({ db, job: stale, params: { stale: true } });
  assert.equal(result.rescheduled, false);
  assert.equal(result.job.status, "CLAIMED");
  assert.equal(result.job.leaseRevision, 3);
});


test("demand update is CAS-fenced and never resets execution ownership", async () => {
  const db = makeDb([{ id: "j1", idempotencyKey: "k1", jobKey: "x", creatorId: "c1", agencyId: "a1", status: "CLAIMED", leaseRevision: 9, priority: 10, params: { old: true } }]);
  const job = await db.jobInstance.findUnique({ where: { id: "j1" } });
  const result = await updatePlannedJobDemand({ db, job, priority: 30, params: { demand: true }, nextRunAt: new Date("2026-08-31T01:00:00Z") });
  assert.equal(result.updated, true);
  assert.equal(result.job.status, "CLAIMED");
  assert.equal(result.job.leaseRevision, 9);
  assert.equal(result.job.priority, 30);
  assert.deepEqual(result.job.params, { demand: true });
  assert.equal(result.job.nextRunAt, undefined);
});
