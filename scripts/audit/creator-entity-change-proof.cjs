"use strict";
const assert = require("node:assert/strict"), path = require("node:path");
const root = path.resolve(__dirname, "../..");
const { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs");
const { runRootCommit, discardCommitHints } = require(root + "/src/services/db-commit-kernel");
const feed = require(root + "/src/services/creator-entity-change-service");
const pass = label => console.log("PASS", label);

(async () => {
  const f = await createScaleSqlRuntime();
  try {
    const { db } = f, s = await scope(db), now = new Date();
    const commit = work => runRootCommit(db, ({ tx }) => work(tx));
    const read = args => runRootCommit(db, ({ tx }) => feed.readEntityChanges({ db: tx, ...s, ...args }), { isolationLevel: "RepeatableRead" });
    const snapshot = args => runRootCommit(db, ({ tx }) => feed.readCurrentEntities({ db: tx, ...s, ...args }), { isolationLevel: "RepeatableRead" });
    const change = (id, version = "1") => ({ entityType: "FAN", entityId: id, sourceIdentity: `fan:${id}`, sourceVersion: version,
      payload: { dataVersion: version, fanOnlyFansUserId: id } });
    require.cache[require.resolve(root + "/src/prisma")] = { exports: db };
    assert.equal((await read()).headRevision, "0");
    await assert.rejects(() => feed.publishEntityChanges({ db, ...s, changes: [change("unsafe-root")] }), { code: "ENTITY_CHANGE_OWNER_TRANSACTION_REQUIRED" });
    pass("publisher requires the existing owner transaction; empty creator feed starts at zero");

    const sale = { id: "late-sale", ...s, userId: undefined, eventFingerprint: "a".repeat(64), externalTransactionId: "operation-one",
      fanOnlyFansUserIdAtEvent: "42", saleType: "OTHER", amountCents: 1900, purchasedAt: now };
    await commit(async tx => {
      await require(root + "/src/services/creator-fact-write-authority").lockCreatorFacts(tx, s.agencyId, s.creatorId);
      await tx.creatorSale.create({ data: sale });
      await feed.publishCanonicalSales({ db: tx, ...s, saleIds: [sale.id] });
    });
    assert(!(await read()).changes.some(row => row.entityType === "MESSAGE_PURCHASE"));
    const beforeLink = (await read()).headRevision;
    await commit(async tx => {
      await require(root + "/src/services/creator-fact-write-authority").lockCreatorFacts(tx, s.agencyId, s.creatorId);
      await tx.creatorSale.update({ where: { id: sale.id }, data: { messageId: "77", saleType: "MESSAGE" } });
      await feed.publishCanonicalSales({ db: tx, ...s, saleIds: [sale.id] });
      const [head] = await tx.$queryRawUnsafe('SELECT "lastRevision" FROM "CreatorEntityChangeHead" WHERE "creatorId"=$1', s.creatorId);
      assert.equal(String(head.lastRevision), beforeLink, "head allocation must wait until owner work ends");
    });
    const linked = await read({ afterRevision: beforeLink });
    const purchase = linked.changes.find(row => row.entityType === "MESSAGE_PURCHASE");
    assert.deepEqual(purchase.payload, { dialogId: "42", messageId: "77", opened: true,
      operationId: "operation-one", purchasedAt: now.toISOString() });
    await commit(tx => feed.publishCanonicalSales({ db: tx, ...s, saleIds: [sale.id] }));
    assert.equal((await read()).headRevision, linked.headRevision);
    pass("late exact canonical message link becomes durable Desktop correction once, without any control hint");

    const siblingScope = { agencyId: s.agencyId, creatorId: s.creatorId, fanOnlyFansUserIdAtEvent: "shared-feed-fan" };
    const siblings = ["first", "last"].map((suffix, i) => ({ ...siblingScope, id: `sibling-sale-${suffix}`,
      eventFingerprint: require("node:crypto").createHash("sha256").update(`sibling-sale-${suffix}`).digest("hex"),
      saleType: "MESSAGE", messageId: `sibling-message-${suffix}`, amountCents: 600 + i, purchasedAt: now }));
    const siblingTip = { ...siblingScope, id: "sibling-tip", eventFingerprint: "b".repeat(64), amountCents: 300, tippedAt: now };
    const publishFirst = tx => feed.publishCanonicalSales({ db: tx, ...s, saleIds: [siblings[0].id] });
    const publishLast = tx => feed.publishCanonicalSales({ db: tx, ...s, saleIds: [siblings[1].id] });
    const publishTip = tx => feed.publishCanonicalFactInvalidations({ db: tx, ...s, model: "creatorTip", ids: [siblingTip.id] });
    await commit(async tx => {
      await require(root + "/src/services/creator-fact-write-authority").lockCreatorFacts(tx, s.agencyId, s.creatorId);
      await tx.creatorSale.createMany({ data: siblings }); await tx.creatorTip.create({ data: siblingTip });
      await publishFirst(tx); await publishTip(tx);
    });
    const beforeMixed = (await read()).headRevision;
    await commit(async tx => {
      await require(root + "/src/services/creator-fact-write-authority").lockCreatorFacts(tx, s.agencyId, s.creatorId);
      await tx.creatorSale.update({ where: { id: siblings[0].id }, data: { amountCents: 700 } });
      await publishFirst(tx); await publishTip(tx);
    });
    const mixed = await read({ afterRevision: beforeMixed });
    for (const type of ["HOME", "CRM", "FAN"]) assert(mixed.changes.some(row => row.entityType === type), `changed sale must survive unchanged last tip for ${type}`);
    assert(!mixed.changes.some(row => row.entityType === "MESSAGE_PURCHASE"), "shared invalidation aggregation must not manufacture a message correction");
    const mixedCrm = mixed.changes.find(row => row.entityType === "CRM");
    assert.equal(mixedCrm.payload.dialogId, siblingScope.fanOnlyFansUserIdAtEvent);
    assert.deepEqual(Object.keys(mixedCrm.payload).sort(), ["dataVersion", "dialogId", "fanOnlyFansUserId", "reason"]);
    await commit(async tx => { await publishFirst(tx); await publishTip(tx); });
    await commit(async tx => { await publishTip(tx); await publishFirst(tx); await publishFirst(tx); });
    assert.equal((await read()).headRevision, mixed.headRevision, "same contributor set in any order is a no-op replay");
    pass("changed sale plus unchanged final tip preserves shared Home/CRM/Fan invalidations, scoped payload and order-independent replay dedupe");

    await commit(async tx => { await publishFirst(tx); await publishLast(tx); });
    const beforeSameOwner = (await read()).headRevision;
    await commit(async tx => {
      await require(root + "/src/services/creator-fact-write-authority").lockCreatorFacts(tx, s.agencyId, s.creatorId);
      await tx.creatorSale.update({ where: { id: siblings[0].id }, data: { amountCents: 800 } });
      await publishFirst(tx); await publishLast(tx);
    });
    const sameOwner = await read({ afterRevision: beforeSameOwner });
    for (const type of ["HOME", "CRM", "FAN"]) assert(sameOwner.changes.some(row => row.entityType === type), `changed first same-helper invocation must survive for ${type}`);
    await commit(async tx => { await publishLast(tx); await publishFirst(tx); await publishLast(tx); });
    assert.equal((await read()).headRevision, sameOwner.headRevision);
    pass("independent per-event contributions from the same helper survive unchanged last siblings and replay without echo");

    await assert.rejects(() => commit(async tx => {
      await tx.creatorSale.update({ where: { id: sale.id }, data: { amountCents: 1999 } });
      for (let batch = 0; batch < 4; batch += 1) await feed.publishEntityChanges({ db: tx, ...s,
        changes: Array.from({ length: 10000 }, (_, i) => ({ entityType: "HOME", entityId: "capacity-check",
          sourceIdentity: `owner-${batch * 10000 + i}`, sourceVersion: "opaque", payload: { dataVersion: "known" } })) });
      await feed.publishEntityChanges({ db: tx, ...s, changes: [{ entityType: "HOME", entityId: "capacity-check", sourceIdentity: "one-too-many", sourceVersion: "opaque", payload: { dataVersion: "changed" } }] });
    }), { code: "ENTITY_CHANGE_CAPACITY" });
    assert.equal((await db.creatorSale.findUnique({ where: { id: sale.id } })).amountCents, 1900);
    assert.equal((await read()).headRevision, sameOwner.headRevision);
    pass("contributor capacity fails explicitly and rolls back canonical facts instead of dropping an invalidation");

    await assert.rejects(() => commit(async tx => {
      await tx.creatorSale.update({ where: { id: sale.id }, data: { amountCents: 2000 } });
      await feed.publishCanonicalSales({ db: tx, ...s, saleIds: [sale.id] });
      throw Error("OWNER_ROLLBACK");
    }), /OWNER_ROLLBACK/);
    assert.equal((await db.creatorSale.findUnique({ where: { id: sale.id } })).amountCents, 1900);
    assert.equal((await read()).headRevision, sameOwner.headRevision);
    await runRootCommit(db, async context => {
      await feed.publishEntityChanges({ db: context.tx, ...s, changes: [change("rolled-back-savepoint")] });
      discardCommitHints(context);
      await feed.publishEntityChanges({ db: context.tx, ...s, changes: [change("accepted-receipt")] });
    });
    assert(!(await snapshot()).entities.some(row => row.entityId === "rolled-back-savepoint"));
    await assert.rejects(() => commit(async tx => {
      await tx.creatorSale.update({ where: { id: sale.id }, data: { amountCents: 2100 } });
      await feed.publishEntityChanges({ db: tx, ...s, changes: [{ ...change("accepted-receipt"), payload: { dataVersion: "contradiction" } }] });
    }), { code: "ENTITY_CHANGE_SOURCE_VERSION_CONFLICT" });
    assert.equal((await db.creatorSale.findUnique({ where: { id: sale.id } })).amountCents, 1900);
    pass("owner errors, rejected savepoints and preparation failures roll back facts and feed together");

    await commit(tx => feed.publishEntityChanges({ db: tx, ...s, changes: [change("numeric", "8"), change("numeric", "10"), change("numeric", "9")] }));
    assert.equal((await snapshot()).entities.find(row => row.entityId === "numeric").payload.dataVersion, "10");
    const numericHead = (await read()).headRevision;
    await commit(tx => feed.publishEntityChanges({ db: tx, ...s, changes: [change("numeric", "9")] }));
    assert.equal((await read()).headRevision, numericHead);
    await commit(tx => feed.publishEntityChanges({ db: tx, ...s,
      changes: Array.from({ length: 205 }, (_, i) => change(`bulk-${String(i).padStart(3, "0")}`)) }));
    const first = await read();
    assert.equal(first.changes.length, 200); assert(first.hasMore);
    const second = await read({ afterRevision: first.nextRevision });
    assert(second.changes.length && !second.hasMore);
    assert.equal(new Set([...first.changes, ...second.changes].map(row => row.revision)).size, Number(second.headRevision));
    pass("numeric stale source versions cannot revert state; history pages are bounded and contiguous");

    const initial = await snapshot({ limit: 200 }), barrier = initial.snapshotBarrier;
    const applied = new Map(initial.entities.map(row => [`${row.entityType}:${row.entityId}`, row]));
    await commit(tx => feed.publishEntityChanges({ db: tx, ...s, changes: [change("000-inserted-before-keyset"), change("bulk-001", "2")] }));
    let page = initial;
    while (page.hasMore) {
      page = await snapshot({ snapshotBarrier: barrier, afterType: page.nextCursor.entityType, afterId: page.nextCursor.entityId });
      for (const row of page.entities) applied.set(`${row.entityType}:${row.entityId}`, row);
    }
    let catchup = await read({ afterRevision: barrier });
    for (;;) {
      for (const row of catchup.changes) {
        const key = `${row.entityType}:${row.entityId}`, old = applied.get(key);
        if (!old || BigInt(row.revision) > BigInt(old.revision)) applied.set(key, row);
      }
      if (!catchup.hasMore) break;
      catchup = await read({ afterRevision: catchup.nextRevision });
    }
    assert.equal(applied.get("FAN:bulk-001").payload.dataVersion, "2");
    assert(applied.has("FAN:000-inserted-before-keyset"));
    pass("snapshot start barrier plus monotonic replay catches concurrent inserts before the keyset and corrections");

    const currentCount = await db.$queryRawUnsafe('SELECT count(*) AS n FROM "CreatorEntityCurrent" WHERE "creatorId"=$1', s.creatorId);
    await db.$executeRawUnsafe('UPDATE "CreatorEntityChange" SET "createdAt"=clock_timestamp()-interval \'31 days\' WHERE "creatorId"=$1', s.creatorId);
    await db.$executeRawUnsafe('UPDATE "CreatorEntityChangeHead" SET "nextRetentionAt"=clock_timestamp()-interval \'1 day\' WHERE "creatorId"=$1', s.creatorId);
    assert.equal(await commit(tx => feed.retainPage(tx, { limit: 3 })), 3);
    await assert.rejects(() => read(), { code: "RECONCILE_REQUIRED", retainedFrom: "4" });
    assert.equal((await db.$queryRawUnsafe('SELECT count(*) AS n FROM "CreatorEntityCurrent" WHERE "creatorId"=$1', s.creatorId))[0].n, currentCount[0].n);
    let deleted;
    do { deleted = await commit(tx => feed.retainPage(tx)); } while (deleted);
    const fresh = await snapshot();
    assert.equal(fresh.entities.length, 200); assert(fresh.hasMore);
    assert.equal((await read({ afterRevision: fresh.snapshotBarrier })).changes.length, 0);
    await assert.rejects(() => snapshot({ snapshotBarrier: "0" }), { code: "RECONCILE_REQUIRED" });
    await assert.rejects(() => read({ afterRevision: "9007199254740993" }), { code: "RECONCILE_REQUIRED" });
    pass("retention is bounded, preserves current entities and explicitly requires paged reconciliation for expired cursors");

    await commit(async tx => {
      await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)`);
      await tx.creatorAccount.createMany({ data: ["retention-hot", "retention-quiet"].map(id => ({ id, agencyId: s.agencyId, displayName: id, remoteId: id, status: "READY" })) });
      for (const creatorId of ["retention-hot", "retention-quiet"]) await feed.publishEntityChanges({ db: tx, agencyId: s.agencyId, creatorId,
        changes: Array.from({ length: creatorId === "retention-hot" ? 600 : 1 }, (_, i) => change(`fair-${i}`)) });
    });
    await db.$executeRawUnsafe(`UPDATE "CreatorEntityChange" SET "createdAt"=clock_timestamp()-interval '31 days' WHERE "creatorId" IN ('retention-hot','retention-quiet')`);
    await db.$executeRawUnsafe(`UPDATE "CreatorEntityChangeHead" SET "nextRetentionAt"=clock_timestamp()-interval '1 day' WHERE "creatorId" IN ('retention-hot','retention-quiet')`);
    assert.equal(await commit(tx => feed.retainPage(tx)), 500);
    assert.equal(await commit(tx => feed.retainPage(tx)), 1);
    assert.equal(await db.creatorEntityChange.count({ where: { creatorId: "retention-hot" } }), 100);
    assert.equal(await db.creatorEntityChange.count({ where: { creatorId: "retention-quiet" } }), 0);
    assert.equal(await commit(tx => feed.retainPage(tx)), 100);
    const [emptyHead] = await db.$queryRawUnsafe(`SELECT "nextRetentionAt" FROM "CreatorEntityChangeHead" WHERE "creatorId"='retention-hot'`);
    assert.equal(emptyHead.nextRetentionAt, null);
    pass("retention schedules only due creators and gives a quiet creator a turn before a hot backlog can monopolize the next page");

    const viewer = require(root + "/src/services/creator-entity-viewer-service");
    const member = await db.agencyMember.findUnique({ where: { id: `member-${s.agencyId}` } });
    const authorized = await viewer.readWithEntityViewer({ db, ...s, member }, ({ db: tx }) => feed.readCurrentEntities({ db: tx, ...s }));
    assert(authorized.entities.length);
    await assert.rejects(() => viewer.readWithEntityViewer({ db, ...s, member: { ...member, accessEpoch: member.accessEpoch + 1 } }, () => { throw Error("MUST_NOT_READ"); }), { code: "ENTITY_CHANGE_ACCESS_CHANGED" });
    await assert.rejects(() => viewer.readWithEntityViewer({ db, ...s, agencyId: "other-agency", member }, () => { throw Error("MUST_NOT_READ"); }), { code: "ENTITY_CHANGE_ACCESS_CHANGED" });
    await assert.rejects(() => commit(tx => feed.publishEntityChanges({ db: tx, ...s, agencyId: "other-agency", changes: [change("cross-agency")] })), { code: "ENTITY_CHANGE_SCOPE_MISMATCH" });
    pass("feed and snapshot reads require current creator membership; cross-agency publication fails closed");

    await db.workerDevice.create({ data: { id: "feed-live-device", agencyId: s.agencyId, userId: s.userId, lastSeenAt: now } });
    const processor = require(root + "/src/services/data-change-processor-service");
    const input = { batchId: "feed-live-batch-one", observedAt: now.toISOString(), sourceTimezone: "UTC",
      events: [{ eventType: "purchase", notificationId: "feed-live-notification", fanId: "55", messageId: "88", amountCents: 900,
        currency: "USD", purchasedAt: now.toISOString() }],
      delivery: { version: 1, sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", entries: [{ seq: 1, capturedAt: now.toISOString() }] } };
    const process = (tx, batch = input) => processor.processLiveNotificationBatch({ db: tx, creator: { id: s.creatorId, agencyId: s.agencyId },
      member, device: { id: "feed-live-device" }, input: batch });
    const acked = await commit(tx => process(tx));
    assert.equal(acked.deliveryAck.throughSeq, 1);
    const persisted = await db.creatorSale.findUnique({ where: { creatorId_externalNotificationId: { creatorId: s.creatorId, externalNotificationId: "feed-live-notification" } } });
    assert(persisted && persisted.messageId === "88");
    const processed = await read({ afterRevision: fresh.snapshotBarrier });
    assert(processed.changes.some(row => row.entityType === "MESSAGE_PURCHASE" && row.entityId === "55:88"));
    const repeated = await commit(tx => process(tx));
    assert.equal(repeated.deliveryAck.throughSeq, 1);
    assert.equal((await read({ afterRevision: processed.headRevision })).changes.length, 0);
    const uncommitted = { ...input, batchId: "feed-live-batch-two", events: [{ ...input.events[0], notificationId: "feed-live-rollback", messageId: "89" }],
      delivery: { ...input.delivery, entries: [{ seq: 2, capturedAt: now.toISOString() }] } };
    await assert.rejects(() => commit(async tx => { await process(tx, uncommitted); throw Error("AFTER_ACK_BEFORE_COMMIT"); }), /AFTER_ACK_BEFORE_COMMIT/);
    assert.equal(await db.creatorSale.count({ where: { creatorId: s.creatorId, externalNotificationId: "feed-live-rollback" } }), 0);
    assert.equal((await db.creatorRealtimeSession.findFirst({ where: { creatorId: s.creatorId, incarnation: input.delivery.sessionId } })).ackedSeq, 1n);
    assert.equal((await read({ afterRevision: processed.headRevision })).changes.length, 0);
    pass("extracted live processor commits original facts, reverse correction and delivery ACK atomically; lost response replay and precommit crash preserve semantics");

    const tipInput = { ...input, batchId: "feed-live-tip", events: [{ eventType: "tip", notificationId: "feed-tip-1", fanId: "55", amountCents: 300,
      currency: "USD", occurredAt: now.toISOString() }], delivery: { ...input.delivery, entries: [{ seq: 2, capturedAt: now.toISOString() }] } };
    assert.equal((await commit(tx => process(tx, tipInput))).deliveryAck.throughSeq, 2);
    const tipFeed = await read({ afterRevision: processed.headRevision });
    for (const type of ["HOME", "TEAM", "CRM", "FAN"]) assert(tipFeed.changes.some(row => row.entityType === type));
    assert(!tipFeed.changes.some(row => row.entityType === "MESSAGE_PURCHASE"));
    await commit(tx => process(tx, tipInput));
    assert.equal((await read({ afterRevision: tipFeed.headRevision })).changes.length, 0);
    pass("live tip commits typed Home/Team/CRM/Fan invalidations with its ACK, without synthetic message purchase or replay echo");

    const fullPage = Array.from({ length: 2000 }, (_, i) => ({ id: `full-page-sale-${i}`, agencyId: s.agencyId, creatorId: s.creatorId,
      eventFingerprint: require("node:crypto").createHash("sha256").update(`full-page-sale-${i}`).digest("hex"),
      fanOnlyFansUserIdAtEvent: `full-page-fan-${i}`, saleType: "MESSAGE", messageId: String(i), amountCents: 100, purchasedAt: now }));
    await commit(async tx => {
      await require(root + "/src/services/creator-fact-write-authority").lockCreatorFacts(tx, s.agencyId, s.creatorId);
      await tx.creatorSale.createMany({ data: fullPage });
      await feed.publishCanonicalSales({ db: tx, ...s, saleIds: fullPage.map(row => row.id) });
    });
    const fullFeed = await read({ afterRevision: tipFeed.headRevision });
    assert.equal(BigInt(fullFeed.headRevision) - BigInt(tipFeed.headRevision), 8005n);
    assert.equal(fullFeed.changes.length, 200); assert(fullFeed.hasMore);
    pass("the existing 2000-fact owner page fits the bounded staged feed and still yields bounded Desktop pages");

    if (f.native) {
      const before = (await read({ afterRevision: fresh.snapshotBarrier })).headRevision;
      let unblock, staged;
      const waiting = new Promise(resolve => { unblock = resolve; });
      const entered = new Promise(resolve => { staged = resolve; });
      const slow = commit(async tx => { await feed.publishEntityChanges({ db: tx, ...s, changes: [change("slow-owner")] }); staged(); await waiting; });
      await entered;
      await commit(tx => feed.publishEntityChanges({ db: tx, ...s, changes: [change("fast-owner")] }));
      const fast = await read({ afterRevision: before });
      unblock(); await slow;
      const late = await read({ afterRevision: fast.nextRevision });
      assert(late.changes.some(row => row.entityId === "slow-owner"));
      pass("native concurrent owner finishing later receives a later committed revision and cannot be skipped");
    } else console.log("LIMIT", "native concurrent PostgreSQL commit race requires ONLINOD_NATIVE_TEST_DATABASE_URL; PGlite validates SQL/rollback/keyset semantics");
    console.log("CREATOR ENTITY CHANGE PROOF PASSED");
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
