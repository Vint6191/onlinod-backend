"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { stableValue, bucketTimestamp, buildJobIdempotencyKey } = require("./job-idempotency");

test("stableValue sorts nested object keys", () => {
  assert.deepEqual(stableValue({ z: 1, a: { y: 2, b: 3 } }), { a: { b: 3, y: 2 }, z: 1 });
});

test("job idempotency is stable inside a bucket and independent of key order", () => {
  const first = buildJobIdempotencyKey({
    jobKey: "fetch_earnings",
    creatorId: "creator-1",
    params: { rangeKey: "7d", nested: { b: 2, a: 1 } },
    bucketAt: new Date("2026-07-14T10:10:00.000Z"),
    bucketMs: 60 * 60 * 1000,
  });
  const second = buildJobIdempotencyKey({
    jobKey: "fetch_earnings",
    creatorId: "creator-1",
    params: { nested: { a: 1, b: 2 }, rangeKey: "7d" },
    bucketAt: new Date("2026-07-14T10:59:59.000Z"),
    bucketMs: 60 * 60 * 1000,
  });
  assert.equal(first, second);
});

test("job idempotency changes across buckets", () => {
  const a = buildJobIdempotencyKey({ jobKey: "x", bucketAt: "2026-07-14T10:59:59Z", bucketMs: 3_600_000 });
  const b = buildJobIdempotencyKey({ jobKey: "x", bucketAt: "2026-07-14T11:00:00Z", bucketMs: 3_600_000 });
  assert.notEqual(a, b);
  assert.equal(bucketTimestamp("2026-07-14T10:59:59Z", 3_600_000), Date.parse("2026-07-14T10:00:00Z"));
});
