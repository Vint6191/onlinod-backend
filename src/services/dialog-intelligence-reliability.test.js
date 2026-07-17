"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { evaluateIncrementalStop } = require("./dialog-intelligence-domain");

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

test("three known messages do not stop before an unknown message in the same gap page", () => {
  const result = evaluateIncrementalStop({
    startingStreak: 0,
    threshold: 3,
    watermarkMessageId: "known-3",
    watermarkAt: "2026-07-15T10:00:00.000Z",
    pageNumber: 2,
    overlapPages: 2,
    observations: [
      { known: true, changed: false, messageId: "known-1", createdAtOf: "2026-07-15T10:03:00.000Z" },
      { known: true, changed: false, messageId: "known-2", createdAtOf: "2026-07-15T10:02:00.000Z" },
      { known: true, changed: false, messageId: "known-3", createdAtOf: "2026-07-15T10:01:00.000Z" },
      { known: false, changed: true, messageId: "gap-message", createdAtOf: "2026-07-15T09:59:00.000Z" },
    ],
  });
  assert.equal(result.watermarkReached, true);
  assert.equal(result.streak, 0);
  assert.equal(result.stop, false);
});

test("known threshold stops only after stable overlap crosses the confirmed watermark", () => {
  const result = evaluateIncrementalStop({
    startingStreak: 0,
    threshold: 3,
    watermarkMessageId: "watermark",
    watermarkAt: "2026-07-15T10:00:00.000Z",
    pageNumber: 2,
    overlapPages: 2,
    previousPageOldestAt: "2026-07-15T10:04:00.000Z",
    observations: [
      { known: true, changed: false, messageId: "known-1", createdAtOf: "2026-07-15T10:03:00.000Z" },
      { known: true, changed: false, messageId: "known-2", createdAtOf: "2026-07-15T10:02:00.000Z" },
      { known: true, changed: false, messageId: "watermark", createdAtOf: "2026-07-15T10:00:00.000Z" },
    ],
  });
  assert.equal(result.pageOrderStable, true);
  assert.equal(result.overlapSatisfied, true);
  assert.equal(result.watermarkReached, true);
  assert.equal(result.stop, true);
});

test("known streak on an earlier page cannot hide a later unknown message before the watermark", () => {
  const firstPage = evaluateIncrementalStop({
    startingStreak: 0,
    threshold: 3,
    watermarkMessageId: "confirmed-watermark",
    watermarkAt: "2026-07-15T10:00:00.000Z",
    pageNumber: 2,
    overlapPages: 2,
    observations: [
      { known: true, changed: false, messageId: "known-1", createdAtOf: "2026-07-15T10:05:00.000Z" },
      { known: true, changed: false, messageId: "known-2", createdAtOf: "2026-07-15T10:04:00.000Z" },
      { known: true, changed: false, messageId: "known-3", createdAtOf: "2026-07-15T10:03:00.000Z" },
    ],
  });
  assert.equal(firstPage.candidate, true);
  assert.equal(firstPage.watermarkReached, false);
  assert.equal(firstPage.stop, false);

  const gapPage = evaluateIncrementalStop({
    startingStreak: firstPage.streak,
    threshold: 3,
    watermarkMessageId: "confirmed-watermark",
    watermarkAt: "2026-07-15T10:00:00.000Z",
    pageNumber: 3,
    overlapPages: 2,
    previousPageOldestAt: firstPage.pageOldestAt,
    observations: [
      { known: false, changed: true, messageId: "gap-message", createdAtOf: "2026-07-15T10:02:00.000Z" },
      { known: true, changed: false, messageId: "confirmed-watermark", createdAtOf: "2026-07-15T10:00:00.000Z" },
    ],
  });
  assert.equal(gapPage.watermarkReached, true);
  assert.equal(gapPage.streak, 1);
  assert.equal(gapPage.stop, false);
});

test("out-of-order pages and equal timestamps cannot falsely prove a watermark crossing", () => {
  const result = evaluateIncrementalStop({
    startingStreak: 0,
    threshold: 3,
    watermarkAt: "2026-07-15T10:00:00.000Z",
    pageNumber: 3,
    overlapPages: 2,
    previousPageOldestAt: "2026-07-15T09:59:00.000Z",
    observations: [
      { known: true, changed: false, messageId: "same-1", createdAtOf: "2026-07-15T10:00:00.000Z" },
      { known: true, changed: false, messageId: "same-2", createdAtOf: "2026-07-15T10:00:00.000Z" },
      { known: true, changed: false, messageId: "same-3", createdAtOf: "2026-07-15T10:00:00.000Z" },
    ],
  });
  assert.equal(result.watermarkReached, false);
  assert.equal(result.pageOrderStable, false);
  assert.equal(result.stop, false);
});

function chunkDbFixture() {
  const targets = [{
    id: "target-1", agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1",
    messageId: "message-target", status: "PENDING", priority: 190, attempts: 1,
    requestedAt: new Date("2026-07-15T10:00:00.000Z"),
  }];
  const commits = new Map();
  const messages = new Map();
  const calls = { messageUpserts: 0, commitCreates: 0, targetResolves: 0, projections: 0 };
  const run = {
    id: "run-1", agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1",
    mode: "initial", status: "RUNNING", pagesProcessed: 4, messagesProcessed: 100,
    mediaProcessed: 0, continuation: { mode: "initial", cursor: "cursor-4", page: 4 },
  };
  const state = { creatorId: "creator-1", dialogId: "dialog-1", generation: 1 };
  const db = {
    dialogScanChunkCommit: {
      findUnique: async ({ where }) => commits.get(`${where.runId_chunkKey.runId}:${where.runId_chunkKey.chunkKey}`) || null,
      create: async ({ data }) => {
        calls.commitCreates += 1;
        const row = { id: `commit-${calls.commitCreates}`, ...data };
        commits.set(`${data.runId}:${data.chunkKey}`, row);
        return row;
      },
    },
    dialogScanRun: {
      findFirst: async () => run,
      update: async ({ data }) => {
        if (data.pagesProcessed?.increment) run.pagesProcessed += data.pagesProcessed.increment;
        if (data.messagesProcessed?.increment) run.messagesProcessed += data.messagesProcessed.increment;
        if (data.mediaProcessed?.increment) run.mediaProcessed = (run.mediaProcessed || 0) + data.mediaProcessed.increment;
        if (data.continuation) run.continuation = data.continuation;
        if (data.progress) run.progress = data.progress;
        if (data.status) run.status = data.status;
        return run;
      },
    },
    dialogMessageLedger: {
      findUnique: async ({ where }) => messages.get(where.creatorId_messageId.messageId) || null,
      upsert: async ({ where, create, update }) => {
        calls.messageUpserts += 1;
        const key = where.creatorId_messageId.messageId;
        const existing = messages.get(key);
        const row = existing ? { ...existing, ...update } : { id: `ledger-${key}`, ...create, media: [] };
        messages.set(key, row);
        return row;
      },
    },
    dialogMessageMedia: { upsert: async () => null },
    dialogPurchaseSignal: {
      updateMany: async () => ({ count: 0 }),
      findMany: async () => [],
    },
    dialogReconciliationTarget: {
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const target of targets) {
          if (target.creatorId === where.creatorId && target.dialogId === where.dialogId && target.messageId === where.messageId && target.status === where.status) {
            Object.assign(target, data);
            calls.targetResolves += 1;
            count += 1;
          }
        }
        return { count };
      },
      findFirst: async ({ where }) => targets.find((target) => target.status === where.status && target.messageId !== where.messageId?.not) || null,
      update: async ({ where, data }) => {
        const target = targets.find((entry) => entry.id === where.id);
        if (target && data.attempts?.increment) target.attempts += data.attempts.increment;
        return target;
      },
    },
    dialogScanState: {
      findUnique: async () => state,
      upsert: async ({ create, update }) => {
        if (!state.dialogId) Object.assign(state, create);
        if (update.pagesProcessed?.increment) state.pagesProcessed = (state.pagesProcessed || 0) + update.pagesProcessed.increment;
        if (update.messagesProcessed?.increment) state.messagesProcessed = (state.messagesProcessed || 0) + update.messagesProcessed.increment;
        if (update.mediaProcessed?.increment) state.mediaProcessed = (state.mediaProcessed || 0) + update.mediaProcessed.increment;
        for (const [key, value] of Object.entries(update)) {
          if (value !== undefined && !(value && typeof value === "object" && "increment" in value)) state[key] = value;
        }
        return state;
      },
    },
  };
  return { db, targets, commits, calls, run };
}

test("durable target survives restart, resolves after commit, and duplicate replay returns saved metadata", async () => {
  const prismaModule = require.resolve("../prisma");
  require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
  delete require.cache[require.resolve("./dialog-intelligence-service")];
  const { applyDialogIntelligenceChunk } = require("./dialog-intelligence-service");
  const fixture = chunkDbFixture();
  const resumeState = { mode: "initial", cursor: "cursor-4", page: 4, maxPages: 5000 };
  const job = {
    id: "job-1", agencyId: "agency-1", creatorId: "creator-1",
    params: { scanRunId: "run-1", dialogId: "dialog-1", mode: "initial", generation: 1 },
    continuation: {
      driverPhase: "execute",
      jobContinuation: { mode: "targeted", targetMessageId: "message-target", resumeState },
    },
  };
  const chunk = {
    kind: "dialog_message_page", runId: "run-1", dialogId: "dialog-1", mode: "targeted",
    chunkKey: "target-chunk-1", page: 0, cursorIn: null, cursorOut: null, hasMore: false,
    targetMessageId: "message-target",
    messages: [{
      messageId: "message-target", dialogId: "dialog-1", createdAtOf: "2026-07-15T10:00:00.000Z",
      direction: "OUTBOUND", priceCents: 2500, isOpened: true, isFree: false, contentHash: "hash-1", media: [],
    }],
    continuation: { mode: "targeted", targetMessageId: "message-target", resumeState },
    progress: { pages: 1 },
  };

  // The same fixture represents PostgreSQL after both backend and Desktop restart.
  const first = await applyDialogIntelligenceChunk({ db: fixture.db, job, deviceId: "device-b", chunkResult: chunk });
  assert.equal(fixture.targets[0].status, "RESOLVED");
  assert.deepEqual(first.jobContinuationOverride, resumeState);
  assert.deepEqual(first.messageIds, ["message-target"]);
  assert.deepEqual(first.changedMessageIds, ["message-target"]);
  assert.equal(fixture.calls.commitCreates, 1);

  const replay = await applyDialogIntelligenceChunk({ db: fixture.db, job, deviceId: "device-b", chunkResult: chunk });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.replayedCommit, true);
  assert.deepEqual(replay.messageIds, ["message-target"]);
  assert.deepEqual(replay.changedMessageIds, ["message-target"]);
  assert.deepEqual(replay.jobContinuationOverride, resumeState);
  assert.equal(fixture.calls.commitCreates, 1);
  assert.equal(fixture.calls.messageUpserts, 1);
  assert.equal(fixture.calls.targetResolves, 1);
});

test("a 50-message OF page increments durable run and dialog counters by 50", async () => {
  const prismaModule = require.resolve("../prisma");
  require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
  delete require.cache[require.resolve("./dialog-intelligence-service")];
  const { applyDialogIntelligenceChunk } = require("./dialog-intelligence-service");
  const fixture = chunkDbFixture();
  fixture.run.pagesProcessed = 0;
  fixture.run.messagesProcessed = 0;
  fixture.db.dialogScanState.findUnique = async () => ({
    creatorId: "creator-1", dialogId: "dialog-1", generation: 1,
    pagesProcessed: 0, messagesProcessed: 0, mediaProcessed: 0,
  });
  const messages = Array.from({ length: 50 }, (_, index) => ({
    messageId: `message-${index + 1}`,
    dialogId: "dialog-1",
    createdAtOf: new Date(Date.UTC(2026, 6, 15, 10, 0, 50 - index)).toISOString(),
    direction: index % 2 ? "INBOUND" : "OUTBOUND",
    priceCents: 0,
    isOpened: false,
    isFree: true,
    contentHash: `hash-${index + 1}`,
    media: [],
  }));
  const job = {
    id: "job-50", agencyId: "agency-1", creatorId: "creator-1",
    params: { scanRunId: "run-1", dialogId: "dialog-1", mode: "initial", generation: 1 },
    continuation: { driverPhase: "execute", jobContinuation: { mode: "initial", cursor: null, page: 0 } },
  };
  const result = await applyDialogIntelligenceChunk({
    db: fixture.db,
    job,
    deviceId: "device-a",
    chunkResult: {
      kind: "dialog_message_page", runId: "run-1", dialogId: "dialog-1", mode: "initial",
      chunkKey: "page-50", page: 1, cursorIn: null, cursorOut: "message-50", hasMore: true,
      messages,
      continuation: { mode: "initial", cursor: "message-50", page: 1 },
      progress: { pages: 1, rawMessages: 50, messages: 50, skippedMessages: 0 },
    },
  });
  assert.equal(result.messageCount, 50);
  assert.equal(fixture.calls.messageUpserts, 50);
  assert.equal(fixture.run.pagesProcessed, 1);
  assert.equal(fixture.run.messagesProcessed, 50);
});

test("stale worker cannot complete or mutate a reclaimed dialog run", async () => {
  const { completeDialogJobFenced } = require("./dialog-job-completion-fence");
  const current = {
    id: "job-1",
    status: "CLAIMED",
    claimedByDeviceId: "device-b",
    leaseTokenHash: hashToken("token-b"),
    leaseRevision: 2,
  };
  let runCompletions = 0;
  const tx = {
    jobInstance: {
      updateMany: async ({ where, data }) => {
        const matches = current.id === where.id
          && current.status === where.status
          && current.claimedByDeviceId === where.claimedByDeviceId
          && current.leaseTokenHash === where.leaseTokenHash
          && current.leaseRevision === where.leaseRevision;
        if (matches) Object.assign(current, data);
        return { count: matches ? 1 : 0 };
      },
    },
  };
  const completionData = { status: "DONE", continuation: null };

  await assert.rejects(
    completeDialogJobFenced({
      tx,
      fenceWhere: {
        id: "job-1", status: "CLAIMED", claimedByDeviceId: "device-a",
        leaseTokenHash: hashToken("token-a"), leaseRevision: 1,
      },
      completionData,
      staleError: () => Object.assign(new Error("stale"), { code: "JOB_LEASE_STALE" }),
      applySideEffect: async () => { runCompletions += 1; },
    }),
    (error) => error.code === "JOB_LEASE_STALE",
  );
  assert.equal(runCompletions, 0);
  assert.equal(current.status, "CLAIMED");
  assert.equal(current.leaseRevision, 2);

  const completed = await completeDialogJobFenced({
    tx,
    fenceWhere: {
      id: "job-1", status: "CLAIMED", claimedByDeviceId: "device-b",
      leaseTokenHash: hashToken("token-b"), leaseRevision: 2,
    },
    completionData,
    applySideEffect: async () => { runCompletions += 1; return { runId: "run-1" }; },
  });
  assert.equal(completed.sideEffect.runId, "run-1");
  assert.equal(current.status, "DONE");
  assert.equal(runCompletions, 1);
});

