"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaId = require.resolve("../prisma");
require.cache[prismaId] = { id: prismaId, filename: prismaId, loaded: true, exports: {} };
delete require.cache[require.resolve("./notification-facts-service")];
const {
  normalizeEvent,
  identityFingerprint,
  coverageComplete,
  ingestNotificationFacts,
} = require("./notification-facts-service");

const creatorId = "creator-1";
const occurredAt = "2026-08-05T20:00:00.000Z";
const scanRunId = "scan-run-test-0001";

function same(left, right) {
  if (left instanceof Date || right instanceof Date) return new Date(left).getTime() === new Date(right).getTime();
  return left === right;
}
function matchWhere(row, where = {}) {
  for (const [key, expected] of Object.entries(where)) {
    if (key === "OR") {
      if (!expected.some((clause) => matchWhere(row, clause))) return false;
      continue;
    }
    if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
      if (Object.hasOwn(expected, "in")) {
        if (!expected.in.some((value) => same(row[key], value))) return false;
        continue;
      }
      if (Object.hasOwn(expected, "not")) {
        if (same(row[key], expected.not)) return false;
        continue;
      }
    }
    if (!same(row[key], expected)) return false;
  }
  return true;
}
function memoryDb() {
  const store = { batches: [], fans: [], sales: [], tips: [], subscriptions: [], likes: [], comments: [], coverage: [], notificationSync: null };
  let sequence = 0;
  const nextId = (prefix) => `${prefix}-${++sequence}`;
  const clone = (value) => structuredClone(value);
  const uniqueConflict = (name, rows, data) => {
    if (name === "fan") return rows.some((row) => row.creatorId === data.creatorId && row.onlyFansUserId === data.onlyFansUserId);
    if (["sale", "tip", "subscription", "like", "comment"].includes(name)) {
      return rows.some((row) => row.creatorId === data.creatorId && (
        row.eventFingerprint === data.eventFingerprint
        || (data.externalNotificationId && row.externalNotificationId === data.externalNotificationId)
        || (name === "like" && data.onlyFansLikeId && row.onlyFansLikeId === data.onlyFansLikeId)
        || (name === "comment" && data.onlyFansCommentId && row.onlyFansCommentId === data.onlyFansCommentId)
        || (!["subscription", "like", "comment"].includes(name) && data.externalTransactionId && row.externalTransactionId === data.externalTransactionId)
      ));
    }
    if (name === "coverage") {
      return rows.some((row) => row.creatorId === data.creatorId && row.dataType === data.dataType
        && same(row.coverageDate, data.coverageDate) && row.sourceTimezone === data.sourceTimezone);
    }
    return false;
  };
  const model = (name, rows) => ({
    async findUnique({ where }) {
      if (where.idempotencyKey) return clone(rows.find((row) => row.idempotencyKey === where.idempotencyKey) || null);
      if (where.id) return clone(rows.find((row) => row.id === where.id) || null);
      return null;
    },
    async findMany({ where }) { return clone(rows.filter((row) => matchWhere(row, where))); },
    async create({ data }) {
      if (uniqueConflict(name, rows, data)) { const error = new Error("unique"); error.code = "P2002"; throw error; }
      const row = { id: data.id || nextId(name), createdAt: new Date(), updatedAt: new Date(), ...clone(data) };
      rows.push(row); return clone(row);
    },
    async createMany({ data, skipDuplicates }) {
      let count = 0;
      for (const input of data) {
        if (uniqueConflict(name, rows, input)) {
          if (skipDuplicates) continue;
          const error = new Error("unique"); error.code = "P2002"; throw error;
        }
        rows.push({ id: input.id || nextId(name), createdAt: new Date(), updatedAt: new Date(), ...clone(input) });
        count += 1;
      }
      return { count };
    },
    async update({ where, data }) {
      const row = rows.find((item) => item.id === where.id);
      if (!row) throw new Error(`${name} missing`);
      Object.assign(row, clone(data), { updatedAt: new Date() });
      return clone(row);
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const row of rows) {
        if (!matchWhere(row, where)) continue;
        Object.assign(row, clone(data), { updatedAt: new Date() }); count += 1;
      }
      return { count };
    },
  });
  const db = {
    store,
    creatorAccount: { async findFirst({ where }) { return where.id === creatorId && where.agencyId === "agency-1" ? { id: creatorId } : null; } },
    workerDevice: { async findFirst({ where }) { return where.id === "device-1" && where.agencyId === "agency-1" ? { id: "device-1" } : null; } },
    analyticsIngestBatch: model("batch", store.batches),
    creatorFan: model("fan", store.fans),
    creatorSale: model("sale", store.sales),
    creatorTip: model("tip", store.tips),
    creatorSubscriptionEvent: model("subscription", store.subscriptions),
    creatorPostLike: model("like", store.likes),
    creatorPostComment: model("comment", store.comments),
    analyticsCoverage: model("coverage", store.coverage),
    creatorNotificationSyncState: {
      async findUnique() { return clone(store.notificationSync); },
    },
    async $transaction(callback) { return callback(db); },
  };
  return db;
}
function job(overrides = {}) {
  return {
    id: "job-1", agencyId: "agency-1", creatorId,
    params: {
      from: "2026-08-05T00:00:00.000Z",
      to: "2026-08-05T23:59:59.999Z",
      types: ["purchases", "tips", "subscriptions"],
    },
    ...overrides,
  };
}
function completeResult(events, coverage = {}) {
  const baseCoverage = {
    purchases: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 },
    tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 },
    subscriptions: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 },
  };
  for (const [type, override] of Object.entries(coverage)) {
    const status = override?.status || baseCoverage[type]?.status || "partial";
    baseCoverage[type] = {
      ...(baseCoverage[type] || { pages: 0, events: 0, rejected: 0 }),
      ...override,
      reason: override?.reason || (status === "complete" ? "source_exhausted" : "coverage_unproven"),
    };
  }
  return {
    collectorVersion: "notifications-catchup-v4", schemaVersion: 3, sourceTimezone: "UTC",
    scanRunId, batchKey: `run:${scanRunId}:completion`, finalizeCoverage: true,
    coverage: baseCoverage,
    events,
  };
}

function fullHistoryResult(events, coverage = {}) {
  const result = completeResult(events, coverage);
  return {
    ...result,
    collectorVersion: "notifications-history-v7-native-filters",
    schemaVersion: 5,
  };
}

test("purchases keep post and message identities mutually exclusive and never persist body text", () => {
  const message = normalizeEvent({ eventType: "ppv_purchase_unresolved", notificationId: "n-1", fanId: "fan-1", messageId: "m-1", amountCents: 2500, purchasedAt: occurredAt, text: "secret" }, creatorId);
  const post = normalizeEvent({ eventType: "ppv_purchase_unresolved", notificationId: "n-2", fanId: "fan-1", postId: "p-1", messageId: "must-be-cleared", amountCents: 1500, purchasedAt: occurredAt }, creatorId);
  assert.equal(message.saleType, "MESSAGE");
  assert.equal(message.messageId, "m-1");
  assert.equal(Object.hasOwn(message, "text"), false);
  assert.equal(post.saleType, "POST");
  assert.equal(post.postId, "p-1");
  assert.equal(post.messageId, null);
});

test("tips and subscription lifecycle events preserve strict semantics", () => {
  assert.equal(normalizeEvent({ eventType: "tip_received", fanId: "fan", amountCents: 500, occurredAt }, creatorId).kind, "tip");
  assert.equal(normalizeEvent({ eventType: "free_subscribed", fanId: "fan", amountCents: 0, occurredAt }, creatorId).eventType, "SUBSCRIBED_FREE");
  const unknown = normalizeEvent({ eventType: "subscription_subscribed_unknown", fanId: "fan", amountCents: null, occurredAt }, creatorId);
  assert.equal(unknown.eventType, "SUBSCRIBED_UNKNOWN");
  assert.equal(unknown.observedPriceCents, null);
  assert.equal(normalizeEvent({ eventType: "subscription_renewed", fanId: "fan", amountCents: 1000, occurredAt }, creatorId).eventType, "RENEWED");
  assert.equal(normalizeEvent({ eventType: "auto_renew_disabled", fanId: "fan", occurredAt }, creatorId).eventType, "AUTO_RENEW_DISABLED");
  assert.equal(normalizeEvent({ eventType: "subscription_expired", fanId: "fan", occurredAt }, creatorId).eventType, "EXPIRED");
});



test("subscription identity dedupes websocket variants and Notifications ALL within the same UTC minute", () => {
  const fromNewMessage = normalizeEvent({
    eventType: "free_subscribed",
    notificationId: "110375912038",
    fanId: "93955631",
    amountCents: 0,
    occurredAt: "2026-05-12T16:03:00.000Z",
  }, creatorId);
  const fromSubscribedFrame = normalizeEvent({
    eventType: "free_subscribed",
    fanId: "93955631",
    amountCents: 0,
    occurredAt: "2026-05-12T16:03:55.000Z",
  }, creatorId);
  const fromNotificationsAll = normalizeEvent({
    eventType: "free_subscribed",
    notificationId: "110375912038",
    externalEventId: "110375912038",
    fanId: "93955631",
    amountCents: 0,
    occurredAt: "2026-05-12T16:03:00.000Z",
  }, creatorId);
  assert.equal(fromNewMessage.kind, "subscription");
  assert.equal(fromNewMessage.fingerprint, fromSubscribedFrame.fingerprint);
  assert.equal(fromNewMessage.fingerprint, fromNotificationsAll.fingerprint);
});


test("weaker subscribed frames cannot erase an authoritative notification identity", async () => {
  const db = memoryDb();
  const first = completeResult([{
    eventType: "free_subscribed",
    notificationId: "110375912038",
    fanId: "93955631",
    amountCents: 0,
    subscribedAt: "2026-08-05T20:00:00.000Z",
  }]);
  await ingestNotificationFacts({ job: job({ id: "job-subscription-strong" }), deviceId: "device-1", result: first, db });

  const secondRunId = "scan-run-test-0002";
  const second = completeResult([{
    eventType: "free_subscribed",
    fanId: "93955631",
    amountCents: 0,
    subscribedAt: "2026-08-05T20:00:55.000Z",
  }]);
  second.scanRunId = secondRunId;
  second.batchKey = `run:${secondRunId}:completion`;
  await ingestNotificationFacts({ job: job({ id: "job-subscription-weak" }), deviceId: "device-1", result: second, db });

  assert.equal(db.store.subscriptions.length, 1);
  assert.equal(db.store.subscriptions[0].externalNotificationId, "110375912038");
  assert.equal(db.store.subscriptions[0].occurredAt.toISOString(), "2026-08-05T20:00:00.000Z");
  assert.equal(db.store.subscriptions[0].sourceJobId, "job-subscription-strong");
});

test("same-batch subscription variants keep the richest source identity", async () => {
  const db = memoryDb();
  const result = completeResult([
    {
      eventType: "free_subscribed",
      notificationId: "110375912038",
      fanId: "93955631",
      amountCents: 0,
      subscribedAt: "2026-08-05T20:00:00.000Z",
    },
    {
      eventType: "free_subscribed",
      fanId: "93955631",
      amountCents: 0,
      subscribedAt: "2026-08-05T20:00:55.000Z",
    },
  ]);
  await ingestNotificationFacts({ job: job({ id: "job-subscription-batch" }), deviceId: "device-1", result, db });

  assert.equal(db.store.subscriptions.length, 1);
  assert.equal(db.store.subscriptions[0].externalNotificationId, "110375912038");
  assert.equal(db.store.subscriptions[0].occurredAt.toISOString(), "2026-08-05T20:00:00.000Z");
});


test("different strong subscription ids in the same semantic minute fail closed", async () => {
  const db = memoryDb();
  const result = completeResult([
    {
      eventType: "free_subscribed",
      notificationId: "notification-a",
      fanId: "93955631",
      amountCents: 0,
      subscribedAt: "2026-08-05T20:00:00.000Z",
    },
    {
      eventType: "free_subscribed",
      notificationId: "notification-b",
      fanId: "93955631",
      amountCents: 0,
      subscribedAt: "2026-08-05T20:00:30.000Z",
    },
  ]);
  const response = await ingestNotificationFacts({ job: job({ id: "job-subscription-collision" }), deviceId: "device-1", result, db });

  assert.equal(db.store.subscriptions.length, 1);
  assert.equal(response.rejected, 1);
  assert.equal(response.status, "PARTIAL");
});

test("strict normalization rejects coercion, missing timestamps and unknown money", () => {
  assert.equal(normalizeEvent({ eventType: "tip_received", fanId: "fan", amountCents: "500", occurredAt }, creatorId).rejected, "INVALID_TIP_AMOUNT_CENTS");
  assert.equal(normalizeEvent({ eventType: "tip_received", fanId: "fan", amountCents: 500, occurredAt: false }, creatorId).rejected, "INVALID_OCCURRED_AT");
  assert.equal(normalizeEvent({ eventType: "ppv_purchase_unresolved", fanId: "fan", occurredAt }, creatorId).rejected, "INVALID_SALE_AMOUNT_CENTS");
  assert.equal(normalizeEvent({ eventType: "like", fanId: "fan", amountCents: 0, occurredAt }, creatorId).rejected, "LIKE_SOURCE_IDENTITY_MISSING");
  assert.equal(normalizeEvent({ eventType: "like", notificationId: "like-n", fanId: "fan", amountCents: 0, occurredAt }, creatorId).rejected, "LIKE_POST_ID_MISSING");
  assert.equal(normalizeEvent({ eventType: "comment", fanId: "fan", occurredAt }, creatorId).rejected, "COMMENT_SOURCE_IDENTITY_MISSING");
  assert.equal(normalizeEvent({ eventType: "comment", notificationId: "comment-n", fanId: "fan", occurredAt }, creatorId).rejected, "COMMENT_POST_ID_MISSING");
});



test("likes and comments normalize and ingest as relational post facts without comment text", async () => {
  const like = normalizeEvent({ eventType: "post_liked", notificationId: "like-n", fanId: "fan-1", postId: "post-1", likeId: "like-1", occurredAt, text: "must-not-persist" }, creatorId);
  const comment = normalizeEvent({ eventType: "post_commented", notificationId: "comment-n", fanId: "fan-2", postId: "post-1", commentId: "comment-1", occurredAt, text: "private comment body" }, creatorId);
  assert.equal(like.kind, "like");
  assert.equal(comment.kind, "comment");
  assert.equal(Object.hasOwn(like, "text"), false);
  assert.equal(Object.hasOwn(comment, "text"), false);

  const db = memoryDb();
  const scopedJob = job({ params: { from: "2026-08-05T00:00:00.000Z", to: "2026-08-05T23:59:59.999Z", types: ["likes", "comments"] } });
  const result = completeResult([
    { eventType: "post_liked", notificationId: "like-n", fanId: "fan-1", postId: "post-1", likeId: "like-1", occurredAt },
    { eventType: "post_commented", notificationId: "comment-n", fanId: "fan-2", postId: "post-1", commentId: "comment-1", occurredAt },
  ], {
    likes: { status: "complete", reason: "source_exhausted", pages: 1, events: 1, rejected: 0 },
    comments: { status: "complete", reason: "source_exhausted", pages: 1, events: 1, rejected: 0 },
  });
  result.coverage = { likes: result.coverage.likes, comments: result.coverage.comments };
  const ingested = await ingestNotificationFacts({ job: scopedJob, deviceId: "device-1", result, db });
  assert.equal(ingested.status, "COMMITTED");
  assert.equal(db.store.likes.length, 1);
  assert.equal(db.store.comments.length, 1);
  assert.equal(db.store.likes[0].onlyFansPostId, "post-1");
  assert.equal(db.store.likes[0].onlyFansLikeId, "like-1");
  assert.equal(db.store.comments[0].onlyFansCommentId, "comment-1");
  assert.equal(Object.hasOwn(db.store.comments[0], "text"), false);
});

test("likes and comments prefer concrete source IDs over notification envelope IDs", () => {
  const date = new Date(occurredAt);
  assert.equal(
    identityFingerprint("like", creatorId, { notificationId: "envelope-a", likeId: "like-1" }, date, null),
    identityFingerprint("like", creatorId, { notificationId: "envelope-b", likeId: "like-1" }, date, null),
  );
  assert.equal(
    identityFingerprint("comment", creatorId, { notificationId: "envelope-a", commentId: "comment-1" }, date, null),
    identityFingerprint("comment", creatorId, { notificationId: "envelope-b", commentId: "comment-1" }, date, null),
  );
});

test("stable external notification identity ignores mutable amount corrections", () => {
  const date = new Date(occurredAt);
  assert.equal(
    identityFingerprint("sale", creatorId, { notificationId: "n-1" }, date, 100),
    identityFingerprint("sale", creatorId, { notificationId: "n-1" }, date, 900),
  );
});

test("coverage completes only when every requested source proves completion", () => {
  const scopedJob = job();
  assert.equal(coverageComplete(completeResult([]), scopedJob), true);
  assert.equal(coverageComplete(completeResult([], { tips: { status: "partial", reason: "coverage_unproven", pages: 1, events: 0, rejected: 0 } }), scopedJob), false);
});

test("transactional ingest creates relational facts, subtype coverage and idempotent replay", async () => {
  const db = memoryDb();
  const result = completeResult([
    { eventType: "ppv_purchase_unresolved", notificationId: "sale-n", fanId: "fan-1", messageId: "m-1", amountCents: 2500, currency: "USD", occurredAt },
    { eventType: "tip_received", notificationId: "tip-n", fanId: "fan-1", amountCents: 500, currency: "USD", occurredAt },
    { eventType: "free_subscribed", notificationId: "sub-n", fanId: "fan-2", amountCents: 0, currency: "USD", occurredAt },
  ]);
  const first = await ingestNotificationFacts({ job: job(), deviceId: "device-1", result, db });
  assert.equal(first.status, "COMMITTED");
  assert.deepEqual(first.coverageByType, { purchases: "complete", tips: "complete", subscriptions: "complete" });
  assert.equal(first.inserted, 3);
  assert.equal(db.store.fans.length, 2);
  assert.equal(db.store.sales.length, 1);
  assert.equal(db.store.tips.length, 1);
  assert.equal(db.store.subscriptions.length, 1);
  assert.deepEqual(new Set(db.store.coverage.map((row) => row.dataType)), new Set(["NOTIFICATION_PURCHASES", "NOTIFICATION_TIPS", "NOTIFICATION_SUBSCRIPTIONS"]));
  assert.ok(db.store.coverage.every((row) => row.status === "COMPLETE"));

  const replay = await ingestNotificationFacts({ job: job(), deviceId: "device-1", result, db });
  assert.equal(replay.replayed, true);
  assert.equal(db.store.sales.length, 1);
});

test("a rejected tip keeps only tip coverage partial", async () => {
  const db = memoryDb();
  const result = completeResult([
    { eventType: "ppv_purchase_unresolved", notificationId: "sale", fanId: "fan", messageId: "m", amountCents: 100, occurredAt },
    { eventType: "tip_received", notificationId: "tip", fanId: "fan", amountCents: null, occurredAt },
  ]);
  const applied = await ingestNotificationFacts({ job: job(), deviceId: null, result, db });
  assert.equal(applied.status, "PARTIAL");
  assert.deepEqual(applied.coverageByType, { purchases: "complete", tips: "partial", subscriptions: "complete" });
});

test("ingest requires explicit strict range and rejects events outside it", async () => {
  const db = memoryDb();
  await assert.rejects(
    ingestNotificationFacts({ job: job({ params: { types: ["tips"] } }), result: completeResult([]), db }),
    (error) => error.code === "NOTIFICATION_RANGE_REQUIRED",
  );
  const applied = await ingestNotificationFacts({
    job: job({ id: "job-outside", params: { from: "2026-08-05T00:00:00.000Z", to: "2026-08-05T01:00:00.000Z", types: ["tips"] } }),
    result: completeResult([{ eventType: "tip_received", notificationId: "late", fanId: "fan", amountCents: 100, occurredAt: "2026-08-06T20:00:00.000Z" }]),
    db,
  });
  assert.equal(applied.rejected, 1);
  assert.equal(applied.coverageByType.tips, "partial");
});

test("oversized final batches are rejected rather than silently truncated", async () => {
  const events = Array.from({ length: 2001 }, (_, index) => ({ eventType: "tip_received", notificationId: `n-${index}`, fanId: "fan", amountCents: 100, occurredAt }));
  await assert.rejects(
    ingestNotificationFacts({ job: job(), result: completeResult(events), db: memoryDb() }),
    (error) => error.code === "NOTIFICATION_BATCH_TOO_LARGE",
  );
});

test("page batches commit facts incrementally and completion only finalizes coverage", async () => {
  const db = memoryDb();
  const scopedJob = job({ id: "job-chunk", params: { from: "2026-08-05T00:00:00.000Z", to: "2026-08-05T23:59:59.999Z", types: ["tips"] } });
  const page = await ingestNotificationFacts({
    job: scopedJob,
    deviceId: null,
    db,
    result: {
      batchKey: `run:${scanRunId}:page:tips:abc`,
      notificationType: "tips",
      finalizeCoverage: false,
      collectorVersion: "notifications-catchup-v4",
      schemaVersion: 3,
      scanRunId,
      sourceTimezone: "UTC",
      coverage: { tips: { status: "partial", reason: "coverage_unproven", pages: 1, events: 0, rejected: 0 } },
      events: [{ eventType: "tip_received", notificationId: "tip-page", fanId: "fan", amountCents: 700, occurredAt }],
    },
  });
  assert.equal(page.status, "COMMITTED");
  assert.equal(db.store.tips.length, 1);
  assert.equal(db.store.coverage.length, 0);

  const completion = await ingestNotificationFacts({
    job: scopedJob,
    deviceId: null,
    db,
    result: {
      batchKey: `run:${scanRunId}:completion`,
      finalizeCoverage: true,
      collectorVersion: "notifications-catchup-v4",
      schemaVersion: 3,
      scanRunId,
      sourceTimezone: "UTC",
      coverage: { tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 } },
      events: [],
    },
  });
  assert.equal(completion.status, "COMMITTED");
  assert.equal(completion.coverageByType.tips, "complete");
  assert.equal(db.store.tips.length, 1);
  assert.equal(db.store.coverage.length, 1);
});

test("a rejected incremental page prevents final coverage from becoming complete", async () => {
  const db = memoryDb();
  const scopedJob = job({
    id: "job-partial-page",
    params: {
      from: "2026-08-05T00:00:00.000Z",
      to: "2026-08-05T23:59:59.999Z",
      types: ["tips"],
    },
  });
  const page = await ingestNotificationFacts({
    job: scopedJob,
    db,
    result: {
      batchKey: `run:${scanRunId}:page:tips:rejected`,
      notificationType: "tips",
      finalizeCoverage: false,
      collectorVersion: "notifications-catchup-v4",
      schemaVersion: 3,
      scanRunId,
      sourceTimezone: "UTC",
      coverage: { tips: { status: "partial", reason: "coverage_unproven", pages: 1, events: 0, rejected: 0 } },
      events: [{ eventType: "tip_received", notificationId: "bad-tip", fanId: "fan", amountCents: null, occurredAt }],
    },
  });
  assert.equal(page.status, "PARTIAL");
  assert.equal(page.rejected, 1);

  const completion = await ingestNotificationFacts({
    job: scopedJob,
    db,
    result: {
      batchKey: `run:${scanRunId}:completion`,
      finalizeCoverage: true,
      collectorVersion: "notifications-catchup-v4",
      schemaVersion: 3,
      scanRunId,
      sourceTimezone: "UTC",
      coverage: { tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 } },
      events: [],
    },
  });
  assert.equal(completion.status, "PARTIAL");
  assert.equal(completion.coverageComplete, false);
  assert.equal(completion.coverageByType.tips, "partial");
  assert.ok(db.store.coverage.every((row) => row.status !== "COMPLETE"));
});

test("idempotent completion replay reads persisted partial coverage instead of trusting scanner flags", async () => {
  const db = memoryDb();
  const scopedJob = job({
    id: "job-partial-replay",
    params: {
      from: "2026-08-05T00:00:00.000Z",
      to: "2026-08-05T23:59:59.999Z",
      types: ["tips"],
    },
  });
  await ingestNotificationFacts({
    job: scopedJob,
    db,
    result: {
      batchKey: `run:${scanRunId}:page:tips:rejected`,
      notificationType: "tips",
      finalizeCoverage: false,
      collectorVersion: "notifications-catchup-v4",
      schemaVersion: 3,
      scanRunId,
      sourceTimezone: "UTC",
      coverage: { tips: { status: "partial", reason: "coverage_unproven", pages: 1, events: 0, rejected: 0 } },
      events: [{ eventType: "tip_received", notificationId: "bad-tip-replay", fanId: "fan", amountCents: null, occurredAt }],
    },
  });
  const finalResult = {
    batchKey: `run:${scanRunId}:completion`,
    finalizeCoverage: true,
    collectorVersion: "notifications-catchup-v4",
    schemaVersion: 3,
    scanRunId,
    sourceTimezone: "UTC",
    coverage: { tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 } },
    events: [],
  };
  const first = await ingestNotificationFacts({ job: scopedJob, db, result: finalResult });
  assert.equal(first.status, "PARTIAL");

  const replay = await ingestNotificationFacts({ job: scopedJob, db, result: finalResult });
  assert.equal(replay.replayed, true);
  assert.equal(replay.status, "PARTIAL");
  assert.equal(replay.coverageComplete, false);
  assert.equal(replay.coverageByType.tips, "partial");
});

test("unsupported job types and future schema versions fail closed", async () => {
  await assert.rejects(
    ingestNotificationFacts({
      job: job({ id: "job-invalid-type", params: { from: "2026-08-05T00:00:00.000Z", to: "2026-08-05T23:59:59.999Z", types: ["shares"] } }),
      result: completeResult([]),
      db: memoryDb(),
    }),
    (error) => error.code === "NOTIFICATION_JOB_TYPE_UNSUPPORTED",
  );
  await assert.rejects(
    ingestNotificationFacts({
      job: job({ id: "job-future-schema" }),
      result: { ...completeResult([]), schemaVersion: 999 },
      db: memoryDb(),
    }),
    (error) => error.code === "NOTIFICATION_SCHEMA_VERSION_UNSUPPORTED",
  );
});

test("duplicate identities inside one page collapse deterministically and keep the last correction", async () => {
  const db = memoryDb();
  const scopedJob = job({
    id: "job-page-correction",
    params: {
      from: "2026-08-05T00:00:00.000Z",
      to: "2026-08-05T23:59:59.999Z",
      types: ["tips"],
    },
  });
  const applied = await ingestNotificationFacts({
    job: scopedJob,
    db,
    result: {
      batchKey: `run:${scanRunId}:page:tips:correction`,
      notificationType: "tips",
      finalizeCoverage: false,
      collectorVersion: "notifications-catchup-v4",
      schemaVersion: 3,
      scanRunId,
      sourceTimezone: "UTC",
      coverage: { tips: { status: "partial", reason: "coverage_unproven", pages: 1, events: 0, rejected: 0 } },
      events: [
        { eventType: "tip_received", notificationId: "same-tip", fanId: "fan", amountCents: 500, occurredAt },
        { eventType: "tip_received", notificationId: "same-tip", fanId: "fan", amountCents: 700, occurredAt },
      ],
    },
  });
  assert.equal(applied.status, "COMMITTED");
  assert.equal(applied.inserted, 1);
  assert.equal(applied.unchanged, 1);
  assert.equal(db.store.tips.length, 1);
  assert.equal(db.store.tips[0].amountCents, 700);
});

test("incremental pages fail closed when declared type, batch key and facts disagree", async () => {
  const scopedJob = job({
    id: "job-page-type-mismatch",
    params: {
      from: "2026-08-05T00:00:00.000Z",
      to: "2026-08-05T23:59:59.999Z",
      types: ["purchases", "tips"],
    },
  });
  await assert.rejects(
    ingestNotificationFacts({
      job: scopedJob,
      db: memoryDb(),
      result: {
        batchKey: `run:${scanRunId}:page:tips:wrong-content`,
        notificationType: "tips",
        finalizeCoverage: false,
        sourceTimezone: "UTC",
        schemaVersion: 3,
        scanRunId,
        coverage: { tips: { status: "partial", reason: "coverage_unproven", pages: 1, events: 0, rejected: 0 } },
        events: [{ eventType: "ppv_purchase_unresolved", notificationId: "sale-in-tip-page", fanId: "fan", messageId: "m", amountCents: 100, occurredAt }],
      },
    }),
    (error) => error.code === "NOTIFICATION_PAGE_TYPE_MISMATCH",
  );
  await assert.rejects(
    ingestNotificationFacts({
      job: scopedJob,
      db: memoryDb(),
      result: {
        batchKey: `run:${scanRunId}:page:purchases:wrong-key`,
        notificationType: "tips",
        finalizeCoverage: false,
        sourceTimezone: "UTC",
        schemaVersion: 3,
        scanRunId,
        coverage: { tips: { status: "partial", reason: "coverage_unproven", pages: 1, events: 0, rejected: 0 } },
        events: [{ eventType: "tip_received", notificationId: "tip", fanId: "fan", amountCents: 100, occurredAt }],
      },
    }),
    (error) => error.code === "NOTIFICATION_PAGE_BATCH_KEY_MISMATCH",
  );
});

test("failed pages from an earlier scan run do not poison the current repair run", async () => {
  const db = memoryDb();
  db.store.batches.push({
    id: "earlier-v3-page",
    sourceJobId: "job-v3-upgrade",
    idempotencyKey: "notification-facts:job-v3-upgrade:run:old-scan-run:page:tips:legacy:v4",
    payloadChecksum: "legacy",
    status: "PARTIAL",
    rejectedRows: 1,
    insertedRows: 0,
    updatedRows: 0,
    unchangedRows: 0,
  });
  const scopedJob = job({
    id: "job-v3-upgrade",
    params: {
      from: "2026-08-05T00:00:00.000Z",
      to: "2026-08-05T23:59:59.999Z",
      types: ["tips"],
    },
  });
  const final = await ingestNotificationFacts({
    job: scopedJob,
    db,
    result: {
      batchKey: `run:${scanRunId}:completion`,
      finalizeCoverage: true,
      collectorVersion: "notifications-catchup-v4",
      schemaVersion: 3,
      scanRunId,
      sourceTimezone: "UTC",
      coverage: { tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 } },
      events: [],
    },
  });
  assert.equal(final.status, "COMMITTED");
  assert.equal(final.coverageByType.tips, "complete");
  assert.ok(db.store.batches.some((row) => row.idempotencyKey.endsWith(":v4")));
});

test("overlong identities and batch metadata are rejected instead of truncated into collisions", async () => {
  assert.equal(
    normalizeEvent({ eventType: "tip_received", notificationId: "n".repeat(221), fanId: "fan", amountCents: 100, occurredAt }, creatorId).rejected,
    "FIELD_TOO_LONG",
  );
  await assert.rejects(
    ingestNotificationFacts({
      job: job({ id: "job-long-batch" }),
      db: memoryDb(),
      result: { ...completeResult([]), batchKey: "x".repeat(121) },
    }),
    (error) => error.code === "NOTIFICATION_BATCH_KEY_INVALID",
  );
  await assert.rejects(
    ingestNotificationFacts({
      job: job({ id: "job-long-collector" }),
      db: memoryDb(),
      result: { ...completeResult([]), collectorVersion: "v".repeat(81) },
    }),
    (error) => error.code === "NOTIFICATION_COLLECTOR_VERSION_INVALID",
  );
});

test("schema v3 rejects legacy protocol and missing or mismatched scan-run identity", async () => {
  const scopedJob = job({ id: "job-run-identity", params: { from: "2026-08-05T00:00:00.000Z", to: "2026-08-05T23:59:59.999Z", types: ["tips"] } });
  await assert.rejects(
    ingestNotificationFacts({
      job: scopedJob,
      db: memoryDb(),
      result: {
        batchKey: "completion",
        finalizeCoverage: true,
        collectorVersion: "notifications-catchup-v4",
        schemaVersion: 3,
        sourceTimezone: "UTC",
        coverage: { tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 } },
        events: [],
      },
    }),
    (error) => error.code === "NOTIFICATION_SCAN_RUN_ID_REQUIRED",
  );
  await assert.rejects(
    ingestNotificationFacts({
      job: scopedJob,
      db: memoryDb(),
      result: {
        batchKey: "run:different-run-id:completion",
        scanRunId: "scan-run-identity-1",
        finalizeCoverage: true,
        collectorVersion: "notifications-catchup-v4",
        schemaVersion: 3,
        sourceTimezone: "UTC",
        coverage: { tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 } },
        events: [],
      },
    }),
    (error) => error.code === "NOTIFICATION_PAGE_BATCH_KEY_MISMATCH",
  );
});

test("schema 3 rejects schema 2 desktops and non-UTC coverage", async () => {
  await assert.rejects(
    ingestNotificationFacts({
      job: job({ id: "job-schema-2" }), db: memoryDb(),
      result: { ...completeResult([]), schemaVersion: 2 },
    }),
    (error) => error.code === "NOTIFICATION_SCHEMA_VERSION_UNSUPPORTED",
  );
  await assert.rejects(
    ingestNotificationFacts({
      job: job({ id: "job-non-utc" }), db: memoryDb(),
      result: { ...completeResult([]), sourceTimezone: "Europe/Kiev" },
    }),
    (error) => error.code === "NOTIFICATION_TIMEZONE_UNSUPPORTED",
  );
});

test("impossible calendar timestamps and overlong currency codes fail closed", () => {
  assert.equal(
    normalizeEvent({ eventType: "tip_received", fanId: "fan", amountCents: 100, currency: "USD", occurredAt: "2026-02-30T12:00:00Z" }, creatorId).rejected,
    "INVALID_OCCURRED_AT",
  );
  assert.equal(
    normalizeEvent({ eventType: "tip_received", fanId: "fan", amountCents: 100, currency: "USDT", occurredAt }, creatorId).rejected,
    "INVALID_CURRENCY",
  );
});

test("subscription payment and refund sharing one transaction remain two lifecycle facts", async () => {
  const db = memoryDb();
  const result = completeResult([
    { eventType: "paid_subscribed", notificationId: "sub-paid", transactionId: "tx-shared", fanId: "fan", amountCents: 1000, occurredAt },
    { eventType: "subscription_refunded", notificationId: "sub-refund", transactionId: "tx-shared", fanId: "fan", amountCents: 1000, occurredAt: "2026-08-05T21:00:00.000Z" },
  ], { purchases: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 }, tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 }, subscriptions: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 } });
  const applied = await ingestNotificationFacts({ job: job({ id: "job-sub-lifecycle" }), deviceId: "device-1", result, db });
  assert.equal(applied.status, "COMMITTED");
  assert.equal(db.store.subscriptions.length, 2);
  assert.deepEqual(new Set(db.store.subscriptions.map((row) => row.eventType)), new Set(["SUBSCRIBED_PAID", "REFUNDED"]));
  assert.ok(db.store.subscriptions.every((row) => row.externalTransactionId === "tx-shared"));
});

test("requested interval can complete while boundary UTC-day coverage remains partial", async () => {
  const db = memoryDb();
  const scopedJob = job({
    id: "job-partial-day",
    params: { from: "2026-08-05T10:00:00.000Z", to: "2026-08-05T12:00:00.000Z", types: ["tips"] },
  });
  const result = {
    ...completeResult([]),
    coverage: { tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 } },
  };
  const applied = await ingestNotificationFacts({ job: scopedJob, result, db });
  assert.equal(applied.status, "COMMITTED");
  assert.equal(applied.coverageComplete, true);
  assert.equal(db.store.coverage.length, 1);
  assert.equal(db.store.coverage[0].status, "PARTIAL");
  assert.equal(new Date(db.store.coverage[0].coveredFromAt).toISOString(), "2026-08-05T10:00:00.000Z");
  assert.equal(new Date(db.store.coverage[0].coveredToAt).toISOString(), "2026-08-05T12:00:00.000Z");
});

test("adjacent verified intervals merge into complete UTC-day coverage", async () => {
  const db = memoryDb();
  const firstRun = "scan-run-day-half-0001";
  const secondRun = "scan-run-day-half-0002";
  await ingestNotificationFacts({
    job: job({ id: "job-day-half-1", params: { from: "2026-08-05T00:00:00.000Z", to: "2026-08-05T11:59:59.999Z", types: ["tips"] } }),
    db,
    result: {
      collectorVersion: "notifications-catchup-v4", schemaVersion: 3, sourceTimezone: "UTC",
      scanRunId: firstRun, batchKey: `run:${firstRun}:completion`, finalizeCoverage: true,
      coverage: { tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 } }, events: [],
    },
  });
  await ingestNotificationFacts({
    job: job({ id: "job-day-half-2", params: { from: "2026-08-05T12:00:00.000Z", to: "2026-08-05T23:59:59.999Z", types: ["tips"] } }),
    db,
    result: {
      collectorVersion: "notifications-catchup-v4", schemaVersion: 3, sourceTimezone: "UTC",
      scanRunId: secondRun, batchKey: `run:${secondRun}:completion`, finalizeCoverage: true,
      coverage: { tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 } }, events: [],
    },
  });
  assert.equal(db.store.coverage.length, 1);
  assert.equal(db.store.coverage[0].status, "COMPLETE");
  assert.equal(new Date(db.store.coverage[0].coveredFromAt).toISOString(), "2026-08-05T00:00:00.000Z");
  assert.equal(new Date(db.store.coverage[0].coveredToAt).toISOString(), "2026-08-05T23:59:59.999Z");
});

test("events outside the exact requested interval are rejected", async () => {
  const db = memoryDb();
  const scopedJob = job({
    id: "job-exact-range",
    params: { from: "2026-08-05T10:00:00.000Z", to: "2026-08-05T12:00:00.000Z", types: ["tips"] },
  });
  const result = {
    ...completeResult([{ eventType: "tip_received", notificationId: "too-late", fanId: "fan", amountCents: 100, occurredAt: "2026-08-05T12:00:00.001Z" }]),
    coverage: { tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 } },
  };
  const applied = await ingestNotificationFacts({ job: scopedJob, result, db });
  assert.equal(applied.status, "PARTIAL");
  assert.equal(applied.rejected, 1);
  assert.equal(db.store.tips.length, 0);
});


test("full-history source exhaustion records only the OnlyFans-exposed notification window", async () => {
  const db = memoryDb();
  db.store.notificationSync = { oldestOccurredAt: new Date("2026-02-05T10:00:00.000Z") };
  const fullJob = job({
    id: "job-full-retention-boundary",
    params: {
      from: "2025-01-01T00:00:00.000Z",
      to: "2026-08-05T23:59:59.999Z",
      types: ["tips"],
      notificationMode: "full",
    },
  });
  const result = fullHistoryResult([], {
    tips: { status: "complete", reason: "source_exhausted", pages: 10, events: 0, rejected: 0 },
  });
  result.coverage = { tips: result.coverage.tips };
  const applied = await ingestNotificationFacts({ job: fullJob, result, db });
  assert.equal(applied.status, "COMMITTED");
  assert.equal(applied.coverageComplete, true);
  assert.ok(db.store.coverage.length > 100);
  assert.ok(db.store.coverage.every((row) => new Date(row.coverageDate) >= new Date("2026-02-05T00:00:00.000Z")));
  const boundary = db.store.coverage.find((row) => new Date(row.coverageDate).toISOString().slice(0, 10) === "2026-02-05");
  assert.equal(boundary.status, "PARTIAL");
  assert.equal(new Date(boundary.coveredFromAt).toISOString(), "2026-02-05T10:00:00.000Z");
  const nextDay = db.store.coverage.find((row) => new Date(row.coverageDate).toISOString().slice(0, 10) === "2026-02-06");
  assert.equal(nextDay.status, "COMPLETE");
});

test("an empty full-history stream reaches EOF without inventing pre-retention calendar coverage", async () => {
  const db = memoryDb();
  const fullJob = job({
    id: "job-full-empty-retention",
    params: {
      from: "2025-01-01T00:00:00.000Z",
      to: "2026-08-05T23:59:59.999Z",
      types: ["tips"],
      notificationMode: "full",
    },
  });
  const result = fullHistoryResult([], {
    tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 },
  });
  result.coverage = { tips: result.coverage.tips };
  const applied = await ingestNotificationFacts({ job: fullJob, result, db });
  assert.equal(applied.status, "COMMITTED");
  assert.equal(applied.coverageComplete, true);
  assert.equal(db.store.coverage.length, 0);
});

test("production transaction acquires the advisory lock before bulk fan/fact SQL", async () => {
  const db = memoryDb();
  const sqlCalls = [];
  db.$executeRawUnsafe = async (sql) => { sqlCalls.push(String(sql)); return 1; };
  const result = await ingestNotificationFacts({
    job: job({ params: { ...job().params, types: ["tips"] } }),
    deviceId: "device-1",
    result: {
      collectorVersion: "notifications-catchup-v4", schemaVersion: 3, sourceTimezone: "UTC",
      scanRunId, batchKey: `run:${scanRunId}:page:tips:lock-test`, notificationType: "tips",
      finalizeCoverage: false,
      events: [{ eventType: "tip_received", notificationId: "lock-n-1", fanId: "lock-fan", amountCents: 500, occurredAt }],
    },
    db,
  });
  assert.equal(result.status, "COMMITTED");
  assert.match(sqlCalls[0], /pg_advisory_xact_lock/);
  assert.ok(sqlCalls.some((sql) => /UPDATE "CreatorFan"/.test(sql)));
});

test("a batch committed after ensureBatch is re-read under the transaction lock and never overwrites counters", async () => {
  const db = memoryDb();
  const originalTransaction = db.$transaction;
  db.$transaction = async (callback) => {
    const batch = db.store.batches[0];
    Object.assign(batch, { status: "COMMITTED", insertedRows: 7, updatedRows: 2, unchangedRows: 1, rejectedRows: 0 });
    return originalTransaction(callback);
  };
  const result = await ingestNotificationFacts({
    job: job({ params: { ...job().params, types: ["tips"] } }),
    deviceId: "device-1",
    result: {
      collectorVersion: "notifications-catchup-v4", schemaVersion: 3, sourceTimezone: "UTC",
      scanRunId, batchKey: `run:${scanRunId}:page:tips:concurrent-test`, notificationType: "tips",
      finalizeCoverage: false,
      events: [{ eventType: "tip_received", notificationId: "concurrent-n-1", fanId: "fan", amountCents: 500, occurredAt }],
    },
    db,
  });
  assert.equal(result.replayed, true);
  assert.equal(result.inserted, 7);
  assert.equal(result.updated, 2);
  assert.equal(db.store.tips.length, 0);
  assert.equal(db.store.batches[0].insertedRows, 7);
});


test("schema 3 requires explicit events, collector, timezone and finalization fields", async () => {
  const base = completeResult([]);
  for (const [field, expectedCode] of [
    ["events", "NOTIFICATION_EVENTS_ARRAY_REQUIRED"],
    ["collectorVersion", "NOTIFICATION_COLLECTOR_VERSION_INVALID"],
    ["sourceTimezone", "NOTIFICATION_INVALID_TIMEZONE"],
    ["finalizeCoverage", "NOTIFICATION_FINALIZE_FLAG_REQUIRED"],
  ]) {
    const malformed = { ...base };
    delete malformed[field];
    await assert.rejects(
      ingestNotificationFacts({ job: job(), result: malformed, db: memoryDb() }),
      (error) => error?.code === expectedCode,
      field,
    );
  }
});

test("a repair cursor without matching persisted coverage cannot complete the requested interval", async () => {
  const db = memoryDb();
  const repairJob = job({
    params: {
      from: "2026-08-05T00:00:00.000Z",
      to: "2026-08-05T23:59:59.999Z",
      types: ["tips"],
      resumeCursors: { tips: "missing-prior-cursor" },
    },
  });
  const result = completeResult([], { tips: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 } });
  result.coverage = { tips: result.coverage.tips };
  const applied = await ingestNotificationFacts({ job: repairJob, result, db });
  assert.equal(applied.status, "PARTIAL");
  assert.equal(applied.coverageComplete, false);
  assert.equal(applied.coverageByType.tips, "partial");
  assert.equal(db.store.coverage[0].status, "FAILED");
  assert.equal(db.store.coverage[0].lastErrorCode, "NOTIFICATION_RESUME_CURSOR_UNVERIFIED");
});


test("completion coverage metadata is typed and cannot claim complete with rejected rows", async () => {
  const invalid = completeResult([]);
  invalid.coverage.tips = { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 1 };
  await assert.rejects(
    ingestNotificationFacts({ job: job(), result: invalid, db: memoryDb() }),
    (error) => error?.code === "NOTIFICATION_COVERAGE_METADATA_INVALID",
  );
  const unknownCollector = { ...completeResult([]), collectorVersion: "notifications-catchup-v999" };
  await assert.rejects(
    ingestNotificationFacts({ job: job(), result: unknownCollector, db: memoryDb() }),
    (error) => error?.code === "NOTIFICATION_COLLECTOR_VERSION_INVALID",
  );
});

test("completion idempotency checksum includes cursor and typed coverage evidence", async () => {
  const db = memoryDb();
  const scopedJob = job({
    id: "job-coverage-checksum",
    params: { from: "2026-08-05T00:00:00.000Z", to: "2026-08-05T23:59:59.999Z", types: ["tips"] },
  });
  const first = completeResult([], {
    tips: { status: "partial", reason: "page_limit", pages: 1, events: 0, rejected: 0, cursorEnd: "cursor-a" },
  });
  first.coverage = { tips: first.coverage.tips };
  const applied = await ingestNotificationFacts({ job: scopedJob, result: first, db });
  assert.equal(applied.status, "PARTIAL");

  const changed = structuredClone(first);
  changed.coverage.tips.cursorEnd = "cursor-b";
  await assert.rejects(
    ingestNotificationFacts({ job: scopedJob, result: changed, db }),
    (error) => error?.code === "ANALYTICS_INGEST_IDEMPOTENCY_CONFLICT",
  );
});

test("desktop-rejected scanner rows are counted in the completion audit and coverage error", async () => {
  const db = memoryDb();
  const scopedJob = job({
    id: "job-scanner-rejected",
    params: { from: "2026-08-05T00:00:00.000Z", to: "2026-08-05T23:59:59.999Z", types: ["tips"] },
  });
  const result = completeResult([], {
    tips: { status: "partial", reason: "invalid_rows", pages: 1, events: 0, rejected: 3 },
  });
  result.coverage = { tips: result.coverage.tips };
  const applied = await ingestNotificationFacts({ job: scopedJob, result, db });
  assert.equal(applied.status, "PARTIAL");
  assert.equal(applied.rejected, 3);
  assert.equal(db.store.batches[0].receivedRows, 3);
  assert.equal(db.store.batches[0].rejectedRows, 3);
  assert.equal(db.store.coverage[0].lastErrorCode, "NOTIFICATION_ROWS_REJECTED");
});
