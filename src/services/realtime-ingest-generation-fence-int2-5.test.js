"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withRealtimeIngestGenerationFence } = require("./realtime-ingest-generation-fence-service");

function fakeDb({ liveEpoch = 7 } = {}) {
  const sequence = [];
  const member = {
    id: "member-1",
    userId: "user-1",
    agencyId: "agency-1",
    role: "CHATTER",
    roleKey: "chatter",
    permissions: {},
    assignedCreators: ["creator-1"],
    accessEpoch: liveEpoch,
    deletedAt: null,
    deactivatedAt: null,
  };
  const tx = {
    async $queryRawUnsafe(sql, ...args) {
      sequence.push("member-share-lock");
      assert.match(sql, /FROM "AgencyMember"[\s\S]*FOR SHARE/);
      assert.deepEqual(args, ["member-1", "user-1", "agency-1"]);
      return [member];
    },
    creatorAccount: {
      async findFirst() {
        sequence.push("creator-read");
        return { id: "creator-1", status: "READY" };
      },
    },
  };
  const db = {
    async $transaction(work) {
      sequence.push("begin");
      try {
        const value = await work(tx);
        sequence.push("commit");
        return value;
      } catch (error) {
        sequence.push("rollback");
        throw error;
      }
    },
  };
  return { db, tx, sequence };
}

const input = {
  agencyId: "agency-1",
  userId: "user-1",
  memberId: "member-1",
  accessEpoch: 7,
  creatorId: "creator-1",
};

test("INT2.5 generation fence holds current member generation across realtime ingest work", async () => {
  const { db, tx, sequence } = fakeDb({ liveEpoch: 7 });
  const value = await withRealtimeIngestGenerationFence({
    ...input,
    db,
    work: async ({ tx: supplied, accessEpoch }) => {
      assert.equal(supplied, tx);
      assert.equal(accessEpoch, 7);
      sequence.push("durable-work");
      return "committed";
    },
  });
  assert.equal(value, "committed");
  assert.deepEqual(sequence, ["begin", "member-share-lock", "creator-read", "durable-work", "commit"]);
});

test("INT2.5 stale accessEpoch fails before downstream realtime mutation", async () => {
  const { db, sequence } = fakeDb({ liveEpoch: 8 });
  let workRuns = 0;
  await assert.rejects(
    withRealtimeIngestGenerationFence({
      ...input,
      db,
      work: async () => { workRuns += 1; },
    }),
    (error) => error?.code === "EXECUTION_ACCESS_EPOCH_STALE" && error?.status === 409,
  );
  assert.equal(workRuns, 0);
  assert.deepEqual(sequence, ["begin", "member-share-lock", "rollback"]);
});

test("INT2.5 helper composes the existing execution authority instead of becoming a new authority", () => {
  const source = fs.readFileSync(path.join(__dirname, "realtime-ingest-generation-fence-service.js"), "utf8");
  assert.match(source, /assertExecutionAccessFence\(\{/);
  assert.match(source, /lock:\s*true/);
  assert.match(source, /runDbTransaction/);
  assert.doesNotMatch(source, /agencyMember\.(?:findFirst|findUnique|update|updateMany)/);
});

test("INT2.5 routes fence each durable realtime commit without replacing business transaction ownership", () => {
  const automation = fs.readFileSync(path.join(__dirname, "../routes/automation-control.js"), "utf8");
  const automationStart = automation.indexOf("async function handleBumpRuntimeEvents(req, res)");
  const automationEnd = automation.indexOf('router.post("/bumps/:creatorId/events"', automationStart);
  const automationBlock = automation.slice(automationStart, automationEnd);
  assert.match(automationBlock, /input\.accessEpoch !== memberAccessEpoch/);
  assert.match(automationBlock, /const commitFence = \(work\) => withRealtimeIngestGenerationFence\(\{/);
  assert.match(automationBlock, /accessEpoch: input\.accessEpoch/);
  assert.match(automationBlock, /await assertRealtimeBinding\(tx\)[\s\S]*return work\(tx\)/);
  assert.match(automationBlock, /processRuntimeEvents\(\{[\s\S]*commitFence/);

  const bump = fs.readFileSync(path.join(__dirname, "bump-service.js"), "utf8");
  const runtimeStart = bump.indexOf("async function processRuntimeEvents");
  const runtimeEnd = bump.indexOf("\nasync function planConfiguredBumpSources", runtimeStart);
  const runtime = bump.slice(runtimeStart, runtimeEnd);
  assert.match(runtime, /const runCommit = typeof commitFence === "function"/);
  assert.match(runtime, /recordOnlineObservations\([\s\S]*db: commitDb/);
  assert.match(runtime, /markBumpReply\([\s\S]*db: commitDb/);
  assert.match(runtime, /recordDetailedObservations\([\s\S]*db: commitDb/);

  const stats = fs.readFileSync(path.join(__dirname, "../routes/stats.js"), "utf8");
  const statsStart = stats.indexOf('router.post("/creators/:creatorId/notifications/live"');
  const statsBlock = stats.slice(statsStart);
  assert.match(statsBlock, /const commitGuard = async \(tx\)/);
  assert.match(statsBlock, /assertRealtimeIngestGenerationCurrent\(\{[\s\S]*db: tx/);
  assert.match(statsBlock, /ingestNotificationFacts\(\{[\s\S]*db: prisma,[\s\S]*commitGuard/);
  assert.match(statsBlock, /withRealtimeIngestGenerationFence\(\{[\s\S]*recordNotificationSocketEvent\(\{[\s\S]*db: tx/);

  const notifications = fs.readFileSync(path.join(__dirname, "notification-facts-service.js"), "utf8");
  const ingestStart = notifications.indexOf("async function ingestNotificationFacts");
  const ingest = notifications.slice(ingestStart, notifications.indexOf("\nmodule.exports", ingestStart));
  const guardAt = ingest.indexOf('if (typeof commitGuard === "function") await commitGuard(tx)');
  const ingestLockAt = ingest.indexOf("acquireIngestTransactionLock", guardAt);
  const persistenceAt = ingest.indexOf("persistFactGroup", guardAt);
  assert.ok(guardAt >= 0 && ingestLockAt > guardAt && persistenceAt > guardAt);
});
